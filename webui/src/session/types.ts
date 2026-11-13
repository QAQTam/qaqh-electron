/** 前端会话视图模型；结构与顺序事实只来自 Ringing v3 bootstrap 与事件流。 */
export type ReasoningKind = "summary" | "text" | "encrypted" | "redacted";

export type Seq = number;

export type TurnStatus = "running" | "done" | "aborted" | "failed";

export interface Turn {
  /** 后端 turn_id。注意 id 可能复用,稳定去重键见 `key`。 */
  id: string;
  /** Stable id from the input timeline entry while a turn id is not assigned. */
  inputId?: string | null;
  /**
   * 稳定键:快照/翻页回合用 `#turn_index`,实时回合(无全局序号)用 id。
   * 权威页一旦把序号对上这个回合,键**保持本地那个**(换键 = 换 DOM 行,
   * 正在流式的回合会闪断并丢滚动位置),序号记到 `turnIndex` 上。
   */
  key: string;
  /** 会话内全局序号;实时路径开出来的回合先为 null,由权威页补记(也是翻页游标)。 */
  turnIndex: number | null;
  /**
   * 回合主输入(用户那句话)。`blockId` 是喂它的那条 timeline input 条目 id——
   * **同回合再来的任何 input**(看门狗插话、用户 steer/排队)都不许顶掉它,
   * 只能另立插话条目,见 `InterjectionStep`。
   */
  user: { text: string; contentRef?: string; blockId?: string | null };
  /** 按 seq 升序(后端真相)。 */
  steps: Step[];
  /** 最终作答:最后一个文本块;运行中指向当前流式文本块,若其后又开了工具则回退为中间叙述。 */
  answer: { text: string; startedAt?: number } | null;
  /** answer 指向的 step id;用于作答开始后回退重分类。 */
  answerStepId: string | null;
  status: TurnStatus;
  phase?: import("../api/contract").TurnPhase;
  workStartedAt?: number;
  /**
   * 失败回合的后端事实。`code` 是现成 `TurnError.code`（如 `context_overflow`、
   * `handoff_missing`）：只用于把「需要人看一眼的失败」和一般失败分开呈现，
   * 正文永远直显后端 `message`，前端不编文案、更不静默重试。
   */
  error?: { message: string; code?: string };
  usage?: import("../api/contract").UsageInfo | null;
  /** 时间线里是否被用户展开。 */
  expanded: boolean;
  /** 仅供贴底触发;避免滚动 effect 订阅每个文本块。 */
  renderVersion?: number;
}

export interface ThinkingStep {
  kind: "thinking";
  id: string;
  seq: Seq;
  startedAt?: number;
  endedAt?: number;
  /** 完整思考文本,始终保留(spec §10.2)。 */
  text: string;
  contentRef?: string;
  /**
   * 思考类别(wire `TimelineBlock.reasoning_kind`)。订阅套餐路径只有 `summary`
   * ——服务端给的**摘要**,不是模型原文(完整思考在 `encrypted_content` 里,客户端
   * 拿不到)。标签决策见 `../turn/thinking-label`。
   * 缺失 = 后端未标注,或本块只收到 delta、还没等到时间线条目——两种都按「思考」显示,不猜。
   */
  reasoningKind?: ReasoningKind;
}

export interface TextStep {
  kind: "text";
  id: string;
  seq: Seq;
  startedAt?: number;
  endedAt?: number;
  text: string;
  contentRef?: string;
}

/** Renderer-only status derived from the canonical Ringing ToolCallState. */
export type ToolStatus =
  | "declared"
  | "awaiting_permission"
  | "running"
  | "cancelling"
  | "finished"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ToolOutput {
  text?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  /** Unified diff text found in the raw tool output. */
  diffText?: string;
}

/** Bounded raw stream window with monotonic offsets for terminal renderers. */
export interface ToolProgressStream {
  /** Exec session offsets count UTF-8 bytes; ordinary tool progress counts UTF-16 units. */
  offsetEncoding?: "utf8";
  /** Absolute offset of `data[0]` in the selected encoding (UTF-16 by default). */
  startOffset: number;
  /** Absolute offset immediately after the latest received character. */
  endOffset: number;
  /** Last 16 KiB of raw output; ANSI and control sequences are preserved. */
  data: string;
}

export interface ToolStep {
  kind: "tool";
  id: string;
  seq: Seq;
  startedAt?: number;
  endedAt?: number;
  name: string;
  /** 原始入参 JSON 串(MUST NOT 改写;展示层解析)。 */
  argsJson?: string;
  argsRef?: string;
  /** 内核从参数流里认出的目标文件（只有 `apply_patch` 出得来：它的参数里没有
   * 路径字段，文件只存在于 Codex 补丁文法里，文法唯一事实源是补丁引擎）。
   *  缺席/空 = 内核没认出来，不代表这次调用不改文件。 */
  targetFiles?: string[];
  /** 参数文本已吐完且形状合法。只用于渲染：执行与声明仍分别由后端决定。 */
  argsComplete?: boolean;
  status: ToolStatus;
  state?: import("../api/contract").ToolCallState;
  execSessionId?: string;
  execSessionState?: import("../api/contract").ExecSessionState;
  output?: ToolOutput;
  outputRef?: string;
  error?: string;
  /** Backend metrics. */
  elapsedMs?: number;
  /** v3 structured edit accounting; never presented as a unified diff. */
  codeDelta?: import("../api/contract").CodeDelta | null;
  effects?: import("../api/contract").ToolEffectInfo[];
}

export type Step = ThinkingStep | TextStep | ToolStep | InterjectionStep;

/**
 * 一条**插话**输入条目:同回合里除主输入以外的 timeline `input`。
 *
 * 后端把看门狗提醒/折叠提示也按普通输入条目落库(契约里 `purpose: "interject"`
 * + `actor.kind: "api"`),它不是"用户说的话"——按用户气泡渲染会把用户的原话
 * 顶掉,并让人以为用户自己发了一句系统提示。所以它进 steps 单独成行。
 */
export interface InterjectionStep {
  kind: "interject";
  /** timeline input 的 `block_id`(稳定键,重放同一条不产生第二行)。 */
  id: string;
  seq: Seq;
  startedAt?: number;
  /** 插话是一瞬间的事:与 startedAt 同值,只为让共用时长谓词的调用方不必特判。 */
  endedAt?: number;
  /** 现成 `InputPurpose` 原值(trigger_turn/queue_only/steer/interject)。 */
  purpose: string;
  /** 现成 `ActorKind` 原值(user/api/system/agent/subagent)。 */
  actorKind: string;
  /** `ActorRef.id`(看门狗是 `handoff-watchdog`)。 */
  actorId: string;
  /** `ActorRef.display_name`,没有就按 kind/id 推标签。 */
  actorName?: string | null;
  text: string;
  contentRef?: string;
  /**
   * 子代理终态通知(subagent-team 施工单 §三·1):runtime 陈述,不是子代理
   * 说的话——渲染成系统通知卡,不进聊天气泡;正文是含子级最终答复的摘要。
   */
  subagentTerminal?: { childSessionId: string; parentCallId: string | null; terminal: string } | null;
}

/** 用户等待区间(授权/AskUser),挂在其发生时正在运行的回合上。 */
export interface Wait {
  interactionId?: string;
  turnKey: string | null;
  kind: "approval" | "ask";
  from: number;
  to?: number;
}

/** 会话级归约状态(reducer 的操作对象;Solid store draft)。 */
export interface SessionState {
  turns: Record<string, Turn>;
  /** Session-level execution records survive turn pagination and late output. */
  execSessions: Record<string, import("../api/contract").ExecSessionView>;
  /** Lazily loaded source turns used by execution cards after transcript eviction. */
  originTurns: Record<string, import("../api/contract").SessionTurnSnapshot>;
  /** 渲染顺序槽:回合或(被淘汰回合的)等高占位。 */
  slots: Slot[];
  /** 结构提交版本。消息列表只订阅它,token 更新不重读所有槽位 key。 */
  structureVersion: number;
  serverEpoch: string | null;
  hasMore: boolean;
  truncatedBefore: boolean;
  /** 最旧已加载回合的全局序号(翻页游标,排他);null = 禁用翻页。 */
  oldestIndex: number | null;
  totalTurns: number;
  /** 当前正在流式输出的 reasoning 块 id。 */
  activeReasoningId: string | null;
  /** 该 reasoning 块所属回合 key:思考链只读这一个回合,不遍历 turns。 */
  activeReasoningTurnKey: string | null;
  /** 运行中的回合数(发送/授权判定的唯一依据,避免遍历 turns)。 */
  runningTurns: number;
  /** 失败回合数(标签状态点用,同样避免遍历 turns)。 */
  failedTurns: number;
  /** 当前运行中回合的 key;无运行中回合为 null(等待区间归属判定)。 */
  activeTurnKey: string | null;
  waits: Wait[];
  interactionIds: string[];
  watermark: number;
  compactionSummaries: string[];
  /**
   * 会话持久目标(ADR-0015)。wire 侧缺席 = 无 goal,本地归一成 null;
   * `goal_updated` 整字段替换,链根/当前会话双流按 updated_at_ms 幂等。
   */
  goal?: import("../api/contract").GoalView | null;
}

/**
 * 渲染顺序槽:回合,或**一段**连续被淘汰的回合。
 *
 * 占位为什么是一段而不是一格:被淘汰的回合永远是相邻前缀,一格一个占位会让
 * `slots` 随翻页无界增长(实测 201 槽里 151 是占位)——每次前插都要重写约 170 个
 * 下标节点、`<For>` 每次重排整表、DOM 里多挂 150 个空 div。并成一段后
 * `slots ≈ 窗口 + 1`。
 */
export type Slot = { kind: "turn"; key: string } | { kind: "gap"; key: string; spans: GapSpan[] };

/** 段内一个被淘汰回合的等高占位高度(逐回合钳过 2 屏,合并后不再重钳)。 */
export interface GapSpan {
  key: string;
  height: number;
}

export function gapHeight(spans: GapSpan[]): number {
  return spans.reduce((sum, span) => sum + span.height, 0);
}

/**
 * 时间线/折叠行的工作步骤谓词:作答以外的全部 step。被提升为最终作答的文本块
 * 已在作答区渲染,再进时间线就是同一段文字出现两遍(数据模型里 text 块要么是
 * 答案、要么是中间叙述,见本文件顶部的归约注释);answerStepId 为 null(运行中
 * 未提升/已降级)时全部文本块都按中间叙述算。插话条目不是工作步骤——它自己成行。
 */
export function isWorkStep(turn: Turn, step: Step): boolean {
  if (step.kind === "interject") return false;
  return step.kind !== "text" || step.id !== turn.answerStepId;
}

export function emptySession(): SessionState {

  return {
    turns: {},
    execSessions: {},
    originTurns: {},
    slots: [],
    structureVersion: 0,
    serverEpoch: null,
    hasMore: false,
    truncatedBefore: false,
    oldestIndex: null,
    totalTurns: 0,
    activeReasoningId: null,
    activeReasoningTurnKey: null,
    runningTurns: 0,
    failedTurns: 0,
    activeTurnKey: null,
    waits: [],
    interactionIds: [],
    watermark: 0,
    compactionSummaries: [],
    goal: null,
  };
}
