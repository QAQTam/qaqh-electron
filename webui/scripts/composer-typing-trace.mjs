/**
 * Composer 大草稿打字:单段落 vs 多行 × 有/无 app 管线 A/B(dev 工具)。
 * 只测墙钟与 CDP 主线程指标增量;归因结论见 console 表。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_CDP_PORT ?? "9336");
const TARGET = process.env.STRESS_URL ?? "http://127.0.0.1:5174/stress.html";
const KEYS = Number(process.env.QAQH_KEYS ?? "80");

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json());
      const page = list.find((item) => item.type === "page" && item.url === TARGET);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP target not found");
}

const child = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-ab-"))}`,
  "--window-size=1280,900", "--disable-gpu", "--no-first-run", "--disable-extensions",
  "--disable-sync", "--no-default-browser-check", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
  "--disable-features=CalculateNativeWinOcclusion", TARGET,
], { stdio: "ignore" });
child.on("error", (e) => { console.error("browser failed:", e.message); process.exit(1); });

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); return; }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)) });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("socket")), { once: true });
  });
  return { ws, open, send,
    evaluate: async (expression, timeoutMs = 300_000) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          let timer;
          const r = await Promise.race([
            send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); timer.unref(); }),
          ]).finally(() => clearTimeout(timer));
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result?.value;
        } catch (e) {
          if (/context was destroyed|Cannot find context/i.test(String(e?.message)) && attempt < 5) { await new Promise((r) => setTimeout(r, 3000)); continue; }
          throw e;
        }
      }
    } };
}

const PREAMBLE = `
window.__ab = (() => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const el = () => document.querySelector('#composer textarea');
  let bareEl = null;
  const makeText = (L, mode) => {
    if (mode === 'lines') {
      const unit = 'x'.repeat(78) + '\\n\\n';   // 真·分段(空行分隔,Blink 每段独立换行盒)
      const n = Math.max(1, Math.floor(L / unit.length));
      return unit.repeat(n);
    }
    return 'x'.repeat(L);                       // 单段巨型行盒链
  };
  const reset = async () => {
    if (bareEl) { bareEl.remove(); bareEl = null; }
    const e = el();
    e.value = '';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    await raf(); await raf();
  };
  const seed = async (L, mode) => {
    const e = el();
    const text = makeText(L, mode);
    e.focus();
    const t0 = performance.now();
    e.value = text;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    await raf(); await raf(); await raf();
    return { seedMs: Math.round(performance.now() - t0), len: e.value.length };
  };
  const type = async (K, kind) => {
    let t = el();
    if (kind === 'bare') {
      const cs = getComputedStyle(el());
      t = document.createElement('textarea');
      t.style.cssText = 'position:fixed;left:0;top:0;width:' + cs.width + ';height:160px;font:' + cs.font +
        ';padding:' + cs.padding + ';resize:none;overflow-y:auto;background:#fff;border:0;z-index:9999';
      t.value = el().value;
      document.body.appendChild(t);
      bareEl = t;
    }
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
    await raf();
    const deltas = [];
    let last = performance.now();
    const t0 = last;
    for (let i = 0; i < K; i += 1) {
      document.execCommand('insertText', false, 'a');
      await raf();
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    deltas.sort((a, b) => a - b);
    const ms = Math.round(performance.now() - t0);
    if (bareEl) { bareEl.remove(); bareEl = null; }
    return { ms, p50: +deltas[deltas.length >> 1].toFixed(1), max: +deltas[deltas.length - 1].toFixed(1), len: t.value.length };
  };
  return { reset, seed, type };
})();
'ok'`;

const rows = [];
try {
  const cdp = connect(await waitForTarget());
  await cdp.open;
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable").catch(() => {});
  for (let i = 0; i < 240; i += 1) {
    if (await cdp.evaluate(`!!document.querySelector('#composer textarea')`).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await cdp.evaluate(PREAMBLE);
  await new Promise((r) => setTimeout(r, 1500));

  const perfMap = async () => {
    const r = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
    return Object.fromEntries((r.metrics ?? []).map((i) => [i.name, i.value]));
  };

  const batch = async (label, L, mode, kind) => {
    await cdp.evaluate(`window.__ab.reset()`);
    const seeded = await cdp.evaluate(`window.__ab.seed(${L}, '${mode}')`);
    const before = await perfMap();
    const detail = await cdp.evaluate(`window.__ab.type(${KEYS}, '${kind}')`);
    const after = await perfMap();
    const dMs = (name) => (((after[name] ?? 0) - (before[name] ?? 0)) * 1000) / KEYS;
    const row = {
      label, seedMs: seeded.seedMs, len: detail.len,
      wallPerKey: +(detail.ms / KEYS).toFixed(2),
      p50: detail.p50, max: detail.max,
      taskPerKey: +dMs("TaskDuration").toFixed(2),
      layoutPerKey: +dMs("LayoutDuration").toFixed(2),
      stylePerKey: +dMs("RecalcStyleDuration").toFixed(2),
      scriptPerKey: +dMs("ScriptDuration").toFixed(2),
    };
    rows.push(row);
    console.log(`${label.padEnd(30)} len ${String(row.len).padStart(7)} seed ${String(row.seedMs).padStart(5)}ms | wall ${String(row.wallPerKey).padStart(7)}ms/键 | task ${String(row.taskPerKey).padStart(6)} = L ${String(row.layoutPerKey).padStart(6)} + S ${String(row.stylePerKey).padStart(5)} + JS ${String(row.scriptPerKey).padStart(5)} | frame p50 ${String(row.p50).padStart(6)} max ${String(row.max).padStart(6)}`);
  };

  for (const L of [160000, 480000]) {
    await batch(`APP  single-para L=${L}`, L, "para", "app");
    await batch(`BARE single-para L=${L}`, L, "para", "bare");
    await batch(`APP  multi-line  L=${L}`, L, "lines", "app");
    await batch(`BARE multi-line  L=${L}`, L, "lines", "bare");
  }

  writeFileSync("artifacts/composer-typing-ab.json", JSON.stringify(rows, null, 2));
  console.log("wrote artifacts/composer-typing-ab.json");
} finally {
  await Promise.race([Promise.resolve(), new Promise((r) => setTimeout(r, 500))]);
  child.kill();
}
