/**
 * 一个标签页 = 一个会话的客户端状态机。
 *
 * 宿主契约(webui-tauri):所有 per-seed 面(命令/审批/RPC/timeline 流/快照)
 * 经 Rust 宿主的类型化 IPC 转发,宿主维护「单一 active seed 持流」(plan D4);
 * 切标签 = attach(宿主切 active + 重建流)+ 快照重建(权威对齐)。后台标签
 * 不收流,状态由标签页轮询 sessions 列表(turn_count/running,后端事实)驱动
 * 状态点。重连/退避/续传责任在宿主(qaqh-client),前端不再有 SSE 循环。
 *
 * 数据单源:transcript 结构/文本只来自 timeline(宿主转发的快照+SSE 帧,
 * `watermark` 去重 + 缺口触发快照);审批只来自 approvals RPC(投影事件仅当
 * 刷新信号);自动标题由 v2 Meta SSE 推送,会话目录与运行态由 sessions 列表对齐。
 */
import { createSignal, createStore } from "solid-js";
import { transport, tauriHost, type ApprovalView, type StreamHandlers, type TimelineStatusWire, type TodoItemWire } from "../lib/transport";
import { now } from "../lib/time";
import { onConfigChanged } from "../lib/config-events";
import { applyEntry, applySnapshot, emptySession, forceSealTurn, prependPage } from "./reducer";
import { evictForWindow, fillGapHeights } from "./pagination";
import type { SessionState, TimelineEntryWire, Wait } from "./types";
import { normalizeActivity, projectionActions, readProjection, type SessionActivity } from "./projection";
import { compactedAnchor, reduceCompact, type CompactState } from "./compact";
import type { ConfigDto } from "../api/qaqh/ConfigDto";
import type { ContentRef } from "../api/qaqh/ContentRef";
import type { UsageInfo } from "../api/qaqh/UsageInfo";

export type ConnectionKind = "connected" | "reconnecting" | "offline";

/**
 * 压缩的展示态机在 `./compact`(纯函数,带线上样本单测);这里只负责把它接到
 * 投影事件上。命令 ack 只做乐观 running,`compaction_applied` 事实与
 * `compact_finished` 事件都能独立收口——两种来源都能收敛。
 */
export type { CompactState } from "./compact";

/**
 * 待发附件。`id` 是宿主回传的绝对路径——只作本地键,**从不进任何命令**;
 * 发送时带出去的是上传换回来的 `reference`。
 */
export interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  state: "uploading" | "ready" | "failed";
  reference: ContentRef | null;
  error: string | null;
}

/** 路径末段;上传前的占位名(上传完成后用宿主回的真名)。 */
function attachmentName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export interface ComposerMetrics {
  /** Last-turn completion throughput; tokens come from provider usage when available. */
  tokensPerSecond: number | null;
  /** 是否当前正处于模型增量流式生成中。 */
  isStreaming?: boolean;
  contextPercent: number | null;
  /**
   * 百分比的分母本身(`config.load().contextLength`)。
   *
   * 必须和百分比一起发布:分子(usage.prompt_tokens)本身看不出「按多少算的」,
   * 分母不露脸时「上下文怎么才 1%」只能靠猜(实际是配置里写着 1,000,000)。
   * null = 还没读到。
   */
  contextWindow: number | null;
  cacheHitPercent: number | null;
  /** 上一轮端点回的原生 usage 整数项(`credit` 等未建模字段);没有就是空对象。 */
  extras: Record<string, number>;
}

/** 吞吐滑动窗口长度:窗口内的模型增量决定瞬时 tok/s。 */
const STREAM_WINDOW_MS = 1200;
/** 超过这个间隔没有新的模型增量,就不算「正在吐字」(工具执行、子进程、网络停顿)。 */
const STREAM_IDLE_MS = 1200;

/** 轻量、快速、零外部依赖的 token 粗估器 (按 CJK / 拉丁字符特性平滑加权)。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLen = text.length - cjkCount;
  const cjkTokens = cjkCount * 0.75;
  const nonCjkTokens = nonCjkLen / 3.8;
  return Math.max(1, Math.round(cjkTokens + nonCjkTokens));
}

/**
 * 输入区 profile 选择器的视图(spec §1.5)。
 *
 * 三份来源拼一个数,各自都不能单独当真相:
 *  - `selected` 来自 `session.meta` 的 `profile`(会话级,落 meta.json);
 *  - `catalog`/`activeProfile` 来自全局 `config.load`;
 *  - `model` **只能从全局扁平值推**:`ConfigDto` 只下发活跃 profile 的 model,
 *    名录里别的 profile 不带它。所以选了这个会话专属的 profile 时 `model` 为
 *    null,由 UI 留空而不是拿 `SessionMeta.model`(建会话那一刻的快照,
 *    `reload_config` 不回写它)冒充生效值。
 */
export interface SessionProfileView {
  selected: string | null;
  /** 全局 `active_profile`:「跟随全局」这一项实际会用到谁。 */
  activeProfile: string | null;
  effective: string | null;
  model: string | null;
  catalog: string[];
}

/** `session.meta` 条目(`SessionListEntry`,`meta` 字段在 wire 上是平铺的)。 */
type SessionMetaWire = { profile?: string | null };
/** `config.load` 里与 profile 选择器有关的三个字段。 */
type ConfigProfileView = { activeProfile: string; model: string; profiles: string[] };

function cacheHitPercent(usage: UsageInfo): number | null {
  if (usage.cache_usage_reported !== true) return null;
  const total = usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens;
  return total > 0 ? (usage.prompt_cache_hit_tokens / total) * 100 : null;
}

/** 一帧之内攒下来的同一种增量(按「种类 + 回合 + 块 + 流」归并)。 */
interface PendingFragment {
  turnId: string;
  blockId: string;
  /** `text_delta` 的累积文本,或 `tool_progress` 的累积输出。 */
  fragments: Array<{ seq: number; text: string }>;
  truncated: boolean;
  /** 已消费到的 seq(取批次里最大的那个)。 */
  seq: number;
  progress: boolean;
  /** `tool_progress` 的进度流标识("stdout" | "stderr" | null);text_delta 恒为 null。 */
  stream: string | null;
}

/** timeline 快照窗口页大小;向上翻页页大小(spec §14.2 limit=30)。 */
const SNAPSHOT_LIMIT = 50;
const PAGE_LIMIT = 30;
/** 缺口触发快照校正的最小间隔(防抖,高吞吐下不连环拉全量)。 */
const RESNAPSHOT_DEBOUNCE_MS = 2_000;
/** 压缩终态卡(done/skipped)自动退场的延时;failed 不退,留待用户处理。 */
const COMPACT_CARD_TTL_MS = 8_000;

/**
 * 压缩命令**没送达**时的本地原因。
 *
 * 命令被 reject / IPC 抛错意味着 daemon 侧不会发 `CompactFinished`,线上 reason
 * 永远不会到;不在这里合成一句话,卡片就只剩「压缩失败」四个字,用户无从判断
 * 是"没连上"还是"压缩本身出错"。
 */
function compactDeliveryFailure(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error ?? "")).trim();
  return detail === ""
    ? "压缩请求未能送达 daemon，请检查连接后重试。"
    : `压缩请求未能送达 daemon（${detail}），请检查连接后重试。`;
}
/**
 * 取消看门狗:`conversation_cancel` 发出后,超过此时长仍未见 `turn_finished` /
 * `turn_interrupted`,就本地强制收口(BUG-2026-10-15:后端工具卡死时 turn 状态机
 * 到不了终态,前端三症状——stopping 常亮/无法重发/蓝点常亮——全是它的投影)。
 * 兜底只修界面,后端孤儿工具由 T2 的宽限期收割解决。
 */
const CANCEL_WATCHDOG_MS = 10_000;
export { CANCEL_WATCHDOG_MS };

export class SessionStore {
  readonly seed: string;
  readonly state: [SessionState, (fn: (draft: SessionState) => void) => void];

  connection = createSignal<ConnectionKind>("reconnecting");
  activity = createSignal<SessionActivity | null>(null);
  composerMetrics = createSignal<ComposerMetrics>({ tokensPerSecond: null, isStreaming: false, contextPercent: null, contextWindow: null, cacheHitPercent: null, extras: {} });
  composerProfile = createSignal<SessionProfileView>({ selected: null, activeProfile: null, effective: null, model: null, catalog: [] });
  title = createSignal<string | null>(null);
  pending = createSignal<ApprovalView[]>([]);
  todos = createSignal<TodoItemWire[]>([]);
  loadError = createSignal(false);
  hasNewReply = createSignal(false);
  /** 乐观发送中状态：点击发送即刻置 true 消除时差空窗，首个事件到达或结束时置 false。 */
  isSending = createSignal(false);
  /** 「此前已压缩」分隔锚点回合 key;null = 渲染在顶部。 */
  compactedAfter = createSignal<string | null>(null);
  /** 压缩进行态与流式摘要(见 `CompactState`);idle 时 HUD 只显示百分比。 */
  compact = createSignal<CompactState>({ phase: "idle" });
  /** 上一次 `compaction_applied` 的 checkpoint;同值重复投影不重锚分隔线。 */
  private compactedCheckpoint: string | null = null;
  /** 终态卡自动退场定时器;任何后续压缩状态都会先撤掉。 */
  private compactTimer: number | null = null;
  /** 取消看门狗定时器;真实终态 delta / 新回合 / dispose 都会先撤掉。 */
  private cancelWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** 待发附件;上传成功前不允许发送(命令里只能出现 `ContentRef`)。 */
  pendingAttachments = createSignal<PendingAttachment[]>([]);
  loadingOlder = createSignal(false);

  /**
   * 标签层注入的回调:本会话的元数据变了(标题/归档),去重拉 sessions 列表。
   * meta 频道只有已 attach 的会话才有流,后台会话的变更仍要等列表重拉。
   */
  onSessionsChanged: (() => void) | null = null;
  /** 标签层注入的回调：v2 MetaDelta::TitleChanged 到达时就地更新侧栏标题。 */
  onSessionTitleChanged: ((title: string) => void) | null = null;
  /** 标签层注入的回调:`MetaDelta::Deleted` 是权威终态,目录项与标签一起收掉。 */
  onSessionDeleted: (() => void) | null = null;

  /** 宿主事件反订阅。 */
  private hostUnlisten: (() => void) | null = null;
  /**
   * 帧内合并的高频增量(`text_delta` 与 `tool_progress`)。逐条写store 的代价有两层:
   * 每帧 N 次通知,以及 `tool_progress` 每次都要重做一遍 16KB 尾窗切片
   * (O(条数 × 16KB) 的字符串复制)。实测 400 个 chunk:合并前 2014ms。
   */
  private pendingFragments = new Map<string, PendingFragment>();
  /**
   * 已消费(立即应用,或进了 delta 缓冲)到的最大 seq。store 的 `watermark` 要等
   * 缓冲提交才推进,所以缺口判定必须看这个更高的值 —— 否则同一批里的第二条
   * delta 就会被当成缺口丢掉(夹具实测:连续喂 78 条只落地 10 条,文本每 2s 跳一次)。
   */
  private consumedSeq = 0;
  private rafHandle: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResnapshotAt = 0;
  private resnapshotTimer: number | null = null;
  private waitFrom: { kind: Wait["kind"]; at: number } | null = null;
  private lastTurnCount: number | null = null;
  private disposed = false;
  private todoRefresh: Promise<void> | null = null;
  private todoRefreshPending = false;
  private activeTurnStartedAt: number | null = null;
  /**
   * 本回合**正在产出模型 token** 的块 id:text(答案)与 reasoning(思考)都算。
   * 工具块不在里面——它吃的是宿主/子进程的钟,不是模型的吐字速率。
   */
  private activeModelBlockIds = new Set<string>();
  private activeOutputStartedAt: number | null = null;
  private activeOutputEndedAt: number | null = null;
  /** 最后一次模型增量到达时刻;超过 `STREAM_IDLE_MS` 没动静即视为没在吐字。 */
  private lastModelDeltaAt: number | null = null;
  /**
   * 本回合「模型确实在产出」的累计毫秒。相邻增量间隔在 `STREAM_IDLE_MS` 内才累加,
   * 工具执行与网络停顿的那段被跳过——`updateComposerUsage` 的速率分母用它,
   * 否则「已完成检查 30 秒再写两行」会被算成模型很慢。
   */
  private activeOutputActiveMs = 0;
  private contextRefreshId = 0;
  /** 分母:最近一次 `config.load` 读到的窗口。 */
  private contextLength: number | null = null;
  /** `session.meta.profile`(会话级选择);null = 跟随全局 `active_profile`。 */
  private metaProfile: string | null = null;
  /** 最近一次 `config.load` 的 profile 面:名录 + 活跃项 + 活跃项的 model。 */
  private configProfile: ConfigProfileView | null = null;
  private profileRefreshId = 0;
  /** 分子:上一轮服务端 usage 的 `prompt_tokens`,即真正发出去的上下文。 */
  private measuredContextTokens: number | null = null;
  /** 流式吐字滑动窗口(最近 1200ms 内到达的 delta token 采样)。 */
  private activeStreamWindow: Array<{ at: number; tokens: number }> = [];
  /** 当前轮次当前流式输出的累积估算 token 数。 */
  private activeStreamTokens = 0;
  /** 配置广播的退订函数(见 `lib/config-events`)。 */
  private unsubscribeConfig: (() => void) | null = null;

  constructor(seed: string) {
    this.seed = seed;
    // `name`:归因(attribution/diagnostics)里这条 store 的节点标成 `session.<key>`,
    // 否则热路径上的 memo 只能靠调用栈认。
    this.state = createStore<SessionState>(emptySession(), { name: "session" });
    // 配置写口都不在本 store(设置页 / 接入页 / 输入区模型卡片),而 daemon 不推
    // config-changed:靠 `notifyConfigChanged()` 广播。不订阅的话,设置页把「上下文
    // 窗口」改完再点保存,百分比仍按旧分母算,要等**下一轮结束**(`refreshConfigView`
    // 只挂在 attach 与 turn 边界)才纠正——"分母不是我刚设的值"就是这么来的。
    this.unsubscribeConfig = onConfigChanged(() => {
      void this.refreshConfigView();
    });
  }

  private get stateGet(): SessionState {
    return this.state[0];
  }

  private mutate(fn: (draft: SessionState) => void): void {
    this.state[1](fn);
  }

  private host(): NonNullable<ReturnType<typeof tauriHost>> {
    const host = tauriHost(transport);
    if (host == null) throw new Error("宿主传输后端不可用(应在 Tauri 壳内运行)");
    return host;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** 成为活动标签:先订阅宿主事件(attach 发出的 timeline://status 事件不丢),
   *  再 attach——宿主取的权威首页会作为 `timeline://snapshot` 推回来,所以这里
   *  不再自己补一次 `resnapshot()`(那等于一次 attach 传两页、整表重建两遍)。 */
  async activate(): Promise<void> {
    if (this.disposed) return;
    this.hasNewReply[1](false);
    await this.connectHost();
    await transport.attach(this.seed, SNAPSHOT_LIMIT);
    void this.refreshApprovals();
    void this.refreshTodos();
    void this.refreshActivity();
    void this.refreshConfigView();
    void this.refreshProfile();
  }

  /** 失去活动资格(别的标签接管):退订宿主事件保状态(流由宿主在新 attach 时停)。 */
  deactivate(): void {
    this.closeHost();
    this.setConnection("reconnecting");
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
    this.clearCancelWatchdog();
    this.closeHost();
    // 退订后还挂在队列里的 rAF 回调会带着已废弃标签的缓冲写进 store(一次性悬挂,
    // 不是泄漏级问题,但关掉它就不用解释它)。
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.pendingFragments.clear();
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.resnapshotTimer != null) {
      clearTimeout(this.resnapshotTimer);
      this.resnapshotTimer = null;
    }
  }

  retry(): void {
    // 重连/退避在宿主侧,这里只触发宿主重建流(用户点「重试」/窗口聚焦)。
    this.setConnection("reconnecting");
    this.host()
      .streamsRetry(this.seed)
      .catch(() => this.setConnection("offline"));
  }

  private setConnection(kind: ConnectionKind): void {
    this.connection[1](kind);
  }

  private closeHost(): void {
    this.hostUnlisten?.();
    this.hostUnlisten = null;
  }

  // ── 宿主事件订阅(timeline://*, projection://*) ─────────────────────────────

  private async connectHost(): Promise<void> {
    if (this.disposed) return;
    this.closeHost();
    this.setConnection("reconnecting");
    const handlers: StreamHandlers = {
      onTimelineEntry: (seed, entry) => {
        if (seed === this.seed) this.onTimelineEntry(entry as TimelineEntryWire);
      },
      onTimelineStatus: (status) => {
        this.applyTimelineStatus(status);
      },
      onProjectionEvent: (seed, envelope) => {
        if (seed !== this.seed) return;
        this.applyProjection(envelope.stream_key as Record<string, any> | undefined, envelope.payload as Record<string, any> | undefined);
      },
      onProjectionReset: (seed) => {
        if (seed !== this.seed) return;
        // 宿主的 v2 流会自动以 snapshot cursor 重订阅;这里刷新派生信号即可。
        this.onSessionsChanged?.();
        void this.refreshApprovals();
        void this.refreshTodos();
        void this.refreshActivity();
      },
      onTimelineSnapshot: (page) => {
        // attach 的权威首页与宿主侧缺口恢复都走这里(前端不再自己补拉首页)。
        if (page.session_id != null && page.session_id !== this.seed) return;
        this.mutate((draft) => {
          applySnapshot(draft, page);
        });
        this.rebaseConsumed(page.snapshot?.watermark ?? 0);
        this.loadError[1](false);
      },
      onIncompatible: () => {},
      onHostError: () => {},
    };
    try {
      this.hostUnlisten = await this.host().subscribe(handlers);
    } catch {
      this.setConnection("offline");
      return;
    }
    // 兜底事件竞态:宿主可能在订阅完成前已发出 open(Tauri 事件不保留给晚到
    // 订阅者),订阅成功后主动查询一次宿主侧当前状态对齐。
    try {
      const status = await this.host().timelineStatus(this.seed);
      if (status != null) this.applyTimelineStatus(status);
    } catch {
      // best-effort:后续 status 事件仍会持续驱动。
    }
  }

  /** timeline 流状态 → connection 信号(其他 seed 的状态忽略)。 */
  private applyTimelineStatus(status: TimelineStatusWire): void {
    if (status.session_id != null && status.session_id !== this.seed) return;
    if (status.status === "open") {
      const reconnected = this.connection[0]() !== "connected";
      this.setConnection("connected");
      if (reconnected) void this.refreshTodos();
    } else if (status.status === "closed") {
      this.setConnection("offline");
    } else {
      this.setConnection("reconnecting");
    }
  }

  private onTimelineEntry(entry: TimelineEntryWire): void {
    if (typeof entry?.timeline_seq !== "number" || !entry.turn_id) return;
    if (this.isSending[0]()) this.isSending[1](false);
    // 「已经知道到哪」要同时看已提交的水位和已消费的 seq:delta 进缓冲时不写水位。
    const known = Math.max(this.stateGet.watermark, this.consumedSeq);
    if (entry.timeline_seq <= known) return; // 重复(重放)直接丢弃(幂等)
    if (entry.timeline_seq > known + 1 && known > 0) {
      // seq 缺口:丢弃该事件并触发一次快照校正(spec §15.2)。校正按 2s 防抖,
      // 且回合槽按 key 挂载 → 重建只更新数据,不再拆掉整屏 DOM。
      this.scheduleResnapshot();
      return;
    }
    const event = entry.event;
    if (event.type === "block_opened" && (event.block.kind === "text" || event.block.kind === "reasoning")) {
      this.activeModelBlockIds.add(event.block.block_id);
    } else if (event.type === "text_delta" && this.activeModelBlockIds.has(event.block_id)) {
      const at = now();
      this.activeOutputStartedAt ??= at;
      this.activeOutputEndedAt = at;
      // 只累加「模型在产出」的区间;工具执行/网络停顿那段不计入速率分母。
      if (this.lastModelDeltaAt != null && at - this.lastModelDeltaAt <= STREAM_IDLE_MS) {
        this.activeOutputActiveMs += at - this.lastModelDeltaAt;
      }
      this.lastModelDeltaAt = at;
      const tokens = estimateTokens(event.delta);
      this.activeStreamTokens += tokens;
      this.activeStreamWindow.push({ at, tokens });
      const cutoff = at - STREAM_WINDOW_MS;
      while (this.activeStreamWindow.length > 0 && this.activeStreamWindow[0]!.at < cutoff) {
        this.activeStreamWindow.shift();
      }
    } else if (event.type === "block_opened" && event.block.kind === "tool") {
      // 工具块一开就停表:模型不再产出,而 tool_progress 不是吐字。少了这一步,
      // 无进度流的工具(read/write/grep)期间根本不会有 flush 去调 updateLiveMetrics,
      // 脉冲点会一直亮着谎报「正在吐字」。
      this.composerMetrics[1]((current) => (current.isStreaming ? { ...current, isStreaming: false } : current));
    } else if (event.type === "turn_sealed") {
      this.activeModelBlockIds.clear();
      this.activeStreamWindow = [];
      this.composerMetrics[1]((current) => ({ ...current, isStreaming: false }));
    }
    if (event.type === "text_delta" || event.type === "tool_progress") {
      // 高频增量按「种类 + 块」归并到帧末再写一次(spec §6/§10.2):每帧至多一次
      // store 写入,16KB 尾窗切片也一帧只做一遍。
      const progress = event.type === "tool_progress";
      const blockId = event.block_id;
      const piece = event.type === "tool_progress" ? event.chunk : event.delta;
      // `truncated` 只有 tool_progress 带(text_delta 无此槽)。
      const truncated = event.type === "tool_progress" && event.truncated === true;
      // 进度流是归并桶的一部分:stdout 与 stderr 不能在帧内被并成一段伪交织,
      // 否则 reducer 就再也分不开(09-18 契约 §5.1)。
      const stream = progress ? event.stream ?? null : null;
      const key = `${progress ? "p" : "t"}\u0000${entry.turn_id}\u0000${blockId}\u0000${stream ?? ""}`;
      const buffered = this.pendingFragments.get(key);
      if (buffered) {
        buffered.fragments.push({ seq: entry.timeline_seq, text: piece });
        buffered.truncated = buffered.truncated || truncated;
        buffered.seq = Math.max(buffered.seq, entry.timeline_seq);
      } else {
        this.pendingFragments.set(key, { turnId: entry.turn_id, blockId, fragments: [{ seq: entry.timeline_seq, text: piece }], truncated, seq: entry.timeline_seq, progress, stream });
      }
      this.consumedSeq = Math.max(this.consumedSeq, entry.timeline_seq);
      this.scheduleFlush();
    } else {
      // 流中 usage 采样（瞬态、~1s 节流）：温和路径只同步官方分子/缓存命中，
      // 不清流窗口、不改 tok/s、不灭脉冲——结算语义仍归 block seal / 回合终态。
      if (event.type === "usage_sampled") this.applyUsageSampled(event.usage);
      this.mutate((draft) => {
        // 结构事件是顺序屏障:同一事务先落地较早的增量,不能用更高水位吞掉它们。
        this.flushFragmentsInto(draft);
        applyEntry(draft, entry);
        draft.watermark = entry.timeline_seq;
      });
      this.consumedSeq = Math.max(this.consumedSeq, entry.timeline_seq);
    }
  }

  private scheduleFlush(): void {
    if (this.rafHandle != null) return;
    const commit = (): void => {
      if (this.rafHandle != null) globalThis.cancelAnimationFrame?.(this.rafHandle);
      this.rafHandle = null;
      if (this.flushTimer != null) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      if (this.pendingFragments.size === 0) return;
      this.mutate((draft) => this.flushFragmentsInto(draft));
      this.updateLiveMetrics();
    };
    this.rafHandle = requestAnimationFrame(commit);
    // 窗口被遮挡时 Chromium 可暂停 rAF;后台仍提交数据,不无限积累片段。
    this.flushTimer = setTimeout(commit, 100);
  }

  private flushFragmentsInto(draft: SessionState): void {
    let maxSeq = draft.watermark;
    for (const item of this.pendingFragments.values()) {
      // 权威快照可能只覆盖合并批次的一部分;只追加水位之后的片段。
      if (item.seq <= draft.watermark) continue;
      const text = item.fragments.filter((part) => part.seq > draft.watermark).map((part) => part.text).join("");
      applyEntry(draft, {
        timeline_seq: item.seq,
        turn_id: item.turnId,
        event: item.progress
          ? { type: "tool_progress", block_id: item.blockId, chunk: text, truncated: item.truncated, stream: item.stream }
          // 合并后块内片段号不再有意义;顺序真相是 timeline_seq。
          : { type: "text_delta", block_id: item.blockId, fragment_seq: 0, delta: text },
      });
      maxSeq = Math.max(maxSeq, item.seq);
    }
    // 所有块提交完再推进水位,避免跨块合并批次互相覆盖。
    draft.watermark = maxSeq;
    this.pendingFragments.clear();
    if (this.rafHandle != null) globalThis.cancelAnimationFrame?.(this.rafHandle);
    this.rafHandle = null;
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * 权威快照落地后重基线消费指针:快照覆盖到 `pageWatermark`,缓冲里比它更新的
   * delta 仍然要保留(那部分文本快照里没有)。这里按快照重设而不是取历史最大值
   * —— 换 epoch 后 seq 可能从更小的数重新开始。
   */
  private rebaseConsumed(pageWatermark: number): void {
    // 取 max 而不是直接重设:这一页可能被 applySnapshot 当陈旧页整页丢弃(那时
    // draft.watermark 停在更高处),把消费指针拉到更低就会让重复/丢失判定错位。
    // 换 epoch 时 applySnapshot 先把 draft.watermark 重设,这里自然跟着降。
    let seq = Math.max(pageWatermark, this.stateGet.watermark);
    for (const item of this.pendingFragments.values()) seq = Math.max(seq, item.seq);
    this.consumedSeq = seq;
  }

  private scheduleResnapshot(): void {
    const at = Date.now();
    const elapsed = at - this.lastResnapshotAt;
    if (elapsed < RESNAPSHOT_DEBOUNCE_MS) {
      // 处于防抖期内：挂尾随定时器，确保防抖窗口一过立即补拉一次，绝不丢失被缺口跳过的事件！
      if (this.resnapshotTimer == null) {
        this.resnapshotTimer = window.setTimeout(() => {
          this.resnapshotTimer = null;
          this.lastResnapshotAt = Date.now();
          void this.resnapshot();
        }, RESNAPSHOT_DEBOUNCE_MS - elapsed);
      }
      return;
    }
    if (this.resnapshotTimer != null) {
      clearTimeout(this.resnapshotTimer);
      this.resnapshotTimer = null;
    }
    this.lastResnapshotAt = at;
    void this.resnapshot();
  }

  /** 快照重建(attach/缺口校正后的权威对齐)。 */
  async resnapshot(): Promise<void> {
    try {
      const page = await transport.timelinePage(this.seed, `?limit=${SNAPSHOT_LIMIT}`);
      this.mutate((draft) => {
        applySnapshot(draft, page);
      });
      this.rebaseConsumed(page.snapshot?.watermark ?? 0);
      this.loadError[1](false);
    } catch {
      // 快照失败不致命:流还在,下一次触发再试。
    }
  }

  // ── 投影事件(刷新信号,宿主转发) ─────────────────────────────────────────────

  /** 前端只把投影事件当刷新信号;数据一律走 approvals RPC / sessions 列表。 */
  private applyProjection(streamKey: unknown, payload: unknown): void {
    const delta = readProjection(streamKey, payload);
    if (!delta.channel || !delta.kind) return;
    if (delta.channel === "conversation") {
      if (delta.kind === "turn_started") {
        // 新回合已开:旧取消的看门狗作废,不得误伤新一轮的乐观发送态。
        this.clearCancelWatchdog();
        this.isSending[1](false);
        this.activeTurnStartedAt = now();
        this.activeModelBlockIds.clear();
        this.activeOutputStartedAt = null;
        this.activeOutputEndedAt = null;
        this.lastModelDeltaAt = null;
        this.activeOutputActiveMs = 0;
        this.activeStreamWindow = [];
        this.activeStreamTokens = 0;
        this.composerMetrics[1]((current) => ({ ...current, isStreaming: false }));
      }
      if (delta.kind === "assistant_block_sealed" || delta.kind === "turn_finished" || delta.kind === "turn_interrupted") {
        const usage = delta.body.usage as UsageInfo | null | undefined;
        if (usage != null) this.updateComposerUsage(usage);
        if (delta.kind === "turn_finished" || delta.kind === "turn_interrupted") {
          // 真实终态到达:取消看门狗撤防。
          this.clearCancelWatchdog();
          this.isSending[1](false);
          this.activeTurnStartedAt = null;
          this.activeModelBlockIds.clear();
          this.activeStreamWindow = [];
          this.activeStreamTokens = 0;
          this.composerMetrics[1]((current) => ({ ...current, isStreaming: false }));

          // 双流防御自愈：V2 投影流已确认回合终态，若 Timeline 流未推 turn_sealed 或因缺口被丢弃，
          // 本地立刻强制收口 running 回合，杜绝假死，并补拉快照对齐权威落盘细节！
          const body = delta.body;
          const turnId = typeof body.turn_id === "string" ? body.turn_id : null;
          const terminal = typeof body.terminal === "string"
            ? body.terminal
            : delta.kind === "turn_interrupted" ? "cancelled" : undefined;
          const error = body.error as { message?: string } | null | undefined;
          this.mutate((draft) => {
            forceSealTurn(draft, turnId, terminal, error);
          });
          void this.resnapshot();

          // 换 profile 的重载就在 turn 边界生效,回合结束正好把新配置与新选择读回来。
          void this.refreshConfigView();
          void this.refreshProfile();
        }
      }
    }
    for (const action of projectionActions(delta)) {
      switch (action) {
        case "activity":
          // `state` 在内层 data 里(双层 tag/content),读错层就是静默无信号。
          this.activity[1](normalizeActivity(delta.body.state, "projection"));
          break;
        case "approvals":
          void this.refreshApprovals();
          break;
        case "todos":
          void this.refreshTodos();
          break;
        case "compacted": {
          // 同一 checkpoint 的重复投影(重连重放 durable 事实)不重锚,否则
          // 分隔线会跳到最新回合下方,压缩后发生的内容全被顶到线上方。
          const checkpoint = typeof delta.body.checkpoint_id === "string" ? delta.body.checkpoint_id : null;
          if (checkpoint != null && checkpoint === this.compactedCheckpoint) break;
          this.compactedCheckpoint = checkpoint;
          this.compactedAfter[1](compactedAnchor(this.stateGet.slots, this.stateGet.turns));
          this.setCompact(reduceCompact(this.compact[0](), "compacted", delta.body, now()));
          break;
        }
        case "compact_started":
        case "compact_progress":
        case "compact_finished": {
          this.setCompact(reduceCompact(this.compact[0](), action, delta.body, now()));
          break;
        }
        case "sessions":
          if (delta.kind === "title_changed" && typeof delta.body.title === "string") {
            // v2 Meta SSE carries the value, so update the active tab and sidebar
            // immediately without waiting for the periodic session.list poll.
            this.applySessionMeta({ title: delta.body.title });
            this.onSessionTitleChanged?.(delta.body.title);
          } else {
            this.onSessionsChanged?.();
          }
          break;
        case "session_deleted":
          this.onSessionDeleted?.();
          break;
      }
    }
  }

  /**
   * 增量流式生成时的实时测算（只在模型真在产出时被调用）：
   * 1. tok/s：取滑动窗口（最近 `STREAM_WINDOW_MS`）内的 token 增量算瞬时速率，
   *    EMA 滤波消除分块抖动；窗口太薄就保留上一个值，不拿总时长凑一个假数；
   * 2. 上下文：基准 prompt_tokens + 当前轮次已生成的 token，动态反映增长。
   */
  private updateLiveMetrics(): void {
    if (this.activeModelBlockIds.size === 0 || this.activeOutputStartedAt == null) return;
    const at = now();
    // 距最后一次模型增量已超过 `STREAM_IDLE_MS` = 现在没在吐字(工具在执行、子进程在跑、
    // 网络卡住)。这里必须**停表**并把脉冲点灭掉:继续往下走会落到旧的回退分支,
    // 用「累计 token ÷ 从首个增量算起的总时长」出数,而那个分母含工具墙钟——
    // 表现为工具一跑,速率就一路衰减,像模型突然变慢。
    if (this.lastModelDeltaAt == null || at - this.lastModelDeltaAt > STREAM_IDLE_MS) {
      this.composerMetrics[1]((current) => (current.isStreaming ? { ...current, isStreaming: false } : current));
      return;
    }
    const cutoff = at - STREAM_WINDOW_MS;
    while (this.activeStreamWindow.length > 0 && this.activeStreamWindow[0]!.at < cutoff) {
      this.activeStreamWindow.shift();
    }

    let liveTps: number | null = null;
    if (this.activeStreamWindow.length >= 2) {
      const first = this.activeStreamWindow[0]!;
      const last = this.activeStreamWindow[this.activeStreamWindow.length - 1]!;
      const windowDuration = (last.at - first.at) / 1000;
      if (windowDuration >= 0.15) {
        let windowTokens = 0;
        for (let i = 1; i < this.activeStreamWindow.length; i += 1) {
          windowTokens += this.activeStreamWindow[i]!.tokens;
        }
        liveTps = windowTokens / windowDuration;
      }
    }

    if (liveTps != null && Number.isFinite(liveTps)) {
      this.composerMetrics[1]((current) => ({
        ...current,
        tokensPerSecond: current.tokensPerSecond == null
          ? liveTps!
          : current.tokensPerSecond * 0.35 + liveTps! * 0.65,
        isStreaming: true,
      }));
    } else {
      this.composerMetrics[1]((current) => ({
        ...current,
        isStreaming: true,
      }));
    }

    if (this.contextLength != null && this.contextLength > 0) {
      const baseTokens = this.measuredContextTokens ?? 0;
      const currentTotal = baseTokens + this.activeStreamTokens;
      this.composerMetrics[1]((current) => ({
        ...current,
        contextPercent: Math.min(100, (currentTotal / this.contextLength!) * 100),
      }));
    }
  }

  /**
   * 流中 usage 采样（`usage_sampled` timeline 事件，后端 ~1s 节流）的温和消费：
   *  - `prompt_tokens` 是本轮请求的实时官方上下文，比「上一轮 prompt」新鲜——
   *    有就重基线（`updateComposerUsage` 的最终结算随后会覆盖成权威终值）；
   *  - 端点可能只报 output（Anthropic `message_delta`），没有 prompt 就不动
   *    分子，更不能清零——那会把表盘打到 0%。
   *  - 只动 contextPercent / cacheHitPercent；tok/s、`isStreaming`、流窗口
   *    都是吐字速率的状态机，采样事件不得碰（那是块 seal 的职责）。
   */
  private applyUsageSampled(usage: UsageInfo): void {
    if (usage.prompt_tokens > 0) this.measuredContextTokens = usage.prompt_tokens;
    this.composerMetrics[1]((current) => ({
      ...current,
      cacheHitPercent: usage.cache_usage_reported === false
        ? null
        : cacheHitPercent(usage) ?? current.cacheHitPercent,
    }));
    this.publishContextPercent();
  }

  private updateComposerUsage(usage: UsageInfo): void {
    this.activeStreamWindow = [];
    this.activeStreamTokens = 0;
    // 速率分母只算「模型确实在产出」的累计区间（见 activeOutputActiveMs 的累加规则）。
    // 下面那条首末差一直自称 "excluding tool and user-wait time"，其实没排除：
    // 中间跑一个 30 秒的 exec，40 tok/s 能被压成 2 tok/s。首末差只留给
    // 没观测到任何增量的回放/纯历史路径当兜底。
    const durationMs = this.activeOutputActiveMs > 0
      ? this.activeOutputActiveMs
      : this.activeOutputStartedAt != null && this.activeOutputEndedAt != null
        ? this.activeOutputEndedAt - this.activeOutputStartedAt
        : this.activeTurnStartedAt == null ? null : now() - this.activeTurnStartedAt;
    const elapsedSeconds = durationMs == null ? null : Math.max(0.001, durationMs / 1_000);
    // 服务端 usage 的 prompt_tokens 就是这一轮真正发出去的上下文(系统提示 + 工具
    // schema + 历史),直接当占用真值;它只统计到本轮 prompt,答案那部分要等下一轮
    // 才进 prompt,所以这个表盘天然滞后一轮。
    this.measuredContextTokens = usage.prompt_tokens;
    this.composerMetrics[1]((current) => ({
      ...current,
      tokensPerSecond: elapsedSeconds == null ? current.tokensPerSecond : usage.completion_tokens / elapsedSeconds,
      cacheHitPercent: usage.cache_usage_reported === false
        ? null
        : cacheHitPercent(usage) ?? current.cacheHitPercent,
      // 反映上一轮为准:端点这轮没报 extras 就清空,不留陈旧的芯片。
      extras: usage.extras ?? {},
      isStreaming: false,
    }));
    this.publishContextPercent();
  }

  /** 百分比常驻:只要配置窗口长度有效,首轮之前也显示 0% 基础占位,杜绝跳动。 */
  private publishContextPercent(): void {
    const tokens = this.measuredContextTokens ?? 0;
    const length = this.contextLength;
    const valid = length != null && Number.isFinite(length) && length > 0;
    this.composerMetrics[1]((current) => ({
      ...current,
      // 分母一起发布:菜单里要能看出「按多少算的」,否则「怎么才 1%」只能靠猜。
      contextWindow: valid ? length! : null,
      contextPercent: valid ? Math.min(100, (tokens / length!) * 100) : null,
    }));
  }

  /**
   * 取全局配置的 composer 视图:窗口(百分比分母)+ profile 名录。
   * 分子与「本会话选了哪个 profile」都不由这里产生。
   */
  private async refreshConfigView(): Promise<void> {
    if (this.disposed) return;
    const refreshId = ++this.contextRefreshId;
    try {
      const config = await transport.rpc<ConfigDto>("config.load");
      if (this.disposed || refreshId !== this.contextRefreshId) return;
      const length = config?.contextLength;
      if (length != null && Number.isFinite(length) && length > 0) this.contextLength = length;
      this.configProfile = { activeProfile: config.activeProfile, model: config.model, profiles: [...config.profiles] };
      this.publishContextPercent();
      this.publishProfileView();
    } catch {
      // Keep the last known window; metrics are an optional HUD.
    }
  }

  /** 三份来源拼一个视图:`session.meta` 的选择 + 全局名录 + 全局活跃项。 */
  private publishProfileView(): void {
    const config = this.configProfile;
    const selected = this.metaProfile;
    // 只有生效项就是全局活跃 profile 时,扁平 model 才真的是它的 model;
    // 选了别的 profile 就留空,由 UI 显示「model 未公开」而不是拿创建时刻的快照充数。
    const followsGlobal = selected == null || selected === config?.activeProfile;
    this.composerProfile[1]({
      selected,
      activeProfile: config?.activeProfile ?? null,
      effective: selected ?? config?.activeProfile ?? null,
      model: followsGlobal ? config?.model ?? null : null,
      catalog: config?.profiles ?? [],
    });
  }

  /**
   * 重读会话自己的 profile。必须重读而不能乐观落库:daemon 的 ack 只表示命令
   * 进了队,重载要等 turn 边界才发生,而 meta.json 写得更早(spec §1.5)。
   */
  async refreshProfile(): Promise<void> {
    if (this.disposed) return;
    const refreshId = ++this.profileRefreshId;
    try {
      const meta = await transport.rpc<SessionMetaWire>("session.meta", {}, this.seed);
      if (this.disposed || refreshId !== this.profileRefreshId) return;
      this.metaProfile = typeof meta?.profile === "string" && meta.profile !== "" ? meta.profile : null;
    } catch {
      // best-effort:选择器退回「跟随全局」,下一次 turn 结束再取。
    }
    this.publishProfileView();
  }

  /** 会话级换 profile;`null` = 清除选择、回到跟随全局 `active_profile`。 */
  async setSessionProfile(name: string | null): Promise<void> {
    await transport.rpc("session.set_profile", { name: name ?? "" }, this.seed);
    await this.refreshProfile();
  }

  async refreshActivity(): Promise<void> {
    try {
      const bootstrap = (await this.host().sessionBootstrap(this.seed)) as any;
      const control = bootstrap?.control?.state ?? {};
      this.activity[1](normalizeActivity(control.activity, "domain"));
    } catch {
      // best-effort;activity 由投影事件持续修正。
    }
  }

  // ── 待办(todo.list 单源) ────────────────────────────────────────────────────

  /** RPC remains authoritative. V2 facts invalidate it; legacy dashboard events
   * are not broadcast. Coalesce bursts, retaining a trailing read if a mutation
   * arrives during an in-flight request. Never commit a superseded response. */
  refreshTodos(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.todoRefreshPending = true;
    if (this.todoRefresh != null) return this.todoRefresh;
    this.todoRefresh = this.drainTodoRefresh().finally(() => {
      this.todoRefresh = null;
      // An invalidation can arrive between the last read and this finalizer.
      if (this.todoRefreshPending && !this.disposed) void this.refreshTodos();
    });
    return this.todoRefresh;
  }

  private async drainTodoRefresh(): Promise<void> {
    while (this.todoRefreshPending && !this.disposed) {
      this.todoRefreshPending = false;
      try {
        const result = await transport.rpc<Record<string, unknown>>("todo.list", {}, this.seed);
        if (this.disposed || this.todoRefreshPending) continue;
        if (!Array.isArray(result?.items)) throw new Error("todo.list response is missing items");
        writeStable(this.todos, result.items as TodoItemWire[]);
      } catch (error) {
        // Preserve the last successful list; make failures visible in diagnostics.
        if (!this.disposed) console.warn("[qaqh-webui] todo.list refresh failed", error);
      }
    }
  }

  // ── 审批(单源:approvals RPC) ───────────────────────────────────────────────

  async refreshApprovals(): Promise<void> {
    let list: ApprovalView[];
    try {
      list = await transport.approvals(this.seed);
    } catch {
      return; // best-effort:下一轮信号再取
    }
    const previous = this.pending[0]();
    const next = Array.isArray(list) ? list : [];
    // 内容未变不写信号:每次刷新都灌新数组会让授权卡整棵子树按身份重建
    // (反复重挂 = 焦点被抢 + 图形与内存持续增长),而 UI 看上去毫无变化。
    writeStable(this.pending, next);
    this.recordWaitTransition(previous, next);
    this.activity[1](next.length > 0 ? "waiting_user" : this.activityIsWorking() ? "working" : "idle");
  }

  private activityIsWorking(): boolean {
    return this.activity[0]() === "working";
  }

  /** 0→N 开区间 / N→0 闭区间,挂到当前运行回合(spec D3:已工作扣除等待)。 */
  private recordWaitTransition(previous: ApprovalView[], next: ApprovalView[]): void {
    if (previous.length === 0 && next.length > 0) {
      const kind = next[0]!.kind === "ask" || next[0]!.kind === "plan" ? "ask" : "approval";
      this.waitFrom = { kind, at: now() };
    } else if (previous.length > 0 && next.length === 0 && this.waitFrom) {
      const wait: Wait = { turnKey: this.stateGet.activeTurnKey, kind: this.waitFrom.kind, from: this.waitFrom.at, to: now() };
      this.mutate((draft) => {
        draft.waits.push(wait);
      });
      this.waitFrom = null;
    }
  }

  async respondApproval(challengeId: string, decision: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await transport.respondApproval(this.seed, challengeId, decision, payload);
    } finally {
      // 宿主 challenge 一次性消费；daemon 拒绝或 IPC 短暂失败时也必须重取，
      // 让仍然 pending 的交互获得新 challenge，避免界面卡在已消费的旧 ID 上。
      await this.refreshApprovals();
    }
  }

  // ── 动作 ────────────────────────────────────────────────────────────────────

  async sendMessageWithAttachments(text: string, attachments: ContentRef[] = []): Promise<void> {
    // 发送即收掉滞留的压缩终态卡(failed 保留);退场定时器随后空转,无需专撤。
    this.compact[1]((current) => current.phase === "done" || current.phase === "skipped" ? { phase: "idle" } : current);
    this.isSending[1](true);
    try {
      await transport.command("conversation", {
        channel: "conversation",
        type: "conversation_send_message",
        text,
        images: [],
        as_system: false,
        attachments,
      }, this.seed);
    } catch (error) {
      this.isSending[1](false);
      throw error;
    }
  }

  async sendMessage(text: string): Promise<void> {
    const attachments = this.pendingAttachments[0]()
      .filter((item) => item.state === "ready" && item.reference != null)
      .map((item) => item.reference as ContentRef);
    await this.sendMessageWithAttachments(text, attachments);
    // 投递失败会抛出,附件保持原样让用户重试。
    this.pendingAttachments[1]([]);
  }

  /**
   * 选附件并逐个上传。字节读取与上传都在宿主侧完成(见宿主 `upload_attachment`),
   * 这里只维护 chip 状态。单个失败不影响其余:该 chip 转 failed 并留在列表里。
   */
  async addAttachments(): Promise<void> {
    await this.attachPaths(await transport.pickAttachments());
  }

  /**
   * 按**已知路径**挂附件（截图走这条：宿主已把图写进临时目录，没有对话框可开）。
   *
   * 与 `addAttachments` 共用一份实现是有意的：截图与手选文件在"chip 状态机"上
   * 必须完全同形（同样去重、同样先 uploading、同样单个失败不拖垮其余），
   * 两条路径各写一套迟早让截图的 chip 少一个错误态。
   */
  async attachPaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const known = new Set(this.pendingAttachments[0]().map((item) => item.id));
    const added: PendingAttachment[] = [];
    for (const path of paths) {
      if (known.has(path)) continue;
      known.add(path);
      added.push({
        id: path,
        name: attachmentName(path),
        size: 0,
        mediaType: "",
        state: "uploading",
        reference: null,
        error: null,
      });
    }
    if (added.length === 0) return;
    this.pendingAttachments[1]((current) => [...current, ...added]);
    await Promise.all(added.map(async (item) => {
      try {
        const uploaded = await transport.uploadAttachment(this.seed, item.id);
        this.patchAttachment(item.id, {
          name: uploaded.name,
          size: uploaded.size,
          mediaType: uploaded.media_type,
          state: "ready",
          reference: {
            content_id: uploaded.content_id,
            media_type: uploaded.media_type,
            sha256: uploaded.sha256,
            truncated: uploaded.truncated,
          },
        });
      } catch (error) {
        this.patchAttachment(item.id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  removeAttachment(id: string): void {
    this.pendingAttachments[1]((current) => current.filter((item) => item.id !== id));
  }

  private patchAttachment(id: string, patch: Partial<PendingAttachment>): void {
    this.pendingAttachments[1]((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async cancelTurn(): Promise<void> {
    const activeKey = this.stateGet.activeTurnKey;
    const turn = activeKey != null ? this.stateGet.turns[activeKey] : null;
    const turnId = turn?.id ?? null;
    await transport.command("conversation", { channel: "conversation", type: "conversation_cancel", turn_id: turnId }, this.seed);
    // 命令已入队才布防:投递失败走异常,Composer 的 catch 会复位 stopping,
    // 不需要看门狗代劳。真实终态 delta 到达时撤防(见 applyProjection)。
    this.armCancelWatchdog(turnId);
  }

  /**
   * 取消看门狗:超过 `CANCEL_WATCHDOG_MS` 仍无终态 delta,就地把 running 回合
   * 收口为 aborted、复位乐观发送态、activity 归为 interrupted,并补拉快照。
   * 这是纯前端的自愈——后端 turn 状态机卡死(工具无取消检查点)时不发终态,
   * 本兜底保证 UI 永不假死;若后端稍后真的补出终态,事件会幂等覆盖同一收口。
   */
  private armCancelWatchdog(turnId: string | null): void {
    this.clearCancelWatchdog();
    this.cancelWatchdog = setTimeout(() => {
      this.cancelWatchdog = null;
      if (this.disposed) return;
      this.isSending[1](false);
      this.activeTurnStartedAt = null;
      this.activeModelBlockIds.clear();
      this.activeStreamWindow = [];
      this.activeStreamTokens = 0;
      this.composerMetrics[1]((current) => ({ ...current, isStreaming: false }));
      // 蓝点:后端仍报 working(卡死的 actor),本地先按已中断呈现;
      // 真实 activity 投影到达时会被覆盖。
      if (this.activity[0]() === "working") this.activity[1]("interrupted");
      this.mutate((draft) => {
        forceSealTurn(draft, turnId, "cancelled");
      });
      void this.resnapshot();
    }, CANCEL_WATCHDOG_MS);
  }

  private clearCancelWatchdog(): void {
    if (this.cancelWatchdog != null) {
      clearTimeout(this.cancelWatchdog);
      this.cancelWatchdog = null;
    }
  }

  /**
   * 压缩卡写入的唯一入口:done/skipped 起延时退场定时器,failed 常驻等用户
   * 处理;任何后续状态先撤掉旧定时器。
   */
  private setCompact(next: CompactState): void {
    this.compact[1](next);
    if (this.compactTimer != null) {
      clearTimeout(this.compactTimer);
      this.compactTimer = null;
    }
    if (next.phase === "done" || next.phase === "skipped") {
      this.compactTimer = window.setTimeout(() => {
        this.compactTimer = null;
        // 期间可能已开新一轮压缩或被发送消息清掉:只收掉仍然滞留的终态。
        this.compact[1]((current) => current.phase === "done" || current.phase === "skipped" ? { phase: "idle" } : current);
      }, COMPACT_CARD_TTL_MS);
    }
  }

  /**
   * 手动压缩上下文。ack 只代表进队,所以先乐观置 running,否则按钮点了要等
   * 第一帧过程事件才有反馈;真实终态以 `compact_finished` / `compaction_applied`
   * 为准。终态原因读线上 `compact_finished.reason`(失败/跳过/取消都有中文说明);
   * 只有"命令没送达"这条路径不会有事件,原因就地合成。
   */
  async compactContext(): Promise<void> {
    this.setCompact({ phase: "running", compactId: null, turnsTotal: null, turnsKeeping: null, summary: "" });
    try {
      await transport.command("conversation", { channel: "conversation", type: "conversation_compact" }, this.seed);
    } catch (error) {
      console.warn("[compact] 压缩命令投递失败", error);
      this.setCompact({ phase: "failed", reason: compactDeliveryFailure(error) });
    }
  }

  async createSession(): Promise<void> {
    await transport.command("control", { channel: "control", type: "session_create", close_current: false });
  }

  /** 向上翻页(spec §14.2)。返回是否真的加载了内容(调用方做滚动补偿)。 */
  async loadOlder(): Promise<boolean> {
    const state = this.stateGet;
    if (this.loadingOlder[0]() || !state.hasMore || state.oldestIndex == null) return false;
    this.loadingOlder[1](true);
    this.loadError[1](false);
    try {
      const page = await transport.timelinePage(this.seed, `?limit=${PAGE_LIMIT}&before_index=${state.oldestIndex}`);
      this.mutate((draft) => {
        prependPage(draft, page);
      });
      return true;
    } catch {
      this.loadError[1](true); // 顶部「加载失败,点击重试」,不自动重试
      return false;
    } finally {
      this.loadingOlder[1](false);
    }
  }

  /**
   * 窗口淘汰(spec §14.1):超出 `window` 且远在视口上方的最旧回合替换为等高
   * 占位,并释放其回合数据——只换占位不删数据的话,翻页越深 turns 全量文本
   * 越攒越多(常驻内存只增不减)。返回被淘汰的 slot key 供视图回填高度。
   */
  evictOutOfView(
    window: number,
    screens: number,
    offsetTopOf: (key: string) => number | null,
    viewportTop: number,
    viewportHeight: number,
  ): string[] {
    let evicted: string[] = [];
    this.mutate((draft) => {
      evicted = evictForWindow(draft, window, screens, offsetTopOf, viewportTop, viewportHeight);
    });
    return evicted;
  }

  /**
   * 时间线展开态(spec §7.3)。MUST 走 setter:Solid 2 的 store 代理直写
   * (`state[0].turns[k].expanded = …`)会被静默丢弃,读回来还是旧值。
   */
  toggleTurnExpanded(key: string): void {
    this.mutate((draft) => {
      const turn = draft.turns[key];
      if (turn) turn.expanded = !turn.expanded;
    });
  }

  /** 回合淘汰占位高度回填(由视图量完布局后一次写入整段;逐格写会通知每个下标)。 */
  setPlaceholderHeights(heights: Array<[key: string, height: number]>): void {
    if (heights.length === 0) return;
    const byKey = new Map(heights);
    this.mutate((draft) => {
      fillGapHeights(draft, byKey);
    });
  }

  /** sessions 列表驱动:标题 + 后台「有新回复」点(运行态走 activity 信号,不从这里取)。 */
  applySessionMeta(meta: { title?: string | null; turn_count?: number }): void {
    if (typeof meta.title === "string" && meta.title) this.title[1](meta.title);
    if (typeof meta.turn_count === "number") {
      const known = this.lastTurnCount;
      if (known != null && meta.turn_count > known) this.hasNewReply[1](true);
      this.lastTurnCount = meta.turn_count;
    }
  }
}


/**
 * 内容未变则不写信号:每次刷新都灌新对象会让 `For` 按身份重建整棵子树
 * (授权卡反复重挂 = 焦点被抢 + 反应图形与内存只增不减),而 UI 毫无变化。
 */
function writeStable<T>(signal: readonly [() => T, (value: T) => void], next: T): void {
  const current: T = signal[0]();
  if (current === next) return;
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  signal[1](next);
}
