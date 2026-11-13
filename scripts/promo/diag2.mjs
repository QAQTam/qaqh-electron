// 3 帧不 seek 反证：页面静置（capture 模式无任何状态写入），截图应当是纯黑+无字幕。
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(join(root, "webui"));
const vite = await import(pathToFileURL(join(root, "webui", "node_modules", "vite", "dist", "node", "index.js")).href);
const server = await vite.createServer({ root: join(root, "webui"), configFile: join(root, "webui", "vite.config.ts"), logLevel: "warn", server: { host: "127.0.0.1", port: 5399, strictPort: true, hmr: false } });
await server.listen();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: existsSync(EDGE) ? EDGE : undefined, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:5399/promo.html?capture=1", { waitUntil: "load" });
await page.waitForFunction("window.__PROMO_READY === true", null, { timeout: 90000 });
// 静置 20 秒真实时间（若浏览器分支时间轴泄漏，这 20s 会让真实场景全跑完）
await new Promise((r) => setTimeout(r, 20000));
const state = await page.evaluate(() => ({
  dbg: window.__PROMO_DBG ?? null,
  caption: document.querySelector(".promo-caption")?.textContent ?? null,
  card: !!document.querySelector(".handoff-card"),
}));
console.log("state:", JSON.stringify(state));
await page.screenshot({ path: join(root, ".tmp", "promo", "no-seek.png"), animations: "allow" });
console.log("size:", readFileSync(join(root, ".tmp", "promo", "no-seek.png")).byteLength);
await browser.close();
await server.close();
