/** Headless Edge + 真实 AssistantContent 验收,无 daemon / 外部数据。pnpm dev 后运行。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 9344;
const base = process.env.QAQH_GENUI_CHECK_URL ?? "http://localhost:5173/genui-check.html";
const out = "artifacts/genui-review";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-genui-check-"))}`,
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
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base + '?theme=' + theme });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelector('#genui-final .genui-view') != null && document.fonts.status === 'loaded'")) break;
      await delay(100);
    }
    await delay(300);
    // 终态实例:历史回答分帧 → 编译成受限 Surface(计数器可交互)。
    assert.equal(await evaluate("document.querySelectorAll('#genui-final .genui-view').length"), 1);
    assert.equal(await evaluate("document.querySelector('#genui-final .genui-view').dataset.surface"), "counter");
    assert.equal(await evaluate("document.querySelector('#genui-final .genui-card-title')?.textContent"), "计数器");
    assert.equal(await evaluate("document.querySelector('#genui-final .genui-metric-value')?.textContent"), "0");
    assert.equal(await evaluate("document.querySelectorAll('#genui-final .md-host').length"), 2);
    await click("document.querySelector('#genui-final .genui-btn')");
    assert.equal(await evaluate("document.querySelector('#genui-final .genui-metric-value')?.textContent"), "1", "本地动作可用");
    const buttons = await evaluate("Array.from(document.querySelectorAll('#genui-final .genui-btn')).map((b) => b.textContent)");
    assert.deepEqual(buttons, ["增加", "重置"]);
    await click("document.querySelectorAll('#genui-final .genui-btn')[1]");
    assert.equal(await evaluate("document.querySelector('#genui-final .genui-metric-value')?.textContent"), "0", "重置回初始值");

    // 编译失败:占位卡 + 具名错误 + 源码可查看,不渲染未知组件。
    assert.equal(await evaluate("document.querySelector('#genui-error .genui-surface.sealed') != null"), true);
    assert.equal(await evaluate("document.querySelector('#genui-error .genui-surface-error')?.textContent.includes('未知组件类型')"), true);
    assert.equal(await evaluate("document.querySelectorAll('#genui-error .genui-view').length"), 0);
    await click("document.querySelector('#genui-error .genui-surface-head')");
    assert.equal(await evaluate("document.querySelector('#genui-error .genui-surface-source')?.textContent.includes('Widget')"), true);

    // jsonl 载体 + 表单绑定 + show 条件渲染(TagList 的 item 也是 badge,按文本区分)。
    assert.equal(await evaluate("document.querySelector('#genui-form .genui-view')?.dataset.surface"), "form");
    assert.equal(await evaluate("document.querySelector('#genui-form .genui-input')?.placeholder"), "输入名称");
    const badgeVisible = "Array.from(document.querySelectorAll('#genui-form .genui-badge')).some((b) => b.textContent === '深色已开启')";
    const tagTexts = "Array.from(document.querySelectorAll('#genui-form .genui-badge')).map((b) => b.textContent).filter((t) => t !== '深色已开启')";
    assert.equal(await evaluate(badgeVisible), false, "show=false 不渲染");
    const formButtons = await evaluate("Array.from(document.querySelectorAll('#genui-form .genui-btn')).map((b) => b.textContent)");
    assert.deepEqual(formButtons, ["开启", "关闭", "加标签", "移除标签"]);
    await click("document.querySelector('#genui-form .genui-btn')");
    assert.equal(await evaluate(badgeVisible), true);
    await click("document.querySelectorAll('#genui-form .genui-btn')[1]");
    assert.equal(await evaluate(badgeVisible), false, "show 回假值后消失");
    assert.deepEqual(await evaluate(tagTexts), ["alpha"]);
    await click("document.querySelectorAll('#genui-form .genui-btn')[2]");
    assert.deepEqual(await evaluate(tagTexts), ["alpha", "beta"], "append list 态");
    await click("document.querySelectorAll('#genui-form .genui-btn')[3]");
    assert.deepEqual(await evaluate(tagTexts), ["alpha"], "remove list 态");
    // for/repeat:行随 list 态联动;校验属性落到原生 input。
    assert.deepEqual(
      await evaluate("Array.from(document.querySelectorAll('#genui-form .genui-text')).map((p) => p.textContent)"),
      ["· alpha"], "repeat 行渲染");
    assert.equal(await evaluate("document.querySelector('#genui-form .genui-input')?.maxLength"), 10, "maxLength 落到原生属性");

    // todo v2 + ask v2:可点击 checklist(翻 Surface local 态)+ followUp 排队聊天输入。
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-view')?.dataset.surface"), "plan");
    assert.equal(await evaluate("document.querySelectorAll('#genui-ask .genui-todo').length"), 2);
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-todo')?.getAttribute('aria-checked')"), "false");
    // 拼接 + 派生联动:点击 todo → 进度文本随布尔态变「是」。
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-text')?.textContent"), "进度：否");
    await click("document.querySelector('#genui-ask .genui-todo')");
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-todo')?.getAttribute('aria-checked')"), "true", "点击只翻本地布尔态");
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-todo-text.done')?.textContent"), "分帧器");
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-text')?.textContent"), "进度：是", "拼接随状态联动");
    // 校验 gating:required + disabled 随输入值解除。
    const submit = "document.querySelector('#genui-ask .genui-btn')";
    assert.equal(await evaluate(`${submit}?.disabled`), true, "空说明时禁用提交");
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-input')?.required"), true);
    await evaluate("(() => { const el = document.querySelector('#genui-ask .genui-input'); el.value = 'OK'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.equal(await evaluate(`${submit}?.disabled`), false, "输入后解除禁用");
    assert.equal(await evaluate("document.querySelector('#genui-queued')?.textContent"), "队列：空");
    await click(submit);
    const queued = await evaluate("document.querySelector('#genui-queued')?.textContent");
    assert.equal(queued?.includes("请按计划继续"), true, "followUp 排队聊天输入");
    assert.equal(queued?.includes("说明：OK"), true, "字段值随提交上报");
    assert.equal(await evaluate("document.querySelector('#genui-ask .genui-todo')?.getAttribute('aria-checked')"), "true", "提交不重置 todo 本地态");

    // 软告警:编译通过但节点挂不进树 → 照常渲染 + 非阻断提示(不是具名编译失败)。
    assert.equal(await evaluate("document.querySelector('#genui-warn .genui-view')?.dataset.surface"), "orphan");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#genui-warn .genui-badge')).map((b) => b.textContent).join(',')"), "alpha");
    assert.equal(await evaluate("document.querySelector('#genui-warn .genui-surface-error') === null"), true, "软告警不算编译失败");
    assert.equal(
      await evaluate("document.querySelector('#genui-warn .genui-surface-warn')?.textContent.includes('trow')"),
      true, "孤儿节点被点名提示");
    assert.equal(
      await evaluate("Array.from(document.querySelectorAll('#genui-warn .genui-btn')).length"),
      0, "孤儿子树(含 repeat 行)确实没渲染");

    // 流式实例:阶段推进 md → holdback → 生成中 → seal(编译渲染) → 尾部 md。
    assert.equal(await evaluate("document.querySelector('#genui-stream').dataset.stage"), "0");
    assert.equal(await evaluate("document.querySelectorAll('#genui-stream .genui-surface,#genui-stream .genui-view').length"), 0);
    assert.equal(await evaluate("document.querySelector('#genui-stream .md-host')?.textContent"), "说明文字");
    await evaluate("window.__genuiCheck.step()");
    assert.equal(await evaluate("document.querySelectorAll('#genui-stream .genui-surface,#genui-stream .genui-view').length"), 0, "holdback 不渲染");
    assert.equal(await evaluate("document.querySelector('#genui-stream .md-host')?.textContent"), "说明文字", "holdback 行不进入 markdown");
    await evaluate("window.__genuiCheck.step()");
    assert.equal(await evaluate("document.querySelector('#genui-stream .genui-surface.sealed') === null"), true, "未闭合 = 生成中");
    assert.equal(await evaluate("document.querySelector('#genui-stream .genui-surface-status')?.textContent"), "生成中");
    assert.equal(await evaluate("document.querySelectorAll('#genui-stream .md-host').length"), 1, "UI 源不进 markdown");
    await evaluate("window.__genuiCheck.step()");
    // 流式表格:部分编译让行在围栏闭合前渲染,带「生成中」指示。
    assert.equal(await evaluate("document.querySelector('#genui-stream .genui-view')?.dataset.surface"), "table", "部分编译提前渲染");
    assert.equal(await evaluate("document.querySelector('#genui-stream .genui-view')?.dataset.streaming"), "true");
    assert.deepEqual(
      await evaluate("Array.from(document.querySelectorAll('#genui-stream .genui-text')).map((p) => p.textContent)"),
      ["张三", "李四"], "已到齐的行先渲染");
    assert.equal(await evaluate("document.querySelector('#genui-stream .genui-streaming')?.textContent"), "生成中…");
    await evaluate("window.__genuiCheck.step()");
    assert.equal(await evaluate("document.querySelector('#genui-stream .genui-view')?.dataset.streaming ?? null"), null, "seal 后转正");
    assert.deepEqual(
      await evaluate("Array.from(document.querySelectorAll('#genui-stream .genui-text')).map((p) => p.textContent)"),
      ["张三", "李四", "王五"], "闭合后整帧补齐");
    await evaluate("window.__genuiCheck.step()");
    assert.equal(await evaluate("document.querySelectorAll('#genui-stream .md-host').length"), 2, "尾部 markdown 正常接上");
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#genui-stream .md-host')).pop().textContent"), "结尾");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await snapshot(`${theme}-${width}`);
    await evaluate("window.__genuiCheck.reset()");
    console.log(`PASS ${theme} ${width}: holdback / building / compile-render / interaction / fallback / overflow`);
  }
  assert.deepEqual(diagnostics, [], `运行时诊断: ${JSON.stringify(diagnostics)}`);
  console.log(`Screenshots: ${out}`);
} finally { socket?.close(); child.kill(); }
