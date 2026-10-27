/**
 * 渲染层压力测试驱动(dev 工具,不进产品构建)。
 *
 * 为什么不用 MCP/手工控制台跑:页面一旦被 OS 遮挡或切到后台,Chromium 就不发 rAF,
 * 而贴底推进、文本帧合并、requestIdleCallback 的窗口淘汰全挂在帧上 —— 测量会静默
 * 停摆。这里自己起一个 headless Edge(与 WebView2 同一内核),用
 * --disable-*-backgrounding 保证帧照常,顺带拿到真实 JS 堆。
 *
 * 用法:
 *   pnpm exec vite --port 5173            # 另开一个终端
 *   pnpm exec node scripts/stress-cdp.mjs
 * 前置:/stress.html + /src/stress.tsx 夹具(合成数据,不连 daemon)。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_CDP_PORT ?? "9333");
const TARGET = process.env.STRESS_URL ?? "http://127.0.0.1:5173/stress.html";

const diagnostics = [];
const recordConsole = (msg) => {
  const text = (msg.params?.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
  if (!text) return;
  const code = text.match(/\b([A-Z][A-Z_]{4,})\b/)?.[1];
  const line = text.split("\n")[0];
  if (code || msg.params?.type === "error") {
    const key = `${code ?? "error"}|${line.slice(0, 120)}`;
    const existing = diagnostics.find((item) => item.key === key);
    if (existing) existing.count += 1;
    else {
      const stack = (msg.params?.stackTrace?.callFrames ?? [])
        .map((frame) => `${frame.functionName || "anon"}@${(frame.url ?? "").split("/").pop()}:${frame.lineNumber + 1}`)
        .slice(0, 6)
        .join(" ← ");
      diagnostics.push({ key, count: 1, line, stack });
    }
  }
};

async function waitForTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json());
      const page = list.find((item) => item.type === "page" && item.url === TARGET);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP target not found: ${TARGET}`);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") recordConsole(msg);
    if (msg.method === "Runtime.exceptionThrown") {
      const detail = msg.params?.exceptionDetails;
      diagnostics.push({ key: `exception|${detail?.text ?? ""}`, count: 1, line: detail?.exception?.description ?? detail?.text ?? "exception" });
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)) });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  return {
    ws,
    open,
    send,
    async evaluate(expression, timeoutMs = 90_000) {
      // vite 首次请求会补优化依赖并整页 reload → 执行上下文被销毁。等一次再来。
      for (let attempt = 0; ; attempt += 1) {
        try {
          let timer;
          const result = await Promise.race([
            send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 60)}`)), timeoutMs); timer.unref(); }),
          ]).finally(() => clearTimeout(timer));
          if (result.exceptionDetails) {
            const detail = result.exceptionDetails;
            if (detail.exception?.description?.includes("harness 未加载") && attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
              continue;
            }
            throw new Error(detail.exception?.description ?? detail.text);
          }
          return result.result?.value;
        } catch (error) {
          if (/Execution context was destroyed|Cannot find context/i.test(String(error?.message)) && attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }
          throw error;
        }
      }
    },
    heap: () => Promise.resolve(-1),
  };
}

const pick = (m, keys) => Object.fromEntries(keys.map((key) => [key, m[key]]));
const KEYS = ["slots", "loadedTurns", "placeholders", "retainedChars", "domNodes", "mountedChars", "turns", "toolDetails", "timelines", "tables", "codeBlocks", "diffNodes", "distToBottom", "scrollTop", "scrollHeight", "horizontalOverflow", "pageRequests", "oldestIndex", "hasMore", "runningTurns", "failedTurns", "watermark"];

const child = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-stress-"))}`,
    "--window-size=1280,900",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
    ...(process.env.QAQH_GPU === "1" ? [] : ["--disable-gpu"]),
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
child.on("error", (error) => {
  console.error(`起不了浏览器(${EDGE}):${error.message}`);
  process.exit(1);
});

const out = { steps: [], diagnostics: [], perf: [] };
let activeCdp;
try {
  const wsUrl = await waitForTarget();
  const cdp = connect(wsUrl);
  activeCdp = cdp;
  await cdp.open;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Performance.enable").catch(() => {});
  out.environment = { browser: await cdp.send("Browser.getVersion"), gpuRequested: process.env.QAQH_GPU === "1", target: TARGET, recordedAt: new Date().toISOString() };
  await new Promise((resolve) => setTimeout(resolve, 3000)); // 让 vite 的首次 reload 落地

  /** 页内真实 JS 堆(--expose-gc + --enable-precise-memory-info 才有意义)。 */
  const heapMb = () =>
    cdp
      .evaluate(`(()=>{ const m = window.performance && performance.memory; if (!m) return -1; if (window.gc) gc(); return Math.round(m.usedJSHeapSize/1048576); })()`)
      .catch(() => -1);

  /** 只跑关心的步骤:QAQH_ONLY=progressStream node scripts/stress-cdp.mjs */
  const only = (process.env.QAQH_ONLY ?? "").split(",").filter(Boolean);
  const selected = (name) => only.length === 0 || only.some((prefix) => name.startsWith(prefix));

  /** 跑一步:页内表达式返回 {…场景字段, m: metrics},这里再挑出关心的键。 */
  const step = async (name, expression, timeoutMs = 90_000) => {
    if (!selected(name)) return undefined;
    const value = await cdp.evaluate(expression, timeoutMs);
    const heap = await heapMb();
    const metrics = value?.m ?? value ?? {};
    out.steps.push({ name, heapMb: heap, ...pick(metrics, KEYS), detail: value?.m ? { ...value, m: undefined } : value });
    console.log(`${name}: heap ${heap}MB, slots ${metrics.slots}, loaded ${metrics.loadedTurns}, placeholders ${metrics.placeholders}, retained ${metrics.retainedChars}, dom ${metrics.domNodes}`);
    if (name.startsWith("progressStream")) {
      console.log(`  ${name}: DOM 重写 ${value?.progressWrites} 次 / 喂 ${value?.fedChunks} 条, elapsed ${value?.elapsedMs}ms, 帧 p50 ${value?.cadence?.p50} max ${value?.cadence?.max} janks ${value?.cadence?.janks}, tail ${value?.tailChars}, churn ${JSON.stringify(value?.churn)}`);
    }
    if (name === "diffDrawer") {
      console.log(`  ${name}: ${value?.diffLines} 行 diff → DOM 仅 ${value?.virtualDomRows} 行 / 抽屉节点 ${value?.drawerDomNodes}, 中段可达 ${value?.middleRowReachable} 尾行 ${value?.tailVisible} 省略占位 ${value?.omittedMarkers}, 滚动帧 p50 ${value?.scrollCadence?.p50} max ${value?.scrollCadence?.max} janks ${value?.scrollCadence?.janks}`);
    }
    return value;
  };

  /** CDP 累计指标(Chrome 的 long-animation-frame 只报 >50ms 帧,量不出 8.3ms 预算)。 */
  const perfMap = async () => {
    const r = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
    return Object.fromEntries((r.metrics ?? []).map((item) => [item.name, item.value]));
  };
  const perfSample = async (label, expression, timeoutMs = 240_000) => {
    if (!selected(label)) return undefined;
    const before = await perfMap();
    const startedAt = Date.now();
    const detail = await cdp.evaluate(expression, timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    const after = await perfMap();
    if (!Object.keys(after).length) {
      out.perf.push({ label, elapsedMs, note: "Performance.getMetrics 不可用", names: Object.keys(before) });
      return detail;
    }
    if (!out.perfNames) out.perfNames = Object.keys(after);
    const deltaMs = (name) => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000 * 10) / 10;
    const frames = Math.max(1, detail?.cadence?.frames ?? Math.round(elapsedMs / (1000 / 60)));
    out.perf.push({
      label,
      elapsedMs,
      frames,
      layoutMs: deltaMs("LayoutDuration"),
      styleMs: deltaMs("RecalcStyleDuration"),
      scriptMs: deltaMs("ScriptDuration"),
      taskMs: deltaMs("TaskDuration"),
      perFrameLayoutMs: Math.round((deltaMs("LayoutDuration") / frames) * 100) / 100,
      perFrameStyleMs: Math.round((deltaMs("RecalcStyleDuration") / frames) * 100) / 100,
      perFrameScriptMs: Math.round((deltaMs("ScriptDuration") / frames) * 100) / 100,
      perFrameTotalMs: Math.round(((deltaMs("LayoutDuration") + deltaMs("RecalcStyleDuration") + deltaMs("ScriptDuration")) / frames) * 100) / 100,
      acted: detail?.acted,
    });
    const row = out.perf[out.perf.length - 1];
    console.log(`${label}: 每帧 layout ${row.perFrameLayoutMs}ms + style ${row.perFrameStyleMs}ms + script ${row.perFrameScriptMs}ms = ${row.perFrameTotalMs}ms (帧数 ${row.frames}, 动作 ${row.acted ?? "-"})`);
    return detail;
  };

  await step("boot", `(async()=>{ for (let i=0;i<120 && !window.__stress;i++) await new Promise(r=>setTimeout(r,100)); if (!window.__stress) throw new Error("harness 未加载: " + document.title + " | " + document.documentElement.outerHTML.slice(0,300)); for (let i=0;i<60 && !window.__stress.report.length;i++) await new Promise(r=>setTimeout(r,100)); const b=window.__stress.report[0]||{}; gc(); return { mountMs:b.mountMs, bootChurn:b.bootChurn, hidden:document.hidden, longTasks:b.longTasks, m:window.__stress.metrics() }; })()`);
  await step("stream", `window.__stress.scenarios.stream().then(r=>({thinkingCadence:r.thinkingCadence, answerCadence:r.answerCadence, paintCadence:r.paintCadence, churn:r.churn, m:r}))`);
  await perfSample("rate300", `window.__stress.scenarios.highRate(300, 6)`).then((detail) => { if (detail) out.steps.push({ name: "rate300", detail }); });
  await perfSample("rate900", `window.__stress.scenarios.highRate(900, 6)`).then((detail) => { if (detail) out.steps.push({ name: "rate900", detail }); });
  await step("checkpoint", `window.__stress.scenarios.checkpoint()`);
  await step("workCollapse", `window.__stress.scenarios.workCollapse()`);
  if (selected("workCollapseReduced")) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await step("workCollapseReduced", `window.__stress.scenarios.workCollapse()`);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }
  await step("thinking", `window.__stress.scenarios.thinking()`);
  await step("markdownCost", `window.__stress.scenarios.markdownCost()`);
  await step("progressStream:direct", `window.__stress.scenarios.progressStream("direct")`);
  await step("progressStream:merged", `window.__stress.scenarios.progressStream("merged")`);
  await step("progressSmall", `window.__stress.scenarios.progressStream("merged", 1)`);
  await step("ansiCost", `window.__stress.scenarios.ansiCost()`);
  await step("tableStream", `window.__stress.scenarios.tableStream()`);
  await step("realign", `window.__stress.scenarios.realign().then(r=>({churn:r.churn, before:r.before, after:r.after, m:r.after}))`);
  await step("expand", `window.__stress.scenarios.expand().then(r=>({clickedRows:r.clickedRows, timelines:r.timelines, clickedHeads:r.clickedHeads, scrollDeltaFromExpand:r.scrollDeltaFromExpand, m:r}))`);
  // 3000 行 diff 开抽屉 + 滚到中段:堆与 DOM 节点数由 step() 采样,后续 afterEvict/idle 抓残留。
  await step("diffDrawer", `Promise.resolve(window.__stress.scenarios.diffDrawer())`);

  // 动画帧成本(§10 的 C 项):对照组 → 折叠展开 → 工具详情 → 待办停靠
  await perfSample("control-idle-4s", `new Promise(r=>setTimeout(()=>r({acted:0}),4000))`);
  await perfSample("collapse-anim", `window.__stress.scenarios.animate("collapse", 8)`);
  await perfSample("tooldetail-anim", `window.__stress.scenarios.animate("tool", 4)`);
  await perfSample("tododock-anim", `window.__stress.scenarios.animate("dock", 8)`);
  await step("toTop", `window.__stress.scenarios.toTop().then(r=>({rounds:r.rounds, m:r}))`);
  await step("toBottom", `window.__stress.scenarios.toBottom().then(r=>({distAfterScroll:r.distAfterScroll, scrollSteps:r.scrollSteps, buttonVisible:r.buttonVisible, m:r}))`);
  await step("afterEvict", `(()=>{ gc(); return { m: window.__stress.metrics() }; })()`);
  await step("idle", `(async()=>{ await new Promise(r=>setTimeout(r,1500)); gc(); return { m: window.__stress.metrics() }; })()`);
  await step("layout", `Promise.resolve(window.__stress.scenarios.layout()).then(r=>({offenders:r.offenders, turnWidths:r.turnWidths, zeroHeightTurns:r.zeroHeightTurns, innerWidth:r.innerWidth, m:r}))`);

  out.diagnostics = diagnostics;
  if (process.env.QAQH_ASSERT === "1") {
    const failures = [];
    for (const { name, detail } of out.steps) {
      if (name.startsWith("rate") && (detail.lostChars !== 0 || !detail.renderedCorrect || detail.textIdentityLost || !detail.remainedCollapsed || detail.cadence.janks > 0)) failures.push(name);
      if ((name === "checkpoint" || name === "thinking") && !detail.correct) failures.push(name);
      if (name === "tableStream" && detail.tableRows !== 201) failures.push(name);
      if (name === "diffDrawer" && (!detail.middleRowReachable || !detail.tailVisible || detail.virtualDomRows > 140 || detail.collapsedCardRows > 3)) failures.push(name);
    }
    if (diagnostics.length) failures.push("browser diagnostics");
    out.assertions = { passed: failures.length === 0, failures };
    if (failures.length) throw new Error(`Stress regression: ${failures.join(", ")}`);
  }
  if (process.env.QAQH_REPORT) writeFileSync(process.env.QAQH_REPORT, JSON.stringify(out, null, 2));
  console.log("\n" + JSON.stringify(out, null, 1));
} finally {
  if (process.env.QAQH_REPORT) writeFileSync(process.env.QAQH_REPORT, JSON.stringify({ ...out, diagnostics }, null, 2));
  // Windows Edge may relaunch: killing the launcher alone leaves the isolated browser alive.
  let closeTimer;
  if (activeCdp) {
    await Promise.race([
      activeCdp.send("Browser.close").catch(() => {}),
      new Promise((resolve) => { closeTimer = setTimeout(resolve, 1000); }),
    ]).finally(() => clearTimeout(closeTimer));
  }
  activeCdp?.ws.close();
  await child.kill();
}
