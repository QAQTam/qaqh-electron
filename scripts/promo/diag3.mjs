// 单帧取证：fresh reload → seek(t) → 截图。排除任何页面历史因素。
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(join(root, "webui"));
const vite = await import(pathToFileURL(join(root, "webui", "node_modules", "vite", "dist", "node", "index.js")).href);
const server = await vite.createServer({ root: join(root, "webui"), configFile: join(root, "webui", "vite.config.ts"), logLevel: "warn", server: { host: "127.0.0.1", port: 5499, strictPort: true, hmr: false } });
await server.listen();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: existsSync(EDGE) ? EDGE : undefined, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text", "--no-first-run", "--no-default-browser-check"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const t of [33, 5500, 11333, 16333, 20750, 26000]) {
  await page.goto("http://127.0.0.1:5499/promo.html?capture=1", { waitUntil: "load" });
  await page.waitForFunction("window.__PROMO_READY === true", null, { timeout: 60000 });
  await page.evaluate((x) => window.__PROMO_SEEK(x), t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const domTruth = await page.evaluate(async () => ({
    btn: document.querySelector(".handoff-continue")?.textContent ?? null,
    bar: !!document.querySelector(".handoff-countdown"),
    dbg: window.__PROMO_DBG ?? null,
    sourceHasNew: (document.querySelector(".handoff-continue")?.outerHTML ?? "").slice(0, 80),
    fetchBtn: await fetch("/src/promo.tsx").then((r) => r.text()).then((s) => s.includes("已在新会话继续") ? "SERVED-DIFFERS" : "SERVED-OK"),
  }));
  console.log(`t=${t}`, JSON.stringify(domTruth));
  await page.screenshot({ path: join(root, ".tmp", "promo", `single-${t}.png`), animations: "allow" });
  console.log(`single-${t} ok`);
}
await browser.close();
await server.close();
