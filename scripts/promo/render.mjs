// 宣传片逐帧渲染器（无头 Chromium via playwright-core + 系统 Edge）。
//
//   node scripts/promo/render.mjs            # 全量（~31s 成片 @30fps）
//   PROMO_MAX_FRAMES=90 node scripts/promo/render.mjs   # 试渲染
//
// 流程：programmatic 起 webui vite → Edge headless 开 promo.html(1920×1080)
// → 等 __PROMO_READY → CDP Emulation.setVirtualTimePolicy=pause 冻结时钟
// → 置 __START → 每帧 advance(budget=33.3ms×rate) 后 Page.captureScreenshot 出 PNG。
// 虚拟时间推进 CSS/WAAPI/setTimeout 全部确定性——每帧可复现，无录屏抖动掉帧。
// （Electron 版在本机会话里 whenReady 挂死，实测于 2026-11-12 弃用；见 git 历史。）
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webuiDir = join(root, "webui");
const promoDir = join(root, ".tmp", "promo");
const outDir = join(promoDir, "frames");
mkdirSync(outDir, { recursive: true });
const logPath = join(promoDir, "render.log");
writeFileSync(logPath, "");
const log = (m) => { console.log(m); appendFileSync(logPath, `[${new Date().toISOString()}] ${m}\n`); };
process.on("unhandledRejection", (e) => log(`[promo] UNHANDLED: ${(e && e.stack) || e}`));

const scenes = JSON.parse(readFileSync(join(webuiDir, "src", "promo", "scenes.json"), "utf8"));
const PORT = Number(process.env.PROMO_PORT ?? 5199);
const maxFrames = Number(process.env.PROMO_MAX_FRAMES ?? 0);
const frameBaseUs = Math.round(1_000_000 / (scenes.fps ?? 30));

const EDGE_X86 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EDGE = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
const edgePath = existsSync(EDGE_X86) ? EDGE_X86 : existsSync(EDGE) ? EDGE : null;

// unplugin-icons 从 process.cwd 解析 @iconify-json/* 集合（pnpm 严格布局），
// 与 `pnpm --dir webui dev` 对齐：把 cwd 切进 webui 再起 vite。
process.chdir(webuiDir);

const vite = await import(pathToFileURL(join(webuiDir, "node_modules", "vite", "dist", "node", "index.js")).href);
const server = await vite.createServer({
  root: webuiDir,
  configFile: join(webuiDir, "vite.config.ts"),
  logLevel: "warn",
  server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false },
});
await server.listen();
log(`[promo] vite on http://127.0.0.1:${PORT}`);

// 浏览器：playwright 自带 chromium headless shell（`playwright install chromium --only-shell` 下载，
// PLAYWRIGHT_BROWSERS_PATH=0 落在 node_modules 内）。**不要用系统 msedge**：实测它会附着到
// 用户已运行的浏览器进程，screenshot 截到用户桌面的产品窗口（2026-11-12 实锤）。
const browser = await chromium.launch({
  headless: true,
  args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars", "--disable-lcd-text", "--no-first-run", "--no-default-browser-check"],
});
const page = await browser.newPage({ viewport: { width: scenes.width, height: scenes.height }, deviceScaleFactor: 1 });
page.on("console", (msg) => { if (msg.type() === "error") log(`[page.error] ${msg.text().slice(0, 300)}`); });
page.on("pageerror", (e) => log(`[page.pageerror] ${String(e).slice(0, 300)}`));
page.on("response", (res) => { if (res.status() >= 400) log(`[page.http ${res.status()}] ${res.url()}`); });

await page.goto(`http://127.0.0.1:${PORT}/promo.html?capture=1`, { waitUntil: "load" });
try {
  await page.waitForFunction("window.__PROMO_READY === true", null, { timeout: 60_000 });
} catch {
  log("[promo] first ready timeout, reloading…");
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction("window.__PROMO_READY === true", null, { timeout: 120_000 });
}
log("[promo] page ready (capture mode), seeking frame by frame…");
const selfCheck = await page.evaluate(() => ({
  url: location.href,
  hasSeek: typeof window.__PROMO_SEEK === "function",
}));
log(`[promo] selfcheck: ${JSON.stringify(selfCheck)}`);
const allPages = browser.contexts()[0].pages();
log(`[promo] pages: ${JSON.stringify(allPages.map((p) => p.url()))}`);
if (!selfCheck.hasSeek) { log("[promo] FAIL: 页面不在 capture 分支"); await browser.close(); await server.close(); process.exit(4); }

// seek 模式：不碰 CDP 虚拟时间。每帧 page.evaluate(__PROMO_SEEK(virtualMs))
// ——页面自己按虚拟时刻派发场景/设动画 currentTime——然后实时截图（动画处于
// pause+定点 currentTime，surface 稳定，不会等待 BeginFrame 死锁）。
const segs = scenes.rateSegments;
let virtualMs = 0;
let frame = 0;
let driftMs = 0;
const cdp = await page.context().newCDPSession(page);
await cdp.send("Page.enable");
// 截图只走 Page.startScreencast（renderer 直推帧）。
// 实测 2026-11-12：本机 captureScreenshot / page.screenshot 会命中一个被污染的
// compositor surface（反复返回同一张 QAQ-Harness 旧窗口帧，杀进程/换浏览器无效）；
// screencast 由 renderer 产帧，帧帧真实。
const shotPng = async () => {
  const frame = await new Promise((resolve) => {
    const handler = (f) => { cdp.off("Page.screencastFrame", handler); resolve(f); };
    cdp.on("Page.screencastFrame", handler);
    cdp.send("Page.startScreencast", { format: "png", maxWidth: scenes.width, maxHeight: scenes.height, everyNthFrame: 1 }).catch(() => {});
    setTimeout(() => { cdp.off("Page.screencastFrame", handler); resolve(null); }, 15_000);
  });
  await cdp.send("Page.stopScreencast").catch(() => {});
  if (frame == null) throw new Error(`screencast 超时 @frame ${frame}`);
  await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  return Buffer.from(frame.data, "base64");
};

const t0 = Date.now();
// 首帧前快照：seek 序列尚未开始时页面本来就长什么样（排查截图与源码不符时的"旧页面"来源）。
const before = await page.evaluate(() => ({
  card: !!document.querySelector(".handoff-card"),
  bar: !!document.querySelector(".handoff-countdown"),
  btn: document.querySelector(".handoff-continue")?.textContent ?? null,
  bodyText: document.body.textContent.slice(0, 120),
  docTime: document.querySelector(".handoff-open-meta")?.textContent ?? null,
  marker: (() => { const el = [...document.querySelectorAll("small,strong,label")].map((e) => e.textContent).join("|"); return el.slice(0, 100); })(),
}));
log(`[promo] PRE-SEEK page: ${JSON.stringify(before)}`);
outer: for (const seg of segs) {
  const exactBudgetMs = (frameBaseUs / 1000) * seg.rate;
  while (virtualMs < seg.to) {
    const budgetMs = Math.round(exactBudgetMs + driftMs);
    driftMs += exactBudgetMs - budgetMs;
    virtualMs += budgetMs;
    await page.evaluate((t) => window.__PROMO_SEEK(t), Math.min(virtualMs, scenes.durationVirtualMs));
    // 关键：Solid2 的 DOM flush 挂在 rAF 调度上——截图前推两帧，保证 surface 是
    // 本帧 seek 之后的绘制（实测：不 flush 时截图停在旧 DOM，2026-11-12）。
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const png = await shotPng();
    writeFileSync(join(outDir, `f${String(frame + 1).padStart(5, "0")}.png`), png);
    frame += 1;
    if (frame % 60 === 0) log(`[promo] frame ${frame} (virtual ${(virtualMs / 1000).toFixed(1)}s, ${((Date.now() - t0) / 1000).toFixed(0)}s wall)`);
    if (maxFrames > 0 && frame >= maxFrames) break outer;
  }
}
log(`[promo] done: ${frame} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}`);
await browser.close();
await server.close();
