// 截图 buffer 与落盘文件哈希对质 + 同屏双截一致性
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(join(root, "webui"));
const vite = await import(pathToFileURL(join(root, "webui", "node_modules", "vite", "dist", "node", "index.js")).href);
const server = await vite.createServer({ root: join(root, "webui"), configFile: join(root, "webui", "vite.config.ts"), logLevel: "warn", server: { host: "127.0.0.1", port: 5799, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-gpu", "--disable-software-rasterizer", "--disable-features=CalculateNativeWinOcclusion"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://127.0.0.1:5799/promo.html?capture=1", { waitUntil: "load" });
await page.waitForFunction("window.__PROMO_READY === true", null, { timeout: 60000 });
await page.evaluate(() => window.__PROMO_SEEK(33));
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// 强制重绘：根元素 1px nudge + 还原，击穿 compositor surface 缓存。
await page.evaluate(() => { const el = document.documentElement; el.style.transform = "translate(0,0.001px)"; void el.offsetHeight; el.style.transform = ""; });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Page.enable");
const shot = async () => {
  const frame = await new Promise((resolve) => {
    const handler = (f) => { cdp.off("Page.screencastFrame", handler); resolve(f); };
    cdp.on("Page.screencastFrame", handler);
    cdp.send("Page.startScreencast", { format: "png", maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }).catch(() => {});
    setTimeout(() => { cdp.off("Page.screencastFrame", handler); resolve(null); }, 8000);
  });
  await cdp.send("Page.stopScreencast").catch(() => {});
  if (frame == null) throw new Error("screencast 超时");
  await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  return Buffer.from(frame.data, "base64");
};
const buf1 = await shot();
writeFileSync(join(root, ".tmp", "promo", "buf1.png"), buf1);
const buf2 = await shot();
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
console.log("pages:", browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(" , "));
console.log("buf1:", h(buf1), buf1.byteLength);
console.log("buf2:", h(buf2), buf2.byteLength);
console.log("disk-after:", h(readFileSync(join(root, ".tmp", "promo", "buf1.png"))));
console.log("resources:", await page.evaluate(() => JSON.stringify(performance.getEntriesByType("resource").filter((r) => r.name.includes("promo")).map((r) => `${r.name.split("/").slice(-2).join("/")} dur=${Math.round(r.duration)} transferSize=${r.transferSize}`))));
console.log("layers:", await page.evaluate(() => JSON.stringify({
  iframes: document.querySelectorAll("iframe").length,
  canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}:${getComputedStyle(c).position}:${c.className}`),
  videos: document.querySelectorAll("video").length,
  bodyChildren: [...document.body.children].map((el) => `${el.tagName}#${el.id}.${el.className}`.slice(0, 50)),
  rootChildren: [...document.getElementById("root").children].map((el) => `${el.tagName}.${el.className}`.slice(0, 50)),
  innerLen: document.body.innerHTML.length,
})));
console.log("body:", await page.evaluate(() => document.body.textContent.slice(0, 60)));
await browser.close();
await server.close();
