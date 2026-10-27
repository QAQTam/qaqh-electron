/** 同一文本块只挂载一个 Markdown。工作段在回复边界关闭,后续工作不重开旧段。 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, Switch, Match, untrack, type Accessor, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconChevronRight from "~icons/lucide/chevron-right";
import { Collapse } from "../ui/Collapse";
import { Markdown } from "../markdown/Markdown";
import { currentModel, planActive } from "../composer/model-config";
import { AssistantContent } from "../genui/AssistantContent";
import { StepRow } from "../tools/StepRow";
import { TurnDeliverablesCard } from "../diff/TurnDeliverablesCard";
import { STR, formatWorkDuration } from "../lib/strings";
import { workDurationMs } from "../lib/time";
import type { SessionStore } from "../session/store";
import type { Step, Turn, Wait } from "../session/types";
import { turnSegments, type TurnSegment, type WorkSegment } from "./segments";
import { thinkingLabel, thinkingRichSummary, thinkingTitle } from "./thinking-label";
import { sessionCatalog } from "../tabs/store";

const WorkStep: Component<{ step: Accessor<Step>; turn: Turn; cwd?: string | null; isLatest?: boolean }> = (props) => {
  const thinking = createMemo(() => { const step = props.step(); return step.kind === "thinking" ? step : null; });
  // 套餐路径的思考是服务端摘要而非模型原文:标签必须分开(见 ./thinking-label)。
  const thinkingText = () => thinkingLabel(thinking()?.reasoningKind);
  const thinkingHint = () => thinkingTitle(thinking()?.reasoningKind);
  // 套餐(OAuth) + GPT 家族:摘要是 markdown,默认展开直读,不再折叠(特判见 ./thinking-label)。
  const thinkingRich = () => thinkingRichSummary(planActive(), currentModel());
  const thinkingRunning = () => props.turn.status === "running" && thinking()?.endedAt == null;
  const tool = createMemo(() => { const step = props.step(); return step.kind === "tool" ? step : null; });
  const [thinkingOverride, setThinkingOverride] = createSignal<boolean | null>(null);
  const thinkingOpen = () => thinkingOverride() ?? (thinking() != null && (thinkingRich() || thinkingRunning()));
  let thinkingRow: HTMLDivElement | undefined;
  let following = true;
  let frame: number | null = null;
  let resizeObserver: ResizeObserver | undefined;

  const followTail = (): void => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const scroller = thinkingRow?.querySelector<HTMLDivElement>(".thinking-full");
      if (following && scroller?.isConnected) scroller.scrollTop = scroller.scrollHeight;
    });
  };
  createEffect(
    () => [thinkingOpen(), thinking()?.text] as const,
    ([open]) => { if (open) followTail(); },
  );
  onCleanup(() => {
    if (frame != null) cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
  });
  return (
    <Switch>
      <Match when={thinking() != null}>
        <div class="timeline-row thinking" ref={(node) => {
          thinkingRow = node;
          resizeObserver = new ResizeObserver(followTail);
          resizeObserver.observe(node);
        }}>
          <button type="button" class="timeline-label" title={thinkingHint()} aria-expanded={thinkingOpen() ? "true" : "false"} onClick={() => {
            following = true;
            setThinkingOverride(!thinkingOpen());
          }}>{thinkingText()}</button>
          <Collapse open={thinkingOpen()} instant={thinkingOverride() == null}>
            <div class={{ "thinking-full": true, "thinking-md": thinkingRich() }} tabindex={0} role="region" aria-label={thinkingText()}
              onScroll={(event) => {
                const el = event.currentTarget;
                // Layout/resize can also emit scroll events; only user input
                // suspends following, while reaching the bottom resumes it.
                if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) following = true;
              }}
              onWheel={(event) => { if (event.deltaY < 0) following = false; }}
              onPointerDown={() => { following = false; }}
              onTouchStart={() => { following = false; }}
              onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) following = false; }}
            >
              <Show
                when={thinkingRich()}
                fallback={thinking()?.text}
              >
                {/* 摘要是 markdown:走流式渲染;revision 用步 id,checkpoint 整块替换时重画。 */}
                <Markdown text={() => thinking()?.text ?? ""} revision={thinking()?.id} streaming={thinkingRunning()} />
              </Show>
            </div>
          </Collapse>
        </div>
      </Match>
      <Match when={tool() != null}><StepRow step={tool()!} turn={props.turn} cwd={props.cwd} isLatest={props.isLatest} /></Match>
    </Switch>
  );
};

const DURATION_CACHE_PREFIX = "qaqh.duration.";

function cacheWorkDuration(turnKey: string, workKey: string, duration: number): void {
  try {
    if (duration > 0) localStorage.setItem(`${DURATION_CACHE_PREFIX}${turnKey}.${workKey}`, String(duration));
  } catch {}
}

function getCachedWorkDuration(turnKey: string, workKey: string): number | undefined {
  try {
    const raw = localStorage.getItem(`${DURATION_CACHE_PREFIX}${turnKey}.${workKey}`);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {}
  return undefined;
}

const WorkGroup: Component<{ group: WorkSegment; turn: Turn; waits: Wait[]; cwd?: string | null; latestToolStepId?: string | null }> = (props) => {
  const [override, setOverride] = createSignal<boolean | null>(null);
  // 回复边界自动收起一次;之后用户仍可展开这个已完成工作段。
  let wasClosed = untrack(() => props.group.closed);
  createEffect(() => props.group.closed, (closed) => {
    if (closed && !wasClosed) setOverride(null);
    wasClosed = closed;
  });
  const open = () => override() ?? !props.group.closed;
  const groups = createMemo(() => {
    const steps = props.group.steps;
    return untrack(() => Array.from({ length: Math.ceil(steps.length / 8) }, (_, index) => ({ key: steps[index * 8]!.id, steps: steps.slice(index * 8, index * 8 + 8) })));
  }, { name: "work.structure" });
  const waits = createMemo(() => {
    const start = props.group.steps[0]?.startedAt ?? props.turn.workStartedAt ?? 0;
    return props.waits.filter((wait) => wait.from >= start && wait.from < (props.group.until ?? Infinity));
  });
  const label = () => {
    const steps = props.group.steps;
    const start = steps[0]?.startedAt ?? props.turn.workStartedAt;
    const end = props.group.until ?? steps[steps.length - 1]?.endedAt;
    let duration = workDurationMs(start, end, waits());

    // 防御自愈：若当前段已关闭，实时算出了有效耗时，则写入持久账本；
    // 若因刷新/快照重建丢失了时间戳导致算出的 duration 为空或 0，则从本地账本回填！
    if (props.group.closed) {
      if (duration != null && duration > 0) {
        cacheWorkDuration(props.turn.key, props.group.key, duration);
      } else {
        const cached = getCachedWorkDuration(props.turn.key, props.group.key);
        if (cached != null) duration = cached;
      }
    }

    const text = duration == null ? "" : formatWorkDuration(duration);
    if (props.turn.status === "failed") return STR.failedWorked(text);
    if (props.turn.status === "aborted") return STR.interruptedWorked(text);
    return props.group.closed ? STR.worked(text) : "正在工作";
  };
  return (
    <div class="work-group" data-work-key={props.group.key}>
      <button type="button" class="collapsed-row" aria-expanded={open() ? "true" : "false"} onClick={() => setOverride(!open())}>
        <Show when={open()} fallback={<IconChevronRight />}><IconChevronDown /></Show><span>{label()}</span>
      </button>
      {/* 回复边界的自动收起也播放回收动画；历史闭合段初次挂载仍不挂详情。 */}
      <Collapse open={open()}>
        <div class="timeline turn-steps">
          <For each={groups()} keyed={(group) => group.key}>{(group) => <div class="work-step-group"><For each={group().steps} keyed={(step) => step.id}>{(step) => <WorkStep step={step} turn={props.turn} cwd={props.cwd} isLatest={props.latestToolStepId != null && step().id === props.latestToolStepId} />}</For></div>}</For>
          <For each={waits()}>{(wait) => <div class="timeline-row wait"><span class="timeline-label">{wait.kind === "approval" ? STR.waitApproval(formatWorkDuration(Math.max(0, (wait.to ?? wait.from) - wait.from))) : STR.waitAnswer(formatWorkDuration(Math.max(0, (wait.to ?? wait.from) - wait.from)))}</span></div>}</For>
        </div>
      </Collapse>
    </div>
  );
};

const SegmentView: Component<{ segment: Accessor<TurnSegment>; turn: Turn; waits: Wait[]; cwd?: string | null; latestToolStepId?: string | null; onFollowUp?: (text: string) => void }> = (props) => {
  const work = createMemo(() => { const segment = props.segment(); return segment.kind === "work" ? segment : null; });
  const text = createMemo(() => { const segment = props.segment(); return segment.kind === "text" ? segment.step : null; });
  return (
    <Switch>
      <Match when={work() != null}><WorkGroup group={work()!} turn={props.turn} waits={props.waits} cwd={props.cwd} latestToolStepId={props.latestToolStepId} /></Match>
      <Match when={text() != null}>
        <div data-text-id={text()!.id} class={{ "turn-answer": text()!.id === props.turn.answerStepId, "turn-intermediate": text()!.id !== props.turn.answerStepId }}>
          <AssistantContent
            text={() => text()!.text}
            revision={text()!.id}
            streaming={props.turn.status === "running" && text()!.endedAt == null}
            onFollowUp={props.onFollowUp}
          />
        </div>
      </Match>
    </Switch>
  );
};

export const TurnView: Component<{ turn: Turn; waits: Wait[]; store: SessionStore; isLatestTurn?: boolean }> = (props) => {
  const cwd = createMemo(() => sessionCatalog().find((session) => session.session_id === props.store.seed)?.cwd);
  const isLatestTurn = createMemo(() => {
    if (props.isLatestTurn !== undefined) return props.isLatestTurn;
    if (!props.store) return true;
    const slots = props.store.state[0].slots;
    for (let i = slots.length - 1; i >= 0; i--) {
      if (slots[i]?.kind === "turn") return slots[i]!.key === props.turn.key;
    }
    return true;
  });
  const latestToolStepId = createMemo(() => {
    if (!isLatestTurn()) return null;
    const steps = props.turn.steps;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.kind === "tool") return steps[i]!.id;
    }
    return null;
  });
  const segments = createMemo(() => {
    const steps = props.turn.steps;
    steps.length;
    const terminal = props.turn.status !== "running";
    return untrack(() => turnSegments(steps, terminal));
  }, { name: "turn.structure" });
  return (
    <section class="turn">
      <div class="turn-user"><div class="bubble">{props.turn.user.text}</div></div>
      <For each={segments()} keyed={(segment) => segment.key}>{(segment) => <SegmentView segment={segment} turn={props.turn} waits={props.waits} cwd={cwd()} latestToolStepId={latestToolStepId()} onFollowUp={(text) => void props.store.sendMessage(text)} />}</For>
      <Show when={props.turn.status === "aborted" && props.turn.steps.length === 0}><div class="turn-aborted">{STR.interrupted}</div></Show>
      <Show when={props.turn.status === "failed" && props.turn.error != null}><div class="turn-error">{props.turn.error!.message}</div></Show>
      {/* 只在回合密封后挂载:运行中每帧都要重扫全部工具步做指纹聚合,
          而且列到一半的文件清单读起来像是「本回合最终交付」,实际是过程态。 */}
      <Show when={props.turn.status !== "running"}>
        <TurnDeliverablesCard turn={props.turn} sessionId={props.store.seed} cwd={cwd()} />
      </Show>
    </section>
  );
};
