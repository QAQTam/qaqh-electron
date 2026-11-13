import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
const t = await cdp.send("Target.getTargets");
console.log(JSON.stringify(t.targetInfos.map((x) => `${x.type} | ${x.title.slice(0, 30)} | ${x.url.slice(0, 60)}`), null, 1));
console.log("proc:", browser.process()?.pid, browser.process()?.spawnfile);
await browser.close();
