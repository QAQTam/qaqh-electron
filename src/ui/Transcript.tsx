// Transcript：turn 轨线 + round 折叠 + block 分派（spec §9）。
// turn key=turnId、block key=block_order；滚动跟随：距底<80px 才跟随，100ms 节流。
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Component } from "solid-js";
import type { TimelineBlock, RoundView, TurnView } from "qaqh-js-sdk";
import { MarkdownText, NoticeBar, ReasoningPanel, ToolCard, type BlockActions } from "./blocks";
import { bridge } from "../lib/bridge";

function openExternal(url: string): void {
  const b = bridge();
  if (b) void b.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text);
}

const actions: BlockActions = { openExternal, copyText };

// ── block 渲染分派 ──
const BlockView: Component<{ block: TimelineBlock }> = (props) => {
  const b = () => props.block;
  return (
    <Show
      when={b().kind === "text" || b().kind === "tool" || b().kind === "reasoning" || b().kind === "notice"}
      fallback={<NoticeBar level="warn" text={`未知 block 类型 ${b().kind}`} />}
    >
      <div class="block" data-block-order={b().block_order}>
        <Show
          when={b().kind === "text"}
          fallback={
            <Show
              when={b().kind === "reasoning"}
              fallback={
                <Show
                  when={b().kind === "tool" && b().tool}
                  fallback={<NoticeBar level="info" text={b().text ?? ""} />}
                >
                  <ToolCard tool={b().tool!} actions={actions} />
                </Show>
              }
            >
              <ReasoningPanel text={b().text ?? ""} />
            </Show>
          }
        >
          {/* 双渲染规则：open 纯文本，sealed markdown */}
          <Show when={b().state === "sealed"} fallback={<div class="block-text">{b().text}</div>}>
            <MarkdownText text={b().text ?? ""} actions={actions} />
          </Show>
        </Show>
      </div>
    </Show>
  );
};

// ── round 折叠容器（默认展开最后一轮） ──
const RoundBlock: Component<{ round: RoundView; isLast: boolean; turnFailed?: boolean }> = (props) => {
  // 折叠态：默认展开最后一轮（派生），用户手动切换后以用户为准
  const [userToggled, setUserToggled] = createSignal<boolean | null>(null);
  const expanded = createMemo(() => {
    const override = userToggled();
    if (override !== null) return override;
    return props.isLast; // 新轮追加时 isLast 自动变为 true → 展开
  });
  const r = () => props.round;
  return (
    <div class={["round", { final: r().isFinal }]}>
      <div class="round-header">
        <button class="round-btn" onClick={() => setUserToggled(!expanded())}>
          {expanded() ? "▾" : "▸"} round {r().roundNum}
          {r().isFinal ? " · final" : ""}
        </button>
      </div>
      <Show when={expanded()}>
        <For each={r().blocks}>{(block) => <BlockView block={block} />}</For>
      </Show>
    </div>
  );
};

// ── TurnNode ──
const TurnNode: Component<{ turn: TurnView }> = (props) => {
  const t = () => props.turn;
  const dotClass = () => {
    if (t().state === "running") return "running";
    if (t().state === "failed") return "failed";
    if (t().state === "cancelled") return "cancelled";
    return "completed";
  };
  return (
    <div class="turn">
      <div class="turn-rail">
        <div class={["turn-dot", dotClass()]} />
        <div class="turn-rail-line" />
      </div>
      <div class="turn-body">
        <div class="turn-user">
          <span class="you">YOU</span>
          {t().userText}
        </div>
        <Show when={t().state === "failed" && t().failure}>
          {(f) => <div class="turn-failed-note">✕ {f().code}: {f().message}</div>}
        </Show>
        <For each={t().rounds}>
          {(round, i) => {
            // i 是 accessor：包成 memo 再传（callback 体是非跟踪 owner）
            const isLast = createMemo(() => i() === t().rounds.length - 1);
            return <RoundBlock round={round} isLast={isLast()} />;
          }}
        </For>
        <Show when={t().state === "running" && t().rounds.length === 0}>
          <div class="round">
            <div class="round-header">
              <span>worker 启动中…</span>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

// ── Transcript 主组件 ──
export const Transcript: Component<{ turns: TurnView[] }> = (props) => {
  let scrollEl: HTMLDivElement | undefined;
  let stickToBottom = true;
  let lastFollow = 0;


  const onScroll = () => {
    if (!scrollEl) return;
    const now = Date.now();
    if (now - lastFollow < 100) return;
    lastFollow = now;
    const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    stickToBottom = dist < 80;
  };

  // 滚动跟随：turns 变化且贴底时跟随到底
  onSettled(() => {
    createScrollObserver();
  });

  function createScrollObserver() {
    // MutationObserver 监听内容高度变化（流式追加）
    if (!scrollEl) return;
    const obs = new MutationObserver(() => {
      if (stickToBottom && scrollEl) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    obs.observe(scrollEl, { childList: true, subtree: true, characterData: true });
  }

  const count = createMemo(() => props.turns.length);

  return (
    <div class="transcript" ref={scrollEl} onScroll={onScroll}>
      <Show when={count() > 0} fallback={<div class="inspector-empty">尚无回合 — 在下方输入开始对话</div>}>
        <For each={props.turns}>{(turn) => <TurnNode turn={turn} />}</For>
      </Show>
    </div>
  );
};
