/** Headless Edge + 真实 ApprovalStack 验收(ask 居中模态),无 daemon / 外部数据。pnpm dev 后运行。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 9343;
const base = process.env.QAQH_ASK_CHECK_URL ?? "http://localhost:5173/ask-check.html";
const out = "artifacts/ask-review";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-ask-check-"))}`,
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
  const clickAt = async (expression) => {
    assert.ok(await evaluate(`(${expression}) != null`), `找不到点击目标: ${expression}`);
    const point = await evaluate(`(() => { const el = ${expression}; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await delay(300);
  };
  const clickOption = (position) => clickAt(`document.querySelectorAll('#approval-slot .ask-opt')[${position}]`);
  const type = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const snapshot = async (name) => {
    // 上一轮遗留的横向偏移只体现在截图里,断言抓不到:每张图都从原点重拍。
    await evaluate("window.scrollTo(0, 0); document.querySelector('#approval-slot').scrollTop = 0; true");
    await delay(120);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  const openAsk = async (url) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelectorAll('#approval-slot .card.ask').length === 1 && document.fonts.status === 'loaded'")) return;
      await delay(100);
    }
    throw new Error(`ask 卡未挂载: ${url}`);
  };
  await send("Runtime.enable"); await send("Page.enable");
  for (const [theme, width] of [["light", 1000], ["dark", 1000], ["light", 480], ["dark", 480]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await openAsk(base + "?theme=" + theme);
    await delay(300);
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .card.ask').length"), 1, "ask 走居中模态");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#approval-slot')).position"), "fixed", "遮罩脱离文档流,不再嵌进消息列");
    assert.equal(await evaluate("(() => { const r = document.querySelector('#approval-slot .card.ask').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()"), true, "卡片完整落在视口内");
    assert.equal(await evaluate("document.querySelectorAll('#approval-dialog-title').length"), 1, "dialog 标题 id 唯一");
    assert.equal(await evaluate("document.querySelector('#approval-slot .card-more')?.textContent"), await evaluate("document.querySelector('.ask-check-last').dataset.expectedMore"), "模态卡「还有 N 个」计数");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);

    // 一次一问:轨上 3 行是全景,卡身只有当前一问。
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .ask-rail-row').length"), 3, "问题轨每问一行");
    assert.equal(await evaluate("(() => { const rail = document.querySelector('#approval-slot .ask-rail'); return rail.scrollWidth <= rail.clientWidth + 1; })()"), true, "问题轨不得横向溢出");
    assert.equal(await evaluate("document.querySelector('#approval-slot .ask-rail-row[aria-current=\"step\"]') === document.querySelector('#approval-slot .ask-rail-row')"), true, "初始停在第一问");
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .card-body .card-q-text').length"), 1, "卡身只呈现当前一问");
    assert.equal(await evaluate("/^[0-9]+:[0-9]{2}$/.test(document.querySelector('#approval-slot .ask-timer')?.textContent ?? '')"), true, "TTL 倒计时可见");
    await snapshot(`ask-first-${theme}-${width}`);

    // 逐问推进是自由浏览,校验只压在提交上:空着走到底再提交,应当报错、不发载荷、跳回未答的那一问。
    await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
    await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
    assert.equal(await evaluate("document.querySelector('#approval-slot .ask-step')?.textContent"), "第 3 / 3 问", "主操作逐问推进");
    await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
    assert.equal(await evaluate("document.querySelector('#approval-slot .card-error')?.textContent"), await evaluate("document.querySelector('.ask-check-last').dataset.expectedRequired"), "未答即报错");
    assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"), "（尚未提交）", "未答不得发载荷");
    assert.equal(await evaluate("document.querySelector('#approval-slot .ask-step')?.textContent"), "第 1 / 3 问", "提交报错跳回第一个未答的问题");

    // 第一问:「其它」+ 自由文本
    await clickOption(3);
    assert.equal(await evaluate("document.querySelector('#approval-slot input[data-custom]') != null"), true, "选中「其它」才摊开输入框");
    await snapshot(`ask-custom-${theme}-${width}`);
    await type("#approval-slot input[data-custom]", "3000");
    await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
    assert.equal(await evaluate("document.querySelector('#approval-slot .ask-rail-row').dataset.state"), "done", "答过的轨行翻成已答");
    assert.equal(await evaluate("document.querySelector('#approval-slot .ask-step')?.textContent"), "第 2 / 3 问", "推进到第二问");

    // 第二问:整行可点的选项
    await clickOption(0);
    await clickAt("document.querySelector('#approval-slot .card-actions .primary')");

    // 第三问:allow_custom=false,不该出现「其它」行
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .ask-opt').length"), 2, "禁自定义的问题只有选项行");
    await snapshot(`ask-last-${theme}-${width}`);
    await clickOption(1);
    await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
    assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
      '{"challengeId":"ask-1","decision":"submit","payload":{"answers":[{"question_id":"invalidation","answer":"3000"},{"question_id":"housekeeping","answer":"加进前端 .gitignore（推荐）"},{"question_id":"commit","answer":"先别提交，我自己看一遍再说"}]}}',
      "逐题答案按题序提交,自定义与选项各归其位");
    await clickAt("document.querySelector('#approval-slot .card-actions .button-secondary')");
    assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
      '{"challengeId":"ask-1","decision":"dismiss","payload":{}}', "跳过走 dismiss");

    // 注入模态授权:同一个遮罩栈改挂授权卡,ask 退回队列尾部。
    // 遮罩 fixed inset:0 会吃掉坐标点击,这里只能走 DOM 直调。
    await evaluate("(() => { document.querySelector('#ask-check-show-perm').click(); return true; })()");
    await delay(300);
    assert.equal(await evaluate("document.querySelector('#approval-slot [role=\"dialog\"] .card.perm') != null"), true);
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .card.ask').length"), 0, "授权在队首时 ask 不展示");
    assert.equal(await evaluate("document.querySelectorAll('#approval-dialog-title').length"), 1, "dialog 标题 id 唯一");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await snapshot(`${theme}-${width}`);
    console.log(`PASS ${theme} ${width}: 模态/视口/问题轨/逐问推进/自定义答案/跳过/队列/溢出`);
  }

  // 键盘通路:鼠标过了不代表键盘过了。数字选行、方向键移行、↵ 逐问推进、Esc 跳过。
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await openAsk(base + "?theme=light");
  const KEYS = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Escape: { code: "Escape", vk: 27 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
  };
  const press = async (key) => {
    const spec = KEYS[key] ?? { code: `Digit${key}`, vk: 48 + Number(key), text: key };
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: spec.vk, code: spec.code, text: spec.text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: spec.vk, code: spec.code });
    await delay(150);
  };
  const pickedRow = () => evaluate("Array.from(document.querySelectorAll('#approval-slot .ask-opt')).findIndex((el) => el.dataset.picked === 'true')");
  assert.equal(await evaluate("document.activeElement?.classList?.contains('ask')"), true, "卡挂载即拿到焦点");
  await press("2");
  assert.equal(await pickedRow(), 1, "数字键选中对应行");
  await press("ArrowDown");
  assert.equal(await pickedRow(), 2, "方向键在行之间移动");
  await press("4");
  assert.equal(await evaluate("document.querySelector('#approval-slot input[data-custom]') === document.activeElement"), true, "选「其它」后光标进输入框");
  await type("#approval-slot input[data-custom]", "3000");
  await press("Enter");
  assert.equal(await evaluate("document.querySelector('#approval-slot .ask-step')?.textContent"), "第 2 / 3 问", "换问后焦点仍在这张卡上");
  assert.equal(await evaluate("document.activeElement?.classList?.contains('ask')"), true, "重挂载不丢键盘");
  await press("1");
  await press("Enter");
  await press("2");
  await press("Enter");
  assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
    '{"challengeId":"ask-1","decision":"submit","payload":{"answers":[{"question_id":"invalidation","answer":"3000"},{"question_id":"housekeeping","answer":"加进前端 .gitignore（推荐）"},{"question_id":"commit","answer":"先别提交，我自己看一遍再说"}]}}',
    "纯键盘也能答完三问");
  await press("Escape");
  assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
    '{"challengeId":"ask-1","decision":"dismiss","payload":{}}', "Esc 走跳过");
  await snapshot("keyboard-light-1000");
  console.log("PASS keyboard: 数字/方向键/↵ 推进/Esc 跳过");

  // 极值:单问 + 零选项。轨与"第 n/N 问"该自然消失,输入框该直接摊开。
  await openAsk(base + "?theme=light&shape=bare");
  await delay(300);
  assert.equal(await evaluate("document.querySelectorAll('#approval-slot .ask-rail-row').length"), 0, "单问不出问题轨");
  assert.equal(await evaluate("document.querySelector('#approval-slot .ask-step') == null"), true, "单问不出「第 n/N 问」");
  assert.equal(await evaluate("document.querySelectorAll('#approval-slot .ask-opt').length"), 1, "零选项只剩「其它」一行");
  assert.equal(await evaluate("document.querySelector('#approval-slot input[data-custom]') != null"), true, "零选项直接摊开输入框");
  assert.equal(await evaluate("document.querySelector('#approval-slot .card-actions .primary')?.textContent"), "提交", "单问的主操作就是提交");
  await type("#approval-slot input[data-custom]", "记得跑一遍 just gate");
  await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
  assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
    '{"challengeId":"ask-bare","decision":"submit","payload":{"answers":[{"question_id":"note","answer":"记得跑一遍 just gate"}]}}',
    "零选项的问题也能提交");
  await snapshot("bare-light-1000");
  console.log("PASS bare: 单问 / 零选项 / 无轨退化");

  // TTL 到期的那一帧:表单不再可提交,唯一动作是重新获取。
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await openAsk(base + "?theme=light&ttl=1");
  await delay(1800);
  assert.equal(await evaluate("document.querySelector('#approval-slot .card.ask').dataset.state"), "expired", "到点翻失效态");
  assert.equal(await evaluate("document.querySelector('#approval-slot .ask-timer').textContent"), "0:00");
  assert.equal(await evaluate("document.querySelector('#approval-slot .ask-opt input').disabled"), true, "失效后选项不再可点");
  assert.equal(await evaluate("document.querySelector('#approval-slot .card-actions .primary')?.textContent"), await evaluate("document.querySelector('.ask-check-last').dataset.expectedRefresh"), "失效态唯一主操作是重新获取");
  await clickAt("document.querySelector('#approval-slot .card-actions .primary')");
  assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"), '{"refreshed":true}', "重新获取走 approvals 重取");
  await snapshot("expired-light-1000");
  console.log("PASS expired: 失效态 / 禁用表单 / 重新获取");
  assert.deepEqual(diagnostics, [], `运行时诊断: ${JSON.stringify(diagnostics)}`);
  console.log(`Screenshots: ${out}`);
} finally { socket?.close(); child.kill(); }
