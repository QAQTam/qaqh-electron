/** 同一文本块只挂载一个 Markdown。工作段在回复边界关闭,后续工作不重开旧段。 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, Switch, Match, untrack, type Accessor, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconHandoff from "~icons/lucide/package-check";
import IconFork from "~icons/lucide/git-fork";
import IconSiren from "~icons/lucide/siren";
import { Collapse } from "../ui/Collapse";
import { Markdown } from "../markdown/Markdown";
import { AssistantContent } from "../genui/AssistantContent";
import { StepRow } from "../tools/StepRow";
import { TurnDeliverablesCard } from "../diff/TurnDeliverablesCard";
import { STR, formatWorkDuration } from "../lib/strings";
import { workDurationMs } from "../lib/time";
import type { SessionStore } from "../session/store";
import { HANDOFF_FATAL_CODES, handoffFactOfTurn, type HandoffFact } from "../session/handoff";
import { forkRecordOfFact } from "../session/handoff-journal";
import type { InterjectionStep, Step, Turn, Wait } from "../session/types";
import { turnSegments, workSegmentEnd, type TurnSegment, type WorkSegment } from "./segments";
import { interjectionHint, interjectionLabel, isSystemInterjection } from "./interjection";
import { thinkingLabel, thinkingRichSummary, thinkingTitle } from "./thinking-label";
import { forkHandoffSession, sessionCatalog } from "../tabs/store";

const WorkStep: Component<{ step: Accessor<Step>; turn: Turn; thinkingRich: () => boolean; cwd?: string | null; isLatest?: boolean }> = (props) => {
  const thinking = createMemo(() => { const step = props.step(); return step.kind === "thinking" ? step : null; });
  // 套餐路径的思考是服务端摘要而非模型原文:标签必须分开(见 ./thinking-label)。
  const thinkingText = () => thinkingLabel(thinking()?.reasoningKind);
  const thinkingHint = () => thinkingTitle(thinking()?.reasoningKind);
  // 套餐(OAuth) + GPT 家族:摘要是 markdown,默认展开直读,不再折叠(特判见 ./thinking-label)。
  const thinkingRunning = () => props.turn.status === "running" && thinking()?.endedAt == null;
  const tool = createMemo(() => { const step = props.step(); return step.kind === "tool" ? step : null; });
  const [thinkingOverride, setThinkingOverride] = createSignal<boolean | null>(null);
  const thinkingOpen = () => thinkingOverride() ?? (thinking() != null && (props.thinkingRich() || thinkingRunning()));
  createEffect(
    () => [props.turn.status, thinking()?.endedAt] as const,
    ([status, endedAt]) => {
      if (status !== "running" && endedAt != null) setThinkingOverride(null);
    },
  );
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
            <div class={{ "thinking-full": true, "thinking-md": props.thinkingRich() }} tabindex={0} role="region" aria-label={thinkingText()}
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
                when={props.thinkingRich()}
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

const WorkGroup: Component<{ group: WorkSegment; turn: Turn; waits: Wait[]; thinkingRich: () => boolean; cwd?: string | null; latestToolStepId?: string | null }> = (props) => {
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
    const end = workSegmentEnd(props.group);
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
          <For each={groups()} keyed={(group) => group.key}>{(group) => <div class="work-step-group"><For each={group().steps} keyed={(step) => step.id}>{(step) => <WorkStep step={step} turn={props.turn} thinkingRich={props.thinkingRich} cwd={props.cwd} isLatest={props.latestToolStepId != null && step().id === props.latestToolStepId} />}</For></div>}</For>
          <For each={waits().filter((wait) => wait.kind !== "approval")}>{(wait) => <div class="timeline-row wait"><span class="timeline-label">{STR.waitAnswer(formatWorkDuration(Math.max(0, (wait.to ?? wait.from) - wait.from)))}</span></div>}</For>
        </div>
      </Collapse>
    </div>
  );
};

/**
 * 一条插话条目(看门狗提醒 / 折叠提示 / 用户同回合的转向与排队输入)。
 *
 * 系统侧的那份**必须**长成"系统插话"而不是用户气泡:后端把它按普通 input 落库
 * (`purpose:"interject"` + `actor.kind:"api"`),渲染成用户的话就等于让用户
 * 看起来自己发了一句系统提示,还会把用户原话顶掉(归约见 `session/reducer`)。
 */
const InterjectRow: Component<{ step: InterjectionStep; contentStatus: Record<string, "loading" | "ready" | "failed">; retryContent: () => void }> = (props) => {
  const system = () => isSystemInterjection(props.step);
  const pending = () => props.step.contentRef != null && props.step.text === "";
  return (
    <div class={{ "interject-row": true, "is-system": system(), "is-user": !system() }} data-interject-id={props.step.id}>
      <span class="interject-icon" aria-hidden="true">{system() ? <IconSiren /> : <IconChevronRight />}</span>
      <div class="interject-body">
        <span class="interject-label" title={interjectionHint(props.step)}>{interjectionLabel(props.step)}</span>
        <Show when={pending()} fallback={<p class="interject-text">{props.step.text}</p>}>
          <Show when={props.step.contentRef != null && props.contentStatus[props.step.contentRef] === "failed"}
            fallback={<p class="interject-text muted" role="status">正文加载中…</p>}>
            <button type="button" class="content-placeholder retry" onClick={() => props.retryContent()}>正文加载失败，重试</button>
          </Show>
        </Show>
      </div>
    </div>
  );
};

/** 挂载时刻距封箱在此窗口内才播「刚封箱」动画:历史重放(重开/滚动重挂)不播。 */
const FRESH_SEAL_WINDOW_MS = 10_000;
/** 卡片上的自动继续倒计时:到期即 fork + 跳转,可取消(打前端包即热补丁生效)。 */
const AUTO_CONTINUE_MS = 10_000;

/**
 * 回合尾部的交接卡 —— §五 那个必须有的产品层兜底。
 *
 * `(b)` 方案的代价:后端不会自动开 B。客户端关掉/掉线时 A 就停在 `completed`,
 * 交接文档躺在存档里没人接。这条常驻入口把同一份数据(权威在 A 的 timeline 与
 * `tool_calls.args_json`,离线也能重建)接回三条现成命令。
 *
 * `handoff_path` 刻意**不显示**:那只是本地镜像 `.md`,不是 URL、也不是权威副本,
 * 摆出来只会被当成可下载的链接(§二)。
 */
const HandoffCard: Component<{ fact: HandoffFact; sessionId: string; sealedAt: number | null; isLatest: boolean }> = (props) => {
  const [docOpen, setDocOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // 「刚封箱」在挂载那一刻定格(读一次,不进响应式):daemon 与前端同机,封箱
  // 时间戳可以直接比对;之后翻回这条历史不重播动画。
  const fresh = props.sealedAt != null && Date.now() - props.sealedAt < FRESH_SEAL_WINDOW_MS;
  // 在飞标记必须是**普通变量**:本仓的 Solid 在 root 外写信号不会同步可读
  // (见 `session/handoff-journal` 同款说明),连点两下若只靠信号就会双双通过守卫,
  // 而"同一交接只 fork 一次"正是这条守卫要挡的事。
  let inFlight = false;
  // 账本是本地权威:fork 完立刻变「已在新会话继续」,不给第二次点击开第二条会话的机会。
  const record = () => forkRecordOfFact(props.fact);
  // 倒计时武装在挂载那一刻定格:刚封箱(fresh)或本会话最新一条交接卡才自动;
  // 更早的历史卡保持人工入口——重开客户端时不会对着陈年交接成批点火。
  // 已交付的交接不再武装。
  const armed = (fresh || props.isLatest) && record()?.delivered !== true;
  const totalSeconds = AUTO_CONTINUE_MS / 1000;
  const [remaining, setRemaining] = createSignal<number | null>(armed ? totalSeconds : null);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  const stopCountdown = (): void => {
    if (countdownTimer != null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    setRemaining(null);
  };
  const percent = () => {
    const used = props.fact.contextUsedTokens;
    const window = props.fact.contextWindowTokens;
    if (used == null || window == null || window <= 0) return null;
    return `${Math.round((used / window) * 100)}%（${used} / ${window} tokens）`;
  };
  const continueHandoff = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    setBusy(true);
    try { await forkHandoffSession(props.sessionId, props.fact); } finally {
      inFlight = false;
      setBusy(false);
    }
  };
  if (armed) {
    countdownTimer = setInterval(() => {
      const next = (remaining() ?? 0) - 1;
      if (next <= 0) {
        stopCountdown();
        void continueHandoff();
      } else {
        setRemaining(next);
      }
    }, 1000);
  }
  // fork 落账(实时路径的立即 fork / 到期自动 fork)即停表:账本 revision 是响应的,
  // delivered 翻真那一刻这里就会停,不给「到期再拽一次」留缝。
  createEffect(
    () => record()?.delivered === true,
    (delivered) => { if (delivered) stopCountdown(); },
  );
  onCleanup(stopCountdown);
  return (
    <div class={{ "handoff-card": true, "is-fresh": fresh, "is-busy": busy() }} data-handoff-turn={props.fact.turnId}>
      <div class="handoff-head">
        <span class="handoff-icon" aria-hidden="true"><IconHandoff /></span>
        <div class="handoff-title-wrap">
          <strong>{STR.handoffSealed}</strong>
          <small>{STR.handoffSealedHint}</small>
        </div>
        <Show when={percent() != null}>
          <span class="handoff-occupancy">{STR.handoffOccupancy(percent()!)}</span>
        </Show>
      </div>
      <Show when={props.fact.workSummary !== ""}>
        <p class="handoff-summary"><span class="handoff-summary-label">{STR.handoffWorkSummary}：</span>{props.fact.workSummary}</p>
      </Show>
      <p class="handoff-meta">
        <IconFork aria-hidden="true" />
        {STR.handoffModifiedFiles(props.fact.modifiedFiles.length)}
      </p>
      {/* 机器面(handed_off)整段没读出来时,这条事实来自推断:入口照给,但出处标出来。 */}
      <Show when={props.fact.inferred}>
        <p class="handoff-meta">{STR.handoffInferredNote}</p>
      </Show>
      <Show when={remaining() != null}>
        <div class="handoff-countdown" role="timer">
          <div class="handoff-countdown-track" aria-hidden="true">
            <div class="handoff-countdown-bar" style={{ width: `${(Math.max(0, remaining() ?? 0) / totalSeconds) * 100}%` }} />
          </div>
          <span class="handoff-countdown-label">{STR.handoffCountdown(remaining() ?? 0)}</span>
          <button type="button" class="handoff-countdown-cancel" onClick={stopCountdown}>{STR.handoffCountdownCancel}</button>
        </div>
      </Show>
      <div class="handoff-actions">
        <Show when={record()?.delivered === true} fallback={
          <button type="button" class="handoff-continue" disabled={busy()} onClick={() => void continueHandoff()}>
            {record() != null ? STR.handoffRetryDelivery : STR.handoffContinue}
          </button>
        }>
          <button type="button" class="handoff-opened" onClick={() => void continueHandoff()}>{STR.handoffOpenChild}</button>
        </Show>
        <button type="button" class="handoff-doc-toggle" aria-expanded={docOpen() ? "true" : "false"} onClick={() => setDocOpen(!docOpen())}>
          {docOpen() ? STR.handoffHideDoc : STR.handoffViewDoc}
          <Show when={docOpen()} fallback={<IconChevronRight />}><IconChevronDown /></Show>
        </button>
      </div>
      <Show when={record() != null && record()!.delivered === false}>
        <p class="handoff-warn">{STR.handoffDeliveredPartial}</p>
      </Show>
      <Collapse open={docOpen()}>
        {/* 交接文档本体(模型亲手写的那份、args 里的结构化字段)。只在这里渲染,
            工具行默认折叠不回显整段 JSON。 */}
        <div class="handoff-doc" tabindex={0} role="region" aria-label={STR.handoffViewDoc}>
          <Markdown text={() => props.fact.handoffDoc} revision={props.fact.callId} streaming={false} />
        </div>
      </Collapse>
    </div>
  );
};

const SegmentView: Component<{ segment: Accessor<TurnSegment>; turn: Turn; waits: Wait[]; thinkingRich: () => boolean; cwd?: string | null; latestToolStepId?: string | null; onFollowUp?: (text: string) => void; contentStatus?: Record<string, "loading" | "ready" | "failed">; retryContent?: () => void }> = (props) => {
  const work = createMemo(() => { const segment = props.segment(); return segment.kind === "work" ? segment : null; });
  const text = createMemo(() => { const segment = props.segment(); return segment.kind === "text" ? segment.step : null; });
  const interject = createMemo(() => { const segment = props.segment(); return segment.kind === "interject" ? segment.step : null; });
  return (
    <Switch>
      <Match when={work() != null}><WorkGroup group={work()!} turn={props.turn} waits={props.waits} thinkingRich={props.thinkingRich} cwd={props.cwd} latestToolStepId={props.latestToolStepId} /></Match>
      <Match when={interject() != null}>
        <InterjectRow step={interject()!} contentStatus={props.contentStatus ?? {}} retryContent={() => props.retryContent?.()} />
      </Match>
      <Match when={text() != null}>
        <div data-text-id={text()!.id} class={{ "turn-answer": text()!.id === props.turn.answerStepId, "turn-intermediate": text()!.id !== props.turn.answerStepId }}>
          <AssistantContent
            text={() => text()!.contentRef && !text()!.text
              ? props.contentStatus?.[text()!.contentRef!] === "failed" ? "正文加载失败，请重试正文" : "正文加载中…"
              : text()!.text}
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
  // 思考摘要的富呈现按**本会话有效**的 provider/model 判定：会话可以把模型
  // 覆写成与全局不同的值，拿全局那一份会把别的会话的模型算到这条回合上。
  const thinkingRich = () =>
    thinkingRichSummary(
      props.store.composerProfile[0]().providerKind === "plan",
      props.store.composerModel[0]() ?? "",
    );
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
  /**
   * 交接事实:判据只有 `tool_name === "handoff"` 且结果里 `handed_off:true`
   * (见 `session/handoff` 的取舍说明)。回合尾部的卡是常驻入口——
   * 客户端掉线/关掉时 A 就停在 completed,这条是唯一接得回 B 的地方。
   */
  const handoff = createMemo(() => handoffFactOfTurn(props.turn, props.store.seed), { name: "turn.handoff" });
  // 封箱发生时刻(工具步 endedAt,daemon 与前端同机):给交接卡「刚封箱」动画定 fresh。
  const sealedAtOf = (fact: HandoffFact): number | null => {
    const step = props.turn.steps.find((item) => item.kind === "tool" && item.id === fact.callId);
    return step?.endedAt ?? null;
  };
  const fatalErrorCode = () => {
    const code = props.turn.error?.code;
    return code != null && (HANDOFF_FATAL_CODES as readonly string[]).includes(code) ? code : null;
  };
  /**
   * 空气泡只在「这一回合已经有插话条目、但用户主输入还没到」时藏起来:那种
   * 气泡读起来像用户发了一条空消息。附件-only 的消息(text 为空但有附件)照旧
   * 挂气泡——那条轨道本仓还没渲染附件,不能顺手把它变成"什么都没有"。
   */
  const hasInterjection = createMemo(() => props.turn.steps.some((step) => step.kind === "interject"));
  const showUserBubble = () => props.turn.user.text !== ""
    || props.turn.user.contentRef != null
    || !hasInterjection();
  return (
    <section class="turn">
      <Show when={showUserBubble()}>
        <div class="turn-user"><div class="bubble">
          <Show when={props.turn.user.contentRef && !props.turn.user.text} fallback={props.turn.user.text}>
            <Show when={props.store.contentStatus[0]()[props.turn.user.contentRef!] === "failed"} fallback={<span class="content-placeholder" role="status">正文加载中…</span>}>
              <button type="button" class="content-placeholder retry" onClick={() => props.store.retryContent()}>正文加载失败，重试</button>
            </Show>
          </Show>
        </div></div>
      </Show>
      <For each={segments()} keyed={(segment) => segment.key}>{(segment) => <SegmentView segment={segment} turn={props.turn} waits={props.waits} thinkingRich={thinkingRich} cwd={cwd()} latestToolStepId={latestToolStepId()} contentStatus={props.store.contentStatus[0]()} retryContent={() => props.store.retryContent()} onFollowUp={(text) => void props.store.sendMessage(text)} />}</For>
      <Show when={props.turn.status === "aborted" && props.turn.steps.length === 0}><div class="turn-aborted">{STR.interrupted}</div></Show>
      <Show when={props.turn.status === "failed" && props.turn.error != null}>
        <div class={{ "turn-error": true, "turn-error-noteworthy": fatalErrorCode() != null }}>
          <Show when={fatalErrorCode() != null}>
            {/* 错误正文一律直显后端 message;code 只是让人认得出这是哪一类失败
                (`handoff_missing` / `context_overflow` 都在现成 `TurnError.code` 里)。 */}
            <code class="turn-error-code">{fatalErrorCode()}</code>
          </Show>
          <p>{props.turn.error!.message}</p>
          {/* `handoff_missing` = 腾过一次位、模型仍不写交接文档 → 回合终止。
              这类失败需要人看一眼,前端不静默重试(重试也只会再撞同一堵墙)。 */}
          <Show when={props.turn.error?.code === "handoff_missing"}>
            <small class="turn-error-hint">{STR.handoffMissingHint}</small>
          </Show>
        </div>
      </Show>
      <Show when={handoff()}>
        {(fact) => <HandoffCard fact={fact()} sessionId={props.store.seed} sealedAt={sealedAtOf(fact())} isLatest={isLatestTurn()} />}
      </Show>
      {/* 只在回合密封后挂载:运行中每帧都要重扫全部工具步做指纹聚合,
          而且列到一半的文件清单读起来像是「本回合最终交付」,实际是过程态。 */}
      <Show when={props.turn.status !== "running"}>
        <TurnDeliverablesCard turn={props.turn} sessionId={props.store.seed} cwd={cwd()} />
      </Show>
    </section>
  );
};
