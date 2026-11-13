/** Headless Edge + widget-directive C2 全链路验收，无 daemon。pnpm dev 后运行。
 *
 * 断面对齐 webui/src/widget-check.tsx：§1 visualize 工具段挂载（合法 args /
 * 缺件降级）、§2 srcdoc 沙箱装配、§3 桥往返
 * （setWidgetState→快照、sendHeight→高度、sendFollowUpMessage→确认浮层→发送）。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 9345;
const base = process.env.QAQH_WIDGET_CHECK_URL ?? "http://localhost:5173/widget-check.html";
const out = "artifacts/widget-review";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-widget-check-"))}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "about:blank",
], { stdio: "ignore" });
let socket;
const diagnostics = [];
try {
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((p) => p.type === "page"); } catch { /* starting */ }
    if (target?.webSocketDebuggerUrl) break;
    await delay(200);
  }
  assert.ok(target?.webSocketDebuggerUrl);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === "Runtime.exceptionThrown") diagnostics.push(msg.params);
    const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); msg.error ? request.reject(msg.error) : request.resolve(msg.result); }
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async (expression) => {
    const point = await evaluate(`(() => { const el = ${expression}; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await delay(300);
  };
  const snapshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  await send("Runtime.enable"); await send("Page.enable");
  for (const [theme, width] of [["light", 1000], ["dark", 1000], ["light", 480], ["dark", 480]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base + "?theme=" + theme });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelector('#case-block iframe.qqh-widget-frame') != null && document.fonts.status === 'loaded'")) break;
      await delay(100);
    }
    await delay(300);

    // 1) visualize 工具段 → 沙箱 iframe，禁 allow-same-origin。
    assert.equal(await evaluate("document.querySelectorAll('#case-block iframe.qqh-widget-frame').length"), 1);
    const sandbox = await evaluate("document.querySelector('#case-block iframe')?.getAttribute('sandbox')");
    assert.equal(sandbox, "allow-scripts allow-forms allow-modals allow-popups");
    assert.ok(!(sandbox ?? "").includes("allow-same-origin"), "禁 allow-same-origin");

    // 2) 桥往返——自动 follow-up 应升起确认浮层，点「发送」后进 user-send 通道：
    const dialogUp = "document.querySelector('.qqh-widget-dialog-title') != null";
    for (let i = 0; i < 50; i++) {
      if (await evaluate(dialogUp)) break;
      await delay(100);
    }
    assert.equal(await evaluate(dialogUp), true, "自动 sendFollowUpMessage 应升起宿主确认浮层");
    assert.equal(await evaluate("document.querySelector('.qqh-widget-dialog-title')?.textContent"), "widget-check 上报");
    await click("document.querySelector('.qqh-widget-dialog-send')");
    assert.equal(
      await evaluate("window.__QQH_WIDGET_CHECK__.find((e) => e.kind === 'followUp')?.detail.prompt ?? null"),
      "widget count=0",
    );
    assert.equal(await evaluate("document.querySelector('.qqh-widget-dialog') == null"), true, "确认后关浮层");

    // 3) setWidgetState → 快照落到宿主存储（key=fragment 路径，取自 DOM dataset）。
    const counterPath = await evaluate("document.querySelector('#case-block .qqh-widget-mount')?.dataset?.qqhPath ?? ''");
    assert.ok(counterPath.endsWith("counter.html"), `dataset.qqhPath 应为 counter 路径，实测 ${counterPath}`);
    assert.equal(
      await evaluate(`(() => { const raw = localStorage.getItem(${JSON.stringify(counterPath)}); return raw === null ? "MISS" : JSON.parse(raw).modelContent.hello; })()`),
      "wc",
      "快照 modelContent 应写进宿主存储",
    );

    // 4) sendHeight：fragment min-height 320 → iframe 高被顶过初值 240。
    const frameHeight = await evaluate("parseInt(document.querySelector('#case-block iframe').style.height, 10)");
    assert.ok(frameHeight > 240, `sendHeight 应把 iframe 顶到 >240，实测 ${frameHeight}`);

    // 5) fragment 读取失败：mount 降级为不可用占位。
    await delay(500);
    const missingText = await evaluate("document.querySelector('#case-missing .qqh-widget-fallback')?.textContent ?? null");
    assert.ok(String(missingText ?? "").includes("缺件"), `缺件降级占位缺失，实测 ${missingText}`);

    await snapshot(`widget-directive-${theme}-${width}`);
  }
  assert.deepEqual(diagnostics, [], "页面不得抛未捕获异常");
  console.log("widget-check: OK（C2 挂载 / 沙箱装配 / 桥往返 / 降级）");
} finally {
  child.kill();
  socket?.close();
}
