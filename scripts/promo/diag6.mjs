// 二选一判定：data: 页截图 vs promo 页截图
import { chromium } from "playwright";
import { createHash } from "node:crypto";
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("data:text/html,<body style='background:%230f0'><h1>GREEN-MARKER</h1></body>");
const s1 = await page.screenshot();
console.log("data-page shot:", h(s1), s1.byteLength);
await browser.close();
