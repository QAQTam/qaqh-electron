// 一次性诊断：打开 capture=1，不 seek，看页面是否自己动起来（真实时间轴泄漏=CAPTURE 判定失效）。
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(join(root, "webui"));
const vite = await import(pathToFileURL(join(root, "webui", "node_modules", "vite", "dist", "node", "index.js")).href);
const server = await vite.createServer({ root: join(root, "webui"), configFile: join(root, "webui", "vite.config.ts"), logLevel: "warn", server: { host: "127.0.0.1", port: 5299, strictPort: true, hmr: false } });
await server.listen();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: existsSync(EDGE) ? EDGE : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:5299/promo.html?capture=1", { waitUntil: "load" });
await page.waitForFunction("window.__PROMO_READY === true", null, { timeout: 60000 });
const info = await page.evaluate(() => ({
  search: location.search,
  hasSeek: typeof window.__PROMO_SEEK === "function",
  animCount: document.getAnimations().length,
}));
console.log("t0", JSON.stringify(info));
await new Promise((r) => setTimeout(r, 6000)); // 真等 6 秒：capture 模式下页面应纹丝不动
const info2 = await page.evaluate(() => ({
  animCount: document.getAnimations().length,
  bodyHasCard: !!document.querySelector(".handoff-card"),
  caption: document.querySelector(".promo-caption")?.textContent ?? null,
}));
console.log("t+6s", JSON.stringify(info2));
if (info2.bodyHasCard || info2.caption != null) console.log(">>> 泄漏：真实时间轴在跑");
else console.log(">>> 静置正常，seek 模式生效");
// 对齐渲染器 f340：seek 到 11333ms，等两帧 flush 再查 DOM。
const after = await page.evaluate(async (t) => {
  window.__PROMO_SEEK(t);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    card: !!document.querySelector(".handoff-card"),
    ritual: !!document.querySelector(".bxr-seal"),
    countdownBar: !!document.querySelector(".handoff-countdown"),
    cdLabel: document.querySelector(".handoff-countdown-label")?.textContent ?? null,
    sideB: !!document.querySelector('[data-session-id="sess-promo-child"]'),
    anims: document.getAnimations().length,
  };
}, 11333);
console.log("seek(11333) ->", JSON.stringify(after));
await browser.close();
await server.close();
