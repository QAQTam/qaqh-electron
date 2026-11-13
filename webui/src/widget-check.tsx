/**
 * 本地 dev-only 视觉/交互验收：widget-directive 全链路（无 daemon 层，
 * fragment 读取经 ctx.readFragment 注入）。
 *
 * 覆盖：§1 文法四态（block 挂载 / inline 吞 / JSON 坏降级 / unknown type 吞）、
 * §2 srcdoc+sandbox 装配、§3 桥往返（setWidgetState→localStorage 快照、
 * sendHeight→iframe 高、sendFollowUpMessage→确认浮层→发送回调）、降级占位。
 *
 * 断言面暴露在 window.__QQH_WIDGET_CHECK__（widget-check.mjs 经 CDP 读取）。
 */
import { render } from "@solidjs/web";
import { applyTheme } from "./lib/theme";
import { renderMarkdownHtml } from "./markdown/render";
import { hydrateWidgetMounts, type WidgetHostContext } from "./widget/host";
import "./styles/app.css";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "dark" ? "dark" : "light");

const OPEN = "\uE200";
const SPLIT = "\uE202";
const CLOSE = "\uE201";
const marker = (json: string): string => `${OPEN} visualize ${SPLIT}${json}${CLOSE}`;
const unknownMarker = (json: string): string => `${OPEN} doodle ${SPLIT}${json}${CLOSE}`;

const COUNTER_PATH = "D:\\qaqh-check\\.qaqh\\widgets\\SES-CHECK\\counter.html";
const MISSING_PATH = "D:\\qaqh-check\\.qaqh\\widgets\\SES-CHECK\\missing.html";

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

/** payload JSON：path 里的 `\` 要按 JSON 规则加倍（marker 原文给模型看的样子）。 */
function jsonOf(path: string, extra?: string): string {
  const esc = path.replace(/\\/g, "\\\\");
  return extra ? `{"path":"${esc}",${extra}}` : `{"path":"${esc}"}`;
}

const SOURCES: Record<string, string> = {
  // 1) block：marker 独占行 → iframe 水合。
  "case-block": `前置说明\n\n${marker(jsonOf(COUNTER_PATH, '"title":"计数器"'))}\n\n后置说明`,
  // 2) inline：同一行内 marker → 静默吞，前后文字保留。
  "case-inline": `甲${marker(jsonOf(COUNTER_PATH))}乙`,
  // 3) JSON 坏：降级一行占位。
  "case-badjson": marker("{not-json"),
  // 4) unknown type：吞。
  "case-unknown": unknownMarker(jsonOf(MISSING_PATH)),
  // 5) fragment 读取失败：iframe 占位降级。
  "case-missing": marker(jsonOf(MISSING_PATH, '"title":"缺件"')),
};

const App = () => (
  <main class="widget-check">
    <h1>widget-directive 验收</h1>
    {Object.entries(SOURCES).map(([id, source]) => (
      <section id={id} class="widget-check-case">
        <div class="widget-check-note">{id}</div>
        <div class="widget-check-body" ref={(el) => {
          el.innerHTML = renderMarkdownHtml(source);
          hydrateWidgetMounts(el, ctx);
        }} />
      </section>
    ))}
  </main>
);

render(App, document.getElementById("root")!);
