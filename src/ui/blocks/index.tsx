// blocks：MarkdownText / ReasoningPanel / ToolCard / NoticeBar（spec §9）。
// 双渲染规则：block state==='open' 纯文本流式追加（pre-wrap 无 markdown）；
// sealed 后切换 markdown 渲染。key 用 block_order。
import { For, Show, createSignal, onSettled } from "solid-js";
import type { Component } from "solid-js";
import type { TimelineBlock } from "qaqh-js-sdk";
import { renderMarkdown } from "../../lib/markdown";
import { parseDiff } from "../../lib/diff";

export interface BlockActions {
  openExternal: (url: string) => void;
  copyText: (text: string) => void;
}

// ── MarkdownText（sealed 内容专用） ──
export const MarkdownText: Component<{ text: string; actions: BlockActions }> = (props) => {
  let el!: HTMLDivElement;
  onSettled(() => {
    void props;
  });
  // render 指令式：ref 阶段渲染一次；文本变化由父级重新创建节点（sealed 不可变）
  const attach = (node: HTMLDivElement) => {
    el = node;
    renderMarkdown(
      el,
      props.text,
      (url) => props.actions.openExternal(url),
      (code) => props.actions.copyText(code),
    );
  };
  return <div class="md" ref={attach} />;
};

// ── ReasoningPanel（折叠，摘要"思考 N.Ns"） ──
export const ReasoningPanel: Component<{ text: string; secs?: number }> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="reasoning">
      <button class="reasoning-header" onClick={() => setOpen(!open())}>
        <span class={["chevron", { open: open() }]}>▶</span>
        <span>思考{props.secs !== undefined ? ` ${props.secs.toFixed(1)}s` : ""}</span>
      </button>
      <Show when={open()}>
        <div class="reasoning-body">{props.text}</div>
      </Show>
    </div>
  );
};

// ── ToolCard（横卡：name · summary；展开 = args JSON + output + diff） ──
export const ToolCard: Component<{ tool: NonNullable<TimelineBlock["tool"]>; actions: BlockActions }> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const tool = () => props.tool;
  const stateOf = () => tool().state;
  const isBg = () => tool().state === "succeeded" && false; // backgrounded 指示位：结果层 status 判定，预留

  let argsObj: unknown;
  const argsRaw = tool().args_json ?? "";
  try {
    argsObj = argsRaw ? JSON.parse(argsRaw) : null;
  } catch {
    argsObj = null;
  }
  const argsPretty = argsObj !== null ? JSON.stringify(argsObj, null, 2) : argsRaw;
  const summary =
    tool().summary ||
    (argsRaw ? argsPretty.slice(0, 80).replace(/\s+/g, " ") : "");

  return (
    <div class="toolcard">
      <button class="toolcard-head" onClick={() => setExpanded(!expanded())}>
        <span class={["tool-badge", stateOf()]}>{stateOf()}</span>
        <span class="tool-name">{tool().name}</span>
        <span class="tool-summary">{summary}</span>
        <Show when={isBg()}>
          <span class="tool-bg-indicator" title="后台运行，结果稍后回流">⏏</span>
        </Show>
        <span class="chevron" style={{ "font-size": "9px", color: "var(--text-3)", transform: expanded() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }}>
          ▶
        </span>
      </button>
      <Show when={expanded()}>
        <div class="toolcard-body">
          <Show when={argsPretty}>
            <div>
              <div class="tool-label">args</div>
              <div class="tool-args">{argsPretty}</div>
            </div>
          </Show>
          <Show when={tool().diff}>
            <div>
              <div class="tool-label">diff</div>
              <div class="diff">
                <For each={parseDiff(tool().diff!)}>
                  {(l) => <div class={["diff-line", l.kind]}>{l.text || " "}</div>}
                </For>
              </div>
            </div>
          </Show>
          <Show when={tool().output}>
            <div>
              <div class="tool-label">output</div>
              <div class="tool-output">{tool().output}</div>
            </div>
          </Show>
          <Show when={tool().failure}>
            {(f) => (
              <div class="tool-output" style={{ color: "var(--danger)" }}>
                {f().code}: {f().message}
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
};

// ── NoticeBar ──
export const NoticeBar: Component<{ level?: string; text: string }> = (props) => (
  <div class={["notice", props.level === "warn" || props.level === "error" ? props.level : ""]}>
    <span class="notice-level">{props.level ?? "info"}</span>
    <span>{props.text}</span>
  </div>
);
