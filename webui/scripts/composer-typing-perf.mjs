/**
 * Composer 大文本打字 CPU 过载归因测量(dev 工具,不进产品构建)。第二版。
 *
 * 对 /stress.html 夹具里的真实 Composer 逐键打字(execCommand insertText,每键一帧),
 * 用 CDP Performance.getMetrics 增量拆每键成本;消融因子:
 *   valueNoop    —— 跳过 Solid `value={draft()}` 的整串重写(Blink 编辑缓冲全量替换)
 *   scrollConst  —— 劫持实例 scrollHeight 为常量(消掉 autoGrow 的强制同步布局)
 *   lsTape       —— 每键补一次 localStorage.setItem 全串(生产 setDraftOf 独有)
 *   control      —— 无 app 管线的裸 textarea 基线
 *   bottomScrolled —— 先「用户滚过」并贴底,复现生产场景:composer 增高 →
 *                     scroller 变矮 → scroll 事件 → SessionView.onScroll 的
 *                     O(N) querySelector 导航循环 + queueRefit 全量量高
 *
 * 用法:
 *   pnpm exec vite --port 5174
 *   STRESS_URL=http://127.0.0.1:5174/stress.html node scripts/composer-typing-perf.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_CDP_PORT ?? "9335");
const TARGET = process.env.STRESS_URL ?? "http://127.0.0.1:5174/stress.html";
const KEYS = Number(process.env.QAQH_KEYS ?? "120");
const LENGTHS = (process.env.QAQH_LENGTHS ?? "1000,32000,120000").split(",").map(Number);

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json());
      const page = list.find((item) => item.type === "page" && item.url === TARGET);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* browser not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CDP target not found: ${TARGET}`);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const consoleErrors = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? "").split("\n")[0]);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)) });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  return {
    ws, open, send, consoleErrors,
    async evaluate(expression, timeoutMs = 300_000) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          let timer;
          const result = await Promise.race([
            send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("evaluate timed out")), timeoutMs); timer.unref(); }),
          ]).finally(() => clearTimeout(timer));
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
          return result.result?.value;
        } catch (error) {
          if (/Execution context was destroyed|Cannot find context|__probe not defined/i.test(String(error?.message)) && attempt < 5) {
            await new Promise((r) => setTimeout(r, 3000));
            if (/__probe not defined/.test(String(error?.message))) { await cdpGlobalInstall(); }
            continue;
          }
          throw error;
        }
      }
    },
  };
}

const child = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-typing-perf-"))}`,
    "--window-size=1280,900",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--disable-sync",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion",
    TARGET,
  ],
  { stdio: "ignore" },
);
child.on("error", (error) => { console.error(`起不了浏览器(${EDGE}): ${error.message}`); process.exit(1); });

const PREAMBLE = `
window.__probe = (() => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const el = () => document.querySelector('#composer textarea');
  const shims = { scrollConst: false, valueNoop: false, lsTape: false };
  const st = { writes: 0, lsMs: [], scrollEvents: 0, control: null, installed: null };
  const protoDesc = {
    value: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  };
  const install = (e) => {
    uninstall();
    st.installed = e;
    if (shims.scrollConst) Object.defineProperty(e, 'scrollHeight', { configurable: true, get: () => 196 });
    if (shims.valueNoop) {
      Object.defineProperty(e, 'value', {
        configurable: true,
        get() { return protoDesc.value.get.call(this); },
        set(v) { st.writes += 1; /* 吞掉程序化整串重写;原生打字不走这个 setter */ },
      });
    }
  };
  const uninstall = () => {
    if (!st.installed) return;
    delete st.installed.value; delete st.installed.scrollHeight;
    st.installed = null;
  };
  const seed = async (L) => {
    const e = el();
    uninstall();
    e.focus();
    const s0 = performance.now();
    e.value = 'x'.repeat(L);
    e.setSelectionRange(e.value.length, e.value.length);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    await raf(); await raf(); await raf();
    return { seedMs: Math.round(performance.now() - s0) };
  };
  const reset = async () => {
    uninstall();
    if (st.control) { st.control.remove(); st.control = null; }
    const e = el();
    e.value = '';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    await raf(); await raf();
  };
  const makeControl = () => {
    const src = el();
    const c = document.createElement('textarea');
    const cs = getComputedStyle(src);
    c.style.cssText = 'position:fixed;left:0;top:0;width:' + cs.width + ';height:160px;font:' + cs.font +
      ';padding:' + cs.padding + ';resize:none;overflow-y:auto;background:#fff;border:0;z-index:9999';
    c.value = src.value;
    document.body.appendChild(c);
    st.control = c;
    return c;
  };
  const type = async (K, opts = {}) => {
    const target = opts.control ? makeControl() : el();
    if (opts.bottomScrolled) {
      const scroller = document.getElementById('messages');
      scroller.addEventListener('scroll', () => { st.scrollEvents += 1; }, true);
      // 模拟用户真的动过滚动区:SessionView 用 wheel/pointer/key 标记 userScrolled
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 10_000, bubbles: true }));
      await raf(); await raf();
    }
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
    install(target);
    st.writes = 0; st.lsMs = []; st.scrollEvents = 0;
    const deltas = [];
    let last = performance.now();
    const t0 = last;
    for (let i = 0; i < K; i += 1) {
      document.execCommand('insertText', false, 'a');
      if (shims.lsTape) { const s = performance.now(); try { localStorage.setItem('qaqh.draft.probe', target.value); } catch {} st.lsMs.push(performance.now() - s); }
      await raf();
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    uninstall();
    deltas.sort((a, b) => a - b);
    const ls = st.lsMs.slice().sort((a, b) => a - b);
    return {
      ms: Math.round(performance.now() - t0),
      p50: +deltas[deltas.length >> 1].toFixed(1),
      p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1),
      max: +deltas[deltas.length - 1].toFixed(1),
      jank: deltas.filter((d) => d > 50).length,
      draftLen: target.value.length,
      composerH: Math.round(el().getBoundingClientRect().height),
      surfaceH: Math.round(document.querySelector('.composer-surface').getBoundingClientRect().height),
      fieldSizing: CSS.supports('field-sizing', 'content'),
      valueWritesSwallowed: st.writes,
      scrollEvents: st.scrollEvents,
      lsP50: ls.length ? +ls[ls.length >> 1].toFixed(3) : undefined,
      lsP95: ls.length ? +ls[Math.floor(ls.length * 0.95)].toFixed(3) : undefined,
    };
  };
  const setShims = (next) => Object.assign(shims, next);
  return { seed, type, reset, setShims };
})();
'ok'`;

let cdpGlobalInstall = async () => {};
const rows = [];
let cdp;
try {
  const wsUrl = await waitForTarget();
  cdp = connect(wsUrl);
  await cdp.open;
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable").catch(() => {});
  cdpGlobalInstall = async () => { await cdp.evaluate(PREAMBLE); };

  for (let i = 0; i < 240; i += 1) {
    const ready = await cdp.evaluate(`!!document.querySelector('#composer textarea')`).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await cdp.evaluate(PREAMBLE);
  await new Promise((r) => setTimeout(r, 2000));

  const perfMap = async () => {
    const r = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
    return Object.fromEntries((r.metrics ?? []).map((item) => [item.name, item.value]));
  };

  const runBatch = async (label, L, typeOpts, shims) => {
    await cdp.evaluate(`window.__probe.setShims(${JSON.stringify({ scrollConst: false, valueNoop: false, lsTape: false, ...shims })})`);
    await cdp.evaluate(`window.__probe.reset()`);
    const seeded = L > 0 ? await cdp.evaluate(`window.__probe.seed(${L})`) : { seedMs: 0 };
    const before = await perfMap();
    const detail = await cdp.evaluate(`window.__probe.type(${KEYS}, ${JSON.stringify(typeOpts)})`);
    const after = await perfMap();
    detail.seedMs = seeded?.seedMs ?? 0;
    const dMs = (name) => ((after[name] ?? 0) - (before[name] ?? 0)) * 1000;
    const row = {
      label, L, keys: KEYS,
      taskPerKey: +(dMs("TaskDuration") / KEYS).toFixed(2),
      layoutPerKey: +(dMs("LayoutDuration") / KEYS).toFixed(2),
      stylePerKey: +(dMs("RecalcStyleDuration") / KEYS).toFixed(2),
      scriptPerKey: +(dMs("ScriptDuration") / KEYS).toFixed(2),
      ...detail,
    };
    rows.push(row);
    const other = (row.taskPerKey - row.layoutPerKey - row.stylePerKey - row.scriptPerKey).toFixed(2);
    console.log(`${label.padEnd(26)} draft=${String(row.draftLen).padStart(7)} | seed ${String(row.seedMs).padStart(5)}ms | task ${String(row.taskPerKey).padStart(6)} = L ${String(row.layoutPerKey).padStart(5)} + S ${String(row.stylePerKey).padStart(5)} + JS ${String(row.scriptPerKey).padStart(5)} + oth ${other.padStart(5)} | frame p50 ${String(row.p50).padStart(6)} p95 ${String(row.p95).padStart(6)} max ${String(row.max).padStart(6)} jank ${String(row.jank).padStart(3)} | h ${row.composerH}px fs=${row.fieldSizing} | scrollEv ${row.scrollEvents}${row.lsP50 !== undefined ? ` | ls p50 ${row.lsP50} p95 ${row.lsP95}` : ""}${row.valueWritesSwallowed ? ` | swallowed ${row.valueWritesSwallowed}` : ""}`);
  };

  const asIsOnly = process.env.QAQH_ASIS_ONLY === "1";
  for (const L of LENGTHS) {
    await runBatch(`as-is L=${L}`, L, {}, {});
    if (asIsOnly) continue;
    await runBatch(`control(bare) L=${L}`, L, { control: true }, {});
    await runBatch(`shim value L=${L}`, L, {}, { valueNoop: true });
    await runBatch(`shim scroll L=${L}`, L, {}, { scrollConst: true });
    await runBatch(`shim ls L=${L}`, L, {}, { lsTape: true });
  }
  if (!asIsOnly) {
    // 生产场景:用户滚动过转录并停在底部,composer 增高会反复夹 scrollTop → 每次打字都进 onScroll
    const Lbig = LENGTHS[LENGTHS.length - 1];
    await runBatch(`BOTTOM-SCROLLED as-is L=${Lbig}`, Lbig, { bottomScrolled: true }, {});
    await runBatch(`BOTTOM-SCROLLED as-is L=1000`, 1000, { bottomScrolled: true }, {});
    await runBatch(`BOTTOM-SCROLLED empty L=0`, 0, { bottomScrolled: true }, {});
  }

  await cdp.evaluate(`window.__probe.reset()`);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/composer-typing-perf.json", JSON.stringify(rows, null, 2));
  console.log("\npage exceptions:", JSON.stringify(cdp.consoleErrors.slice(0, 8), null, 1));
  console.log("wrote artifacts/composer-typing-perf.json");
} finally {
  if (cdp) {
    await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    cdp.ws.close();
  }
  child.kill();
}
