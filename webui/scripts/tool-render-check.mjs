/** Headless Edge + 真实 StepRow 验收，无 daemon / 外部数据。pnpm dev 后运行。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 9341;
const base = process.env.QAQH_TOOL_CHECK_URL ?? "http://127.0.0.1:5173/tool-render-check.html";
const out = "artifacts/tool-render-review/semantic";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-tool-check-"))}`,
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
    if (msg.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes(msg.params.type)) diagnostics.push(msg.params);
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
  /** 浅色一轮的图标颜色:深色一轮要能证明「颜色真的跟着主题换了」。 */
  let lightIconColor = "";
  for (const [theme, width] of [["light", 1000], ["dark", 1000], ["light", 480], ["dark", 480]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base + '?theme=' + theme });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelectorAll('.tool-head').length === 8 && document.querySelectorAll('.todo-card').length === 1 && document.fonts.status === 'loaded'")) break;
      await delay(100);
    }
    await delay(300);
    assert.equal(await evaluate("document.querySelectorAll('.tool-head').length"), 8);
    assert.equal(await evaluate("document.querySelectorAll('.todo-card').length"), 1);
    assert.equal(await evaluate("document.querySelector('.todo-card .todo-count').textContent"), "2/5");
    assert.equal(await evaluate("document.querySelectorAll('.todo-card .todo-card-row').length"), 5);
    assert.equal(await evaluate("document.body.textContent.includes('梳理渲染分层') && document.body.textContent.includes('已放弃的旧方案')"), true);
    assert.equal(await evaluate("document.querySelector('.todo-card').textContent.includes('receipt')"), false, "卡片不展示工具收据");
    assert.equal(await evaluate("document.querySelectorAll('.tool-raw-args,.tool-disclosure-toggle').length"), 0);
    assert.equal(await evaluate("document.body.textContent.includes('new_str') || document.body.textContent.includes('原始参数')"), false);
    assert.equal(await evaluate("document.querySelector('.st-error .tool-error').textContent"), "锚点未唯一匹配，文件未修改。");
    assert.equal(await evaluate("document.querySelectorAll('.tool-summary .text-shimmer-base')[4].textContent"), "");
    assert.equal(await evaluate("document.querySelectorAll('.tool-head')[4].disabled"), true);
    assert.equal(await evaluate("document.body.textContent.includes('test 179')"), true, "exec 默认展示终态输出");
    assert.equal(await evaluate("document.querySelectorAll('.tool-text span').length > 0"), true, "保留 ANSI");
    assert.equal(await evaluate("document.querySelector('.tool-shell-output').textContent.includes(String.fromCharCode(27))"), false, "不得展示 ANSI 原始控制序列");
    assert.equal(await evaluate("document.querySelector('.tool-shell-output').clientHeight <= 280"), true);
    assert.equal(await evaluate("document.querySelectorAll('.tool-head')[6].textContent.trim()"), "已调用 skills");
    assert.equal(await evaluate("document.querySelectorAll('.tool-head')[7].textContent.trim()"), "已读取 skills");
    assert.equal(await evaluate("document.body.textContent.includes('mc-source-driven-mod') || document.body.textContent.includes('receipt')"), false);
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    // 命令品牌图标走 CSS 遮罩(Simple Icons 的 path 不带 fill,`<img>` 直出就是纯黑,
    // 深色主题下会糊成一块黑)。这里断言的是「不是 img + 有遮罩 + 颜色跟着主题走」,
    // 最后一条才是用户真正看得见的那件事。
    const iconStyle = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('.tool-command-icon')];
      if (nodes.length === 0) return null;
      const style = getComputedStyle(nodes[0]);
      return {
        count: nodes.length,
        mask: style.maskImage || style.webkitMaskImage,
        fill: style.backgroundColor,
        img: document.querySelectorAll('img.tool-command-icon').length,
      };
    })()`);
    assert.ok(iconStyle != null, "shell 步骤应带品牌图标");
    assert.equal(iconStyle.img, 0, "图标不能再用 <img>(纯黑 path 在深色主题下不可见)");
    assert.match(iconStyle.mask, /url\(/, `图标必须用 mask 渲染:${iconStyle.mask}`);
    const channels = iconStyle.fill.match(/rgba?\((\d+), (\d+), (\d+)/);
    assert.ok(channels != null, `图标颜色应可解析:${iconStyle.fill}`);
    const luma = 0.299 * Number(channels[1]) + 0.587 * Number(channels[2]) + 0.114 * Number(channels[3]);
    if (theme === "dark") {
      assert.ok(luma > 120, `深色主题下命令图标太暗(${iconStyle.fill}),会糊成黑块`);
      assert.notEqual(iconStyle.fill, lightIconColor, "深色主题下图标颜色必须换一套");
    } else {
      assert.ok(luma < 160, `浅色主题下命令图标太亮(${iconStyle.fill})`);
      lightIconColor = iconStyle.fill;
    }
    await snapshot(theme + '-' + width + '-default');

    await click("document.querySelectorAll('.tool-head')[0]");
    assert.equal(await evaluate("document.body.textContent.includes('test 179')"), false, "折叠工具仍卸载日志");
    assert.equal(await evaluate("document.querySelectorAll('.tool-summary .text-shimmer-base')[1].textContent"), "E:/qaqh-backend/crates/qaqh-policy/src/lib.rs");
    assert.equal(await evaluate("document.querySelectorAll('.tool-head')[1].disabled"), true, "没有结果详情时不展示空折叠入口");
    assert.equal(await evaluate("document.querySelectorAll('.tool-path').length"), 0, "绝对路径只在顶层显示");
    assert.equal(await evaluate("document.body.textContent.includes('permission_99')"), false, "读取文件不展示全文");
    await click("document.querySelectorAll('.tool-head')[3]");
    assert.equal(await evaluate("document.querySelectorAll('.st-success .diff-file').length > 0"), true);
    assert.equal(await evaluate("document.querySelectorAll('.tool-summary .text-shimmer-base')[3].textContent"), "E:/qaqh-backend/src/policy.ts");
    assert.equal(await evaluate("document.querySelectorAll('.tool-detail .tool-command').length"), 0, "工具结果不重复路径块");
    assert.equal(await evaluate("document.querySelector('.st-success .diff-path').textContent.trim()"), "差异", "单文件 diff 不重复文件名");
    assert.equal(await evaluate("document.querySelectorAll('.st-error .diff-file').length"), 0, "失败请求不能画成已修改");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await evaluate("window.scrollTo(0,0)");
    await snapshot(theme + '-' + width + '-diff');

    assert.equal(await evaluate("document.querySelector('.tool-progress').textContent"), "vite: building renderer…");
    await evaluate("window.__toolRenderCheck.finish()"); await delay(300);
    assert.equal(await evaluate("document.querySelectorAll('.tool-head')[5].getAttribute('aria-expanded')"), "true");
    assert.equal(await evaluate("document.querySelectorAll('.tool-progress').length"), 0);
    assert.equal(await evaluate("document.body.textContent.includes('build complete') && document.body.textContent.includes('final warning')"), true);
    assert.equal(await evaluate("document.body.textContent.includes('vite: building renderer')"), false, "终态输出替换而不叠加 progress");
    await snapshot(theme + '-' + width + '-terminal');
    await click("document.querySelectorAll('.tool-head')[5]");
    await evaluate("window.__toolRenderCheck.finish()"); await delay(300);
    assert.equal(await evaluate("document.querySelectorAll('.tool-head')[5].getAttribute('aria-expanded')"), "false", "用户折叠不能被终态刷新覆盖");
    console.log('PASS ' + theme + ' ' + width + ': semantic-only / paths / diff / no raw / ANSI / progress replacement / overflow');
  }
  assert.deepEqual(diagnostics, [], `运行时诊断: ${JSON.stringify(diagnostics)}`);
  console.log(`Screenshots: ${out}`);
} finally { socket?.close(); child.kill(); }
