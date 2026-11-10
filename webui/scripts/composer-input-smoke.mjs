/**
 * Composer 非受控输入的功能冒烟(dev 工具):验证性能修复没改坏行为——
 *  1) 打字时高度随内容生长(纯 CSS field-sizing,JS 零介入);
 *  2) 打字期间没有任何程序化 `textarea.value` 整串写回(引用相等快路生效);
 *  3) Enter/按钮发送后 store 清空草稿能**桥接回 DOM**(外部变更路径),按钮回禁用;
 *  4) 空/非空边界驱动发送按钮 disabled(草稿非空即可发)。
 *
 * 用法同 perf 脚本(vite 5174 + stress.html)。断言失败 exit 1。
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_CDP_PORT ?? "9338");
const TARGET = process.env.STRESS_URL ?? "http://127.0.0.1:5174/stress.html";

const child = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-smoke-"))}`,
  "--window-size=1280,900", "--disable-gpu", "--no-first-run", "--disable-extensions",
  "--disable-sync", "--no-default-browser-check", "--disable-features=CalculateNativeWinOcclusion",
  TARGET,
], { stdio: "ignore" });

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((p) => p.type === "page" && p.url === TARGET);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP target not found");
}

const cdp = await (async () => {
  const ws = new WebSocket(await waitForTarget());
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)) });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  await send("Runtime.enable");
  return { send, ws, evaluate: async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  } };
})();

try {
  for (let i = 0; i < 240; i += 1) {
    if (await cdp.evaluate(`!!document.querySelector('#composer textarea')`).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));

  await cdp.evaluate(`
    window.__smoke = (() => {
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      // 计一次「程序化 value 写」:原生打字走编辑器内部,不走 JS setter。
      const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      let jsValueWrites = 0;
      const watch = (el) => Object.defineProperty(el, 'value', {
        configurable: true,
        get() { return proto.get.call(this); },
        set(v) { jsValueWrites += 1; proto.set.call(this, v); },
      });
      const el = () => document.querySelector('#composer textarea');
      return {
        async run() {
          const e = el();
          watch(e);
          e.focus();
          const h0 = Math.round(e.getBoundingClientRect().height);
          jsValueWrites = 0;
          document.execCommand('insertText', false, '一二三四五');
          await raf(); await raf();
          const after5 = { h: Math.round(e.getBoundingClientRect().height), writes: jsValueWrites,
            disabledSend: document.querySelector('#composer .send').disabled };
          for (let i = 0; i < 60; i += 1) { document.execCommand('insertText', false, 'abcdefghij'); await raf(); }
          const after650 = { len: e.value.length, h: Math.round(e.getBoundingClientRect().height), writes: jsValueWrites };
          // 模拟 Enter 发送(非 Enter 路径:直接点按钮)。fixture 的 onSend 会把草稿清空。
          document.querySelector('#composer .send').click();
          await raf(); await raf(); await raf(); await raf();
          const afterSend = { len: e.value.length, h: Math.round(e.getBoundingClientRect().height),
            disabledSend: document.querySelector('#composer .send').disabled, writes: jsValueWrites,
            store: 'see sendCleared' };
          return { h0, after5, after650, afterSend };
        },
      };
    })();
  `);
  const r = await cdp.evaluate(`window.__smoke.run()`);

  // 空态一行高随平台皮肤而变:通用 52px,fluent(Windows)皮肤压到 44px。
  check("空态高度 ≈ 1 行(44–60px)", r.h0 >= 44 && r.h0 <= 60, `h0=${r.h0}`);
  check("5 字后仍单行高度、发送按钮解禁", r.after5.disabledSend === false && r.after5.h >= 44, `h=${r.after5.h} disabled=${r.after5.disabledSend}`);
  check("打字 650 字高度生长且封顶 160px", r.after650.h >= 100 && r.after650.h <= 160, `len=${r.after650.len} h=${r.after650.h}`);
  check("打字期间零程序化整串写回", r.after650.writes === 0, `writes=${r.after650.writes}`);
  check("发送后桥接清空 DOM(外部变更路径)", r.afterSend.len === 0, `len=${r.afterSend.len}`);
  check("发送后按钮回禁用、高度回 1 行", r.afterSend.disabledSend === true && r.afterSend.h <= 60, `disabled=${r.afterSend.disabledSend} h=${r.afterSend.h}`);
  check("清空是外部写(打字 0 + 清空 1 次 setter)", r.afterSend.writes === 1, `writes=${r.afterSend.writes}`);
} finally {
  console.log(failures.length ? `\nFAILED: ${failures.join(", ")}` : "\nall smoke checks passed");
  await cdp.send("Browser.close").catch(() => {});
  cdp.ws.close();
  child.kill();
  process.exitCode = failures.length ? 1 : 0;
}
