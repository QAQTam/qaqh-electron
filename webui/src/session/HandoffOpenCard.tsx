/**
 * 开箱交接卡(B 侧)。
 *
 * 封箱侧有 HandoffCard(A 的"已封箱交接");内核把交接文档投成 B 的第一条输入
 * (ADR-016 切片 1)——原样渲染就是一堵 user 消息裸文本墙,观感与语义都错位。
 * 本卡把同一段文本换成结构化呈现:出处抬头 + Markdown 正文折叠 + 原文兜底。
 * 判据在 TurnView 的权威两源(HandoffSealed 事件 + 目录血缘字段),这里只管画。
 */
import { createSignal, Show, type Component } from "solid-js";
import { BoxOpen } from "../ui/box-anim";
import { OpenRitual } from "../ui/box-ritual";
import IconArrowUpRight from "~icons/lucide/arrow-up-right";
import { Markdown } from "../markdown/Markdown";
import { openSession } from "../tabs/store";

/** 出处抬头三件套:来源会话、工作简述(与后继会话标题同源)、封箱时刻。 */
export type HandoffOpenSource = { sessionId: string; workSummary: string; atMs: number };

function stampText(at: number): string {
  if (at <= 0) return "";
  try { return new Date(at).toLocaleString(); } catch { return ""; }
}

/** 刚送达窗口:只有开箱即时到达才播大盒仪式;翻旧会话回来只看抬头小动画。 */
const OPEN_RITUAL_WINDOW_MS = 12_000;

export const HandoffOpenCard: Component<{ doc: string; source: HandoffOpenSource }> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [raw, setRaw] = createSignal(false);
  // 挂载时刻定格(同 A 侧 fresh 纪律):切 tab 重挂不回播仪式。
  const [ritual, setRitual] = createSignal(props.source.atMs > 0 && Date.now() - props.source.atMs < OPEN_RITUAL_WINDOW_MS);
  const summary = () => props.source.workSummary.replace(/\s+/g, " ").trim();
  const openSource = (): void => { void openSession(props.source.sessionId); };
  return (
    <article class="handoff-open">
      <Show when={ritual()}><OpenRitual onDone={() => setRitual(false)} /></Show>
      <header class="handoff-open-head">
        <span class="handoff-open-icon" aria-hidden="true"><BoxOpen /></span>
        <div class="handoff-open-titles">
          <strong>开箱交接</strong>
          <Show when={summary() !== ""}>
            <span class="handoff-open-summary">{summary()}</span>
          </Show>
          <span class="handoff-open-meta">
            封箱于 {stampText(props.source.atMs)} · 来源会话 <code title={props.source.sessionId}>{props.source.sessionId.slice(0, 12)}…</code>
            <button type="button" class="handoff-open-jump" onClick={openSource} title="打开封箱侧会话 A">
              <IconArrowUpRight /> 去源头
            </button>
          </span>
        </div>
      </header>
      <div class={`handoff-open-body${expanded() ? "" : " clipped"}`}>
        <Show
          when={raw()}
          fallback={<Markdown text={() => props.doc} streaming={false} />}
        >
          <pre class="handoff-open-raw">{props.doc}</pre>
        </Show>
      </div>
      <footer class="handoff-open-foot">
        <button type="button" class="ghost-mini" onClick={() => setExpanded((v) => !v)}>
          {expanded() ? "收起文档" : "展开全文"}
        </button>
        <button type="button" class="ghost-mini" onClick={() => setRaw((v) => !v)}>
          {raw() ? "渲染视图" : "查看原文"}
        </button>
      </footer>
    </article>
  );
};
