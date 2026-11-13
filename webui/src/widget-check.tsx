/**
 * 本地 dev-only 视觉/交互验收：widget-directive C2（visualize 工具段 →
 * WidgetMount → host 沙箱 iframe；无 daemon 层，fragment 读取经 ctx.readFragment
 * 注入）。覆盖：结构化 args 挂载、§2 srcdoc+sandbox 装配、§3 桥往返
 * （setWidgetState→localStorage 快照、sendHeight→iframe 高、
 * sendFollowUpMessage→确认浮层→发送回调）、缺件降级。
 *
 * 断言面暴露在 window.__QQH_WIDGET_CHECK__（widget-check.mjs 经 CDP 读取）。
 */
import { render } from "@solidjs/web";
import { applyTheme } from "./lib/theme";
import { WidgetMount } from "./widget/WidgetMount";
import type { WidgetHostContext } from "./widget/host";
import type { ToolStep } from "./session/types";
import "./styles/app.css";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "dark" ? "dark" : "light");

const COUNTER_PATH = "D:/qaqh-check/.qaqh/widgets/SES-CHECK/counter.html";
const MISSING_PATH = "D:/qaqh-check/.qaqh/widgets/SES-CHECK/missing.html";

interface CheckEvent {
  kind: string;
  detail?: unknown;
}

const CHECK_EVENTS: CheckEvent[] = [];
Object.defineProperty(window, "__QQH_WIDGET_CHECK__", { value: CHECK_EVENTS });

/** 自触发 fragment：加载即写快照 + 发 follow-up，并支持手动 +1 复写。 */
const COUNTER_FRAGMENT = [
  '<div id="wc-counter" style="min-height:320px">',
  '  <button id="wc-plus" type="button">+1</button><span id="wc-count">0</span>',
  "</div>",
  "<script>",
  "(function(){",
  "  var root = document.getElementById('wc-counter');",
  "  var st = (window.qqh && window.qqh.widgetState && window.qqh.widgetState.modelContent) || { count: 0 };",
  "  var count = st.count | 0;",
  "  var out = document.getElementById('wc-count');",
  "  out.textContent = String(count);",
  "  document.getElementById('wc-plus').addEventListener('click', function(){",
  "    count += 1; out.textContent = String(count);",
  "    window.qqh.setWidgetState({ modelContent: { count: count } });",
  "  });",
  "  window.qqh.setWidgetState({ modelContent: { count: count, hello: 'wc' } });",
  "  window.qqh.sendFollowUpMessage({ prompt: 'widget count=' + count, title: 'widget-check 上报' });",
  "})();",
  "</" + "script>",
].join("\n");

const ctx: WidgetHostContext = {
  sessionId: "SES-CHECK",
  sendFollowUp: async (prompt, widget, modelContent) => {
    CHECK_EVENTS.push({ kind: "followUp", detail: { prompt, widget, modelContent } });
  },
  readFragment: async (path) => (path === COUNTER_PATH ? COUNTER_FRAGMENT : null),
};

/** C2 指令是结构化 tool 段：args 仅 path/title/mode，无 PUA。 */
const stepOf = (id: string, args: Record<string, unknown>): ToolStep => ({
  kind: "tool",
  id,
  seq: 0,
  name: "visualize",
  status: "finished",
  argsJson: JSON.stringify(args),
});

const CASES: { id: string; step: ToolStep }[] = [
  // 1) 合法 args → iframe 水合。
  { id: "case-block", step: stepOf("wc-block", { path: COUNTER_PATH, title: "计数器" }) },
  // 2) fragment 读取失败 → iframe 占位降级。
  { id: "case-missing", step: stepOf("wc-missing", { path: MISSING_PATH, title: "缺件" }) },
];

const App = () => (
  <main class="widget-check">
    <h1>widget-directive C2 验收</h1>
    {CASES.map(({ id, step }) => (
      <section id={id} class="widget-check-case">
        <div class="widget-check-note">{id}</div>
        <WidgetMount step={step} ctx={ctx} />
      </section>
    ))}
  </main>
);

render(App, document.getElementById("root")!);