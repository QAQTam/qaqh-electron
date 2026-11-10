/**
 * 一个标签页 = 一个会话的客户端状态机 (SPEC-2026-10-29-PURGE)。
 *
 * 当前会话事实直接来自 Ringing v3 bootstrap 与 flattened SessionEventFrame：
 * - 全量装载由 applySessionBootstrap 负责
 * - 实时增量由 applySessionEvent 负责
 * - 连接状态来自 projection://status
 */
import { createSignal, createStore } from "solid-js";
import { transport, desktopHostSurface, execSessionTarget, sessionTarget, type ApprovalView, type StreamHandlers, type ProjectionStatusWire, type TodoItemWire } from "../lib/transport";
import { now } from "../lib/time";
import { onConfigChanged } from "../lib/config-events";
import { applySessionBootstrap, applySessionEvent, contentRefsInPayload, emptySession, forceSealTurn, pendingContentRefs, resolveContentRef } from "./reducer";
import { ContentLoader } from "./content-loader";
import { evictForWindow, fillGapHeights } from "./pagination";
import type { SessionState, Wait } from "./types";
import { normalizeActivity, type SessionActivity } from "./projection";
import type {
 ModelSelection, SessionBootstrap, SessionContentRef, SessionEventFrame, SessionListEntry, SessionSettingsPatch, UsageInfo, ToolsSettingPatch 
} from "../api/contract";
import { providerKindOfCredential, type ProviderKind } from "../oauth/mode";
import { registry, refreshRegistry } from "../settings/registry";

function pendingContentRefsFromSnapshot(snapshot: unknown): Set<string> { return contentRefsInPayload(snapshot); }

export type ConnectionKind = "connected" | "reconnecting" | "offline";

/** Transient upstream retry status from the provider_retrying timeline event. */
export type ProviderRetryState = {
  turnId: string;
  attempt: number;
  maxRetries: number;
  delaySecs: number;
  error: string;
};

/** Latest scheduled Electron SSE reconnect (conn://reconnect). */
export type ReconnectState = {
  attempt: number;
  delayMs: number;
  at: number;
};

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
  reference: SessionContentRef | null;
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
  /** Parameter generation activity, not a fabricated token throughput. */
  isGeneratingToolInput?: boolean;
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
 * 输入区模型/参数选择器的会话视图。
 *
 * 全局真源是 `provider.list` 的 `default_model_selection`（providers.toml 目录，
 * legacy profile 已退役）；`effective` 是会话当前生效 provider 的展示名，
 * `providerKind` 驱动模型目录与档位特判。绝不拿 `SessionMeta.model`（建会话
 * 那一刻的快照，`reload_config` 不回写它）冒充生效值。
 */
export interface SessionProfileView {
  /** 会话当前生效 provider 的展示名；未选择时为 null。 */
  effective: string | null;
  model: string | null;
  /** 本会话有效 provider 的类别（模型目录/档位特判按它算）。 */
  providerKind: ProviderKind;
}

/** Flattened `session.meta` fields used by the composer settings view. */
type SessionMetaWire = Pick<SessionListEntry, "model_selection" | "settings_revision" | "tool_mode" | "custom_tools" | "model">;

/** 会话工具模式视图:composer 选择器的读面。`mode` 空串按 standard 语义归一。 */
export interface SessionToolModeView {
  mode: string;
  /** custom 档的白名单(仅 mode === "custom" 时有意义)。 */
  customTools: string[];
}

/** 会话 meta 的工具模式名 → 统一 patch。`preset` 承载 minimal 家族与 `none`。 */
function toolsSettingPatch(mode: string, customTools: string[]): ToolsSettingPatch {
  if (mode === "standard" || mode === "all" || mode === "default") return { mode: "default" };
  if (mode === "none") return { mode: "none" };
  if (mode === "custom") return { mode: "custom", names: customTools };
  return { mode: "preset", name: mode };
}

/** `config.load` 里与 profile 选择器有关的字段。 */


function cacheHitPercent(usage: UsageInfo): number | null {
  if (usage.cache_usage_reported !== true) return null;
  const total = usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens;
  return total > 0 ? (usage.prompt_cache_hit_tokens / total) * 100 : null;
}

/**
 * 取消看门狗:`conversation.cancel` 发出后,超过此时长仍未见 `turn_finished` /
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
  providerRetry = createSignal<ProviderRetryState | null>(null);
  reconnect = createSignal<ReconnectState | null>(null);
  activity = createSignal<SessionActivity | null>(null);
  composerMetrics = createSignal<ComposerMetrics>({ tokensPerSecond: null, isStreaming: false, contextPercent: null, contextWindow: null, cacheHitPercent: null, extras: {} });
  composerProfile = createSignal<SessionProfileView>({
    effective: null,
    model: null,
    providerKind: "byok",
  });
  /** 会话解析后的模型/参数视图（overrides → profile → global）。 */
  composerModel = createSignal<string | null>(null);
  composerModelOverride = createSignal(false);
  composerEffort = createSignal<string | null>(null);
  composerEffortOverride = createSignal(false);
  composerMaxTokens = createSignal<number | null>(null);
  composerContextLength = createSignal<number | null>(null);
  composerToolMode = createSignal<SessionToolModeView>({ mode: "standard", customTools: [] });
  title = createSignal<string | null>(null);
  pending = createSignal<ApprovalView[]>([]);
  todos = createSignal<TodoItemWire[]>([]);
  todosSyncPending = createSignal(false);
  approvalsVerifiedState = createSignal(false);
  loadError = createSignal(false);
  contentStatus = createSignal<Record<string, "loading" | "ready" | "failed">>({});
  /** 权威快照是否已落地：loadBootstrap 成功落地置 true，SessionView 据此渲染内容或「消息同步中」。 */
  hydrated = createSignal(false);
  hasNewReply = createSignal(false);
  /** 乐观发送中状态：点击发送即刻置 true 消除时差空窗，首个事件到达或结束时置 false。 */
  isSending = createSignal(false);
  /** 取消看门狗定时器;真实终态 delta / 新回合 / dispose 都会先撤掉。 */
  private cancelWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** 宿主侧是否已为本 seed 尝试过建流。 */
  pendingAttachments = createSignal<PendingAttachment[]>([]);
  loadingOlder = createSignal(false);

  /**
   * 标签层注入的回调:本会话的元数据变了(标题/归档),去重拉 sessions 列表。
   * meta 频道只有已 attach 的会话才有流,后台会话的变更仍要等列表重拉。
   */
  onSessionsChanged: (() => void) | null = null;
  onConnectionRestored: (() => void) | null = null;
  private hasBeenLive = false;
  /** 标签层注入的回调：v2 MetaDelta::TitleChanged 到达时就地更新侧栏标题。 */
  onSessionTitleChanged: ((title: string) => void) | null = null;
  /** 标签层注入的回调:`MetaDelta::Deleted` 是权威终态,目录项与标签一起收掉。 */
  onSessionDeleted: (() => void) | null = null;

  /** 宿主事件反订阅。 */
  private hostUnlisten: (() => void) | null = null;
  private waitFrom: { kind: Wait["kind"]; at: number } | null = null;
  private lastTurnCount: number | null = null;
  private disposed = false;
  private active = false;
  private bootstrapRequestId = 0;
  private activationGeneration = 0;
  private contentLoader = new ContentLoader(
    (ref, signal) => transport.readContentText(ref, signal),
    (ref, text, resolved) => this.mutate((draft) => resolveContentRef(draft, ref, text, resolved)),
    (ref, status) => this.contentStatus[1]((current) => {
      const next = { ...current };
      if (status === "idle") delete next[ref]; else next[ref] = status;
      return next;
    }),
  );
  private todoRefresh: Promise<void> | null = null;
  private todoRefreshPending = false;
  private todoRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private todoFailures = 0;
  private approvalRefresh: Promise<void> | null = null;
  private approvalRefreshPending = false;
  private approvalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalFailures = 0;
  private approvalGeneration = 0;
  private approvalEventRevision = 0;
  private approvalsVerified = false;
  private activeTurnStartedAt: number | null = null;
  /**
   * 本回合**正在产出模型 token** 的块 id:text(答案)与 reasoning(思考)都算。
   * 工具块不在里面——它吃的是宿主/子进程的钟,不是模型的吐字速率。
   */
  private activeModelBlockIds = new Set<string>();
  private activeOutputStartedAt: number | null = null;
  private activeOutputEndedAt: number | null = null;
  private activeOutputActiveMs = 0;
  private contextRefreshId = 0;
  /** 分母:会话有效模型目录里的 context_window(publishProfileView 维护)。 */
  private contextLength: number | null = null;
  /** `session.meta.model_selection`(会话级选择);null = 跟随全局 default_model_selection。 */
  private metaModelSelection: ModelSelection | null = null;
  private metaSettingsRevision: number | null = null;
  /** `session.meta.tool_mode`;空串按 standard 归一(后端零迁移语义)。 */
  private metaToolMode = "standard";
  /** `session.meta.custom_tools`(仅 tool_mode === "custom" 时后端消费)。 */
  private metaCustomTools: string[] = [];
  /** profile 读模型的去重代际(refreshProfile 幂等)。 */
  private profileRefreshId = 0;
  /** 分子:上一轮服务端 usage 的 `prompt_tokens`,即真正发出去的上下文。 */
  private measuredContextTokens: number | null = null;
  /** 配置广播的退订函数(见 `lib/config-events`)。 */
  private unsubscribeConfig: (() => void) | null = null;

  constructor(seed: string) {
    this.seed = seed;
    // `name`:归因(attribution/diagnostics)里这条 store 的节点标成 `session.<key>`,
    // 否则热路径上的 memo 只能靠调用栈认。
    this.state = createStore<SessionState>(emptySession(), { name: "session" });
    // 配置写口都不在本 store(设置页 / 接入页 / 输入区模型卡片),而 daemon 不推
    // config-changed:靠 `notifyConfigChanged()` 广播。不订阅的话,设置页把服务商
    // 目录改完再点保存,会话视图仍按旧目录算,要等**下一轮结束**才纠正——
    // refreshConfigView 在这里重发 profile 视图(分母从模型目录推出)。
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

  private host(): NonNullable<ReturnType<typeof desktopHostSurface>> {
    const host = desktopHostSurface(transport);
    if (host == null) throw new Error("宿主传输后端不可用(应在 Electron 壳内运行)");
    return host;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** 成为活动标签:先订阅宿主事件，再 attach + loadBootstrap 取权威快照。 */
  async activate(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.activationGeneration;
    this.active = true;
    this.approvalGeneration++;
    this.approvalEventRevision = 0;
    this.approvalsVerified = false;
    this.approvalsVerifiedState[1](false);
    this.markApprovalsUnverified(false);
    this.hasNewReply[1](false);
    this.providerRetry[1](null);
    this.reconnect[1](null);
    if (!this.hydrated[0]()) this.hydrated[1](false);
    await this.connectHost();
    if (this.disposed || generation !== this.activationGeneration) return;
    this.active = true;
    await transport.attach(this.seed);
    if (this.disposed || generation !== this.activationGeneration) return;
    this.active = true;
    void this.refreshApprovals();
    void this.refreshTodos();
    void this.refreshConfigView();
    void this.refreshProfile();
  }

  /**
   * 失去活动资格(别的标签接管):退订宿主事件 + 立即卸载转录。
   */
  deactivate(): void {
    this.active = false;
    this.activationGeneration++;
    this.approvalGeneration++;
    this.approvalRefreshPending = false;
    if (this.approvalRetryTimer != null) clearTimeout(this.approvalRetryTimer);
    this.approvalRetryTimer = null;
    this.approvalsVerified = false;
    this.approvalsVerifiedState[1](false);
    this.markApprovalsUnverified(false);
    this.todosSyncPending[1](this.todos[0]().length > 0);
    this.closeHost();
    this.providerRetry[1](null);
    this.reconnect[1](null);
    this.setConnection("reconnecting");
    this.unloadForBackground();
  }

  /** Evict non-recent background transcript data while keeping tab metadata/draft. */
  evictView(): void {
    if (this.active) return;
    this.releaseBuffers(true);
    this.hydrated[1](false);
    this.contentStatus[1]({});
    this.mutate((draft) => Object.assign(draft, emptySession()));
  }

  /** 卸载重状态:转录、审批/待办全量列表。轻量信号(title 等)保留。 */
  private unloadForBackground(): void {
    this.releaseBuffers();
    this.clearCancelWatchdog();
    this.loadingOlder[1](false);
    this.waitFrom = null;
    this.activeTurnStartedAt = null;
    this.activeModelBlockIds.clear();
    this.composerMetrics[1]((current) => ({ ...current, isStreaming: false, isGeneratingToolInput: false }));
    this.pending[1]([]);
    this.todos[1]([]);
    this.todosSyncPending[1](false);
    // Keep the bounded visible window in the session store. Reactivation installs
    // a new authoritative bootstrap over it, so the old text remains readable.
  }

  /** 卸载时丢弃引用缓存与排队任务，旧异步响应不得恢复后台转录。 */
  private releaseBuffers(evictContentCache = false): void {
    this.bootstrapRequestId++;
    this.contentLoader.clear(evictContentCache);
    if (this.todoRetryTimer != null) clearTimeout(this.todoRetryTimer);
    this.todoRetryTimer = null;
    this.todoRefreshPending = false;
    if (this.approvalRetryTimer != null) clearTimeout(this.approvalRetryTimer);
    this.approvalRetryTimer = null;
    this.approvalRefreshPending = false;
    this.activationGeneration++;
    this.approvalGeneration++;
  }

  private hydrateContent(refs: Iterable<string> = pendingContentRefs(this.stateGet)): void {
    for (const ref of refs) this.contentLoader.request(ref);
    this.hydrated[1](true);
  }

  dispose(): void {
    this.disposed = true;
    this.providerRetry[1](null);
    this.reconnect[1](null);
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
    this.clearCancelWatchdog();
    this.closeHost();
    this.unloadForBackground();
  }

  retry(): void {
    // 重连/退避在宿主侧,这里只触发宿主重建流(用户点「重试」/窗口聚焦)。
    this.providerRetry[1](null);
    this.reconnect[1](null);
    this.setConnection("reconnecting");
    this.host().streamsRetry(this.seed).catch(() => this.setConnection("offline"));
  }

  retryContent(): void {
    this.contentLoader.retryFailed();
    this.hydrateContent();
  }

  private setConnection(kind: ConnectionKind): void {
    this.connection[1](kind);
  }

  get synchronization(): ConnectionKind { return this.connection[0](); }
  get contentLoading(): boolean { return Object.values(this.contentStatus[0]()).includes("loading"); }
  get contentFailures(): number { return Object.values(this.contentStatus[0]()).filter((status) => status === "failed").length; }

  private closeHost(): void {
    this.hostUnlisten?.();
    this.hostUnlisten = null;
  }

  // ── 宿主事件订阅 (projection://*, conn://*) ────────────────────────────────

  private async connectHost(): Promise<void> {
    if (this.disposed) return;
    this.closeHost();
    this.setConnection("reconnecting");
    const handlers: StreamHandlers = {
      onProjectionStatus: (status: ProjectionStatusWire) => {
        if (status.session_id != null && status.session_id !== this.seed) return;
        if (status.status === "live") {
          const reconnected = this.connection[0]() !== "connected";
          this.setConnection("connected");
          this.reconnect[1](null);
          if (reconnected) {
            this.markApprovalsUnverified(false);
            void this.refreshApprovals();
            void this.refreshTodos();
            if (this.hasBeenLive) this.onConnectionRestored?.();
            this.hasBeenLive = true;
          }
        } else if (status.status === "closed" || status.status === "paused") {
          this.reconnect[1](null);
          this.markApprovalsUnverified(false);
          this.setConnection("offline");
        } else {
          this.setConnection("reconnecting");
        }
      },
      onProjectionBootstrap: (seed, bootstrap) => {
        if (seed !== this.seed || !this.active) return;
        this.installBootstrap(bootstrap);
      },
      onProjectionEvent: (seed, event) => {
        if (seed !== this.seed || !this.active) return;
        this.applyProjection(event);
      },
      onProjectionReset: (seed) => {
        if (seed !== this.seed) return;
        this.approvalGeneration++;
        this.markApprovalsUnverified(false);
        this.providerRetry[1](null);
        this.contentLoader.clear(false);
        this.contentStatus[1]({});
        this.onSessionsChanged?.();
      },
      onIncompatible: () => {},
      onHostError: () => {},
      onReconnect: (info) => {
        if (info.session_id !== this.seed) return;
        this.reconnect[1]({ attempt: info.attempt, delayMs: info.delay_ms, at: info.at });
        this.setConnection("reconnecting");
      },
    };
    try {
      this.hostUnlisten = await this.host().subscribe(handlers);
    } catch {
      this.setConnection("offline");
    }
  }

  /** Load the typed authoritative session bootstrap. */
  async loadBootstrap(): Promise<void> {
    if (this.disposed) return;
    const requestId = ++this.bootstrapRequestId;
    try {
      const bootstrap = await transport.sessionBootstrap(this.seed);
      if (this.disposed || requestId !== this.bootstrapRequestId) return;
      this.installBootstrap(bootstrap);
    } catch {
      if (!this.disposed && requestId === this.bootstrapRequestId) this.loadError[1](true);
    }
  }

  private installBootstrap(bootstrap: SessionBootstrap): void {
    if (this.disposed || !this.active || bootstrap.session_id !== this.seed || !bootstrap.state) return;
    this.contentLoader.clear(false);
    this.contentStatus[1]({});
    const refs = pendingContentRefsFromSnapshot(bootstrap.state);
    this.mutate((draft) => { applySessionBootstrap(draft, bootstrap); });
    this.contentLoader.retryFailed();
    this.hydrateContent(refs);
    this.loadError[1](false);
    this.hydrated[1](true);
    const waiting = bootstrap.state.interactions.some((item) => item.resolution == null);
    this.activity[1](waiting ? "waiting_user" : normalizeActivity(bootstrap.state.activity, "projection"));
    if (typeof bootstrap.state.title === "string") this.applySessionMeta({ title: bootstrap.state.title });
  }

  // ── Flattened SessionEventFrame reducer ────────────────────────────────────

  private applyProjection(event: SessionEventFrame): void {
    const refs = contentRefsInPayload(event);
    this.mutate((draft) => {
      applySessionEvent(draft, event);
      draft.watermark = event.seq;
    });
    if (refs.size > 0) this.hydrateContent(refs);

    switch (event.type) {
      case "activity_changed": {
        const waiting = this.stateGet.interactionIds.length > 0;
        this.activity[1](waiting ? "waiting_user" : normalizeActivity(event.activity, "projection"));
        break;
      }
      case "turn_started":
        this.clearCancelWatchdog();
        this.isSending[1](false);
        this.activeTurnStartedAt = now();
        this.activeModelBlockIds.clear();
        this.activeOutputStartedAt = null;
        this.activeOutputEndedAt = null;
        this.activeOutputActiveMs = 0;
        this.composerMetrics[1]((current) => ({ ...current, isStreaming: false, isGeneratingToolInput: false }));
        break;
      case "turn_phase_changed":
        this.activity[1](event.phase === "waiting_user" ? "waiting_user" : event.phase === "cancelling" ? "cancelling" : "working");
        break;
      case "turn_ended": {
        if (event.outcome.kind === "finished" && event.outcome.data.usage) this.updateComposerUsage(event.outcome.data.usage);
        this.clearCancelWatchdog();
        this.isSending[1](false);
        this.activeTurnStartedAt = null;
        this.activeModelBlockIds.clear();
        this.composerMetrics[1]((current) => ({ ...current, isStreaming: false, isGeneratingToolInput: false }));
        // refreshProfile 会重发 profile 视图（含模型目录推出的 context 窗口）；
        // 这里不再额外调 refreshConfigView——同步重发会把未选择会话的分母清空，
        // 盖掉刚结算的 usage 百分比。
        void this.refreshProfile();
        void this.refreshTodos();
        void this.refreshApprovals();
        this.onSessionsChanged?.();
        break;
      }
      case "timeline_appended":
        if (event.entry.kind === "assistant_block" && event.entry.data.usage) this.updateComposerUsage(event.entry.data.usage);
        if (event.entry.kind === "input" && this.isSending[0]()) this.isSending[1](false);
        break;
      case "tool_finished":
        void this.refreshApprovals();
        void this.refreshTodos();
        this.onSessionsChanged?.();
        break;
      case "exec_session_started":
      case "exec_session_state_changed":
      case "exec_session_finished":
        this.onSessionsChanged?.();
        break;
      case "interaction_requested":
      case "interaction_resolved":
        this.approvalGeneration++;
        this.markApprovalsUnverified(true);
        void this.refreshApprovals();
        void this.refreshActivity();
        this.onSessionsChanged?.();
        break;
      case "session_meta_changed":
        this.applySessionMeta({ title: event.title ?? null });
        if (event.title) this.onSessionTitleChanged?.(event.title);
        this.onSessionsChanged?.();
        break;
      case "tool_arguments_delta":
      case "tool_state_changed":
      case "exec_session_output_delta":
      case "tool_output_delta":
      case "message_delta":
      case "subagent_updated":
        break;
    }
  }

  private updateComposerUsage(usage: UsageInfo): void {
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
      isGeneratingToolInput: false,
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
   * 取全局配置的 composer 视图。ConfigDto 已不再携带端点族字段
   * （context_length 随 providers.toml 目录走），这里只剩广播刷新：
   * 上下文窗口由 `publishProfileView` 按会话有效模型的 `context_window` 给出。
   */
  private async refreshConfigView(): Promise<void> {
    if (this.disposed) return;
    const refreshId = ++this.contextRefreshId;
    if (this.disposed || refreshId !== this.contextRefreshId) return;
    this.publishProfileView();
  }

  /** 拼 composer 视图：`session.meta` 的 model_selection + provider 目录。 */
  private publishProfileView(): void {
    const selection = this.metaModelSelection;
    if (selection != null) {
      const provider = registry()?.providers.find((item) => item.id === selection.provider_id);
      const definition = provider?.models.find((item) => item.id === selection.model_id)?.definition;
      const contextLength = definition?.context_window ?? null;
      this.composerModelOverride[1](true);
      this.composerModel[1](selection.model_id);
      this.composerEffortOverride[1](selection.options.reasoning_effort != null);
      this.composerEffort[1](selection.options.reasoning_effort ?? definition?.defaults.reasoning_effort ?? null);
      this.composerMaxTokens[1](selection.options.max_output_tokens ?? definition?.defaults.max_output_tokens ?? definition?.max_output_tokens ?? null);
      this.composerContextLength[1](contextLength);
      if (contextLength != null) { this.contextLength = contextLength; this.publishContextPercent(); }
      this.composerProfile[1]({ effective: provider?.name ?? selection.provider_id,
        model: selection.model_id, providerKind: providerKindOfCredential(provider?.credential) });
      return;
    }
    this.composerModelOverride[1](false);
    this.composerModel[1](null);
    this.composerEffortOverride[1](false);
    this.composerEffort[1](null);
    this.composerMaxTokens[1](null);
    this.composerContextLength[1](null);
    this.contextLength = null;
    this.publishContextPercent();
    this.composerProfile[1]({ effective: null,
      model: null, providerKind: providerKindOfCredential(undefined) });
  }

  /**
   * 重读会话自己的 profile。必须重读而不能乐观落库:daemon 的 ack 只表示命令
   * 进了队,重载要等 turn 边界才发生,而 meta.json 写得更早(spec §1.5)。
   */
  async refreshProfile(): Promise<void> {
    if (this.disposed) return;
    const refreshId = ++this.profileRefreshId;
    try {
      const meta = await transport.query("session.meta", { session_id: this.seed }) as SessionMetaWire | null;
      if (registry() == null) await refreshRegistry();
      if (this.disposed || refreshId !== this.profileRefreshId) return;
      this.metaModelSelection = meta?.model_selection ?? null;
      this.metaSettingsRevision = typeof meta?.settings_revision === "number" ? meta.settings_revision : null;
      // 同一次 RPC 顺带取工具模式:后端 meta 空串 = standard(零迁移),前端
      // 不认识的模式名原样显示(与 effort 的 offLadder 同一取舍),不冒充。
      this.metaToolMode =
        typeof meta?.tool_mode === "string" && meta.tool_mode !== "" ? meta.tool_mode : "standard";
      this.metaCustomTools = Array.isArray(meta?.custom_tools)
        ? meta.custom_tools.filter((name): name is string => typeof name === "string")
        : [];
      this.composerToolMode[1]({ mode: this.metaToolMode, customTools: this.metaCustomTools });
    } catch {
      // best-effort:选择器退回「跟随全局」,下一次 turn 结束再取。
    }
    this.publishProfileView();
  }

  async setSessionSelection(providerId: string, modelId: string): Promise<void> {
    await this.patchSessionSettings({ model_selection: { kind: "use", value: {
      provider_id: providerId, model_id: modelId, options: {},
    } } });
  }

  /** 会话级换思考强度 effort;`null` = 清除选择、回到跟随 profile 默认。 */
  async setSessionEffort(effort: string | null): Promise<void> {
    const current = this.metaModelSelection;
    if (!current) throw new Error("请先选择服务商和模型");
    await this.patchSessionSettings({ model_selection: { kind: "use", value: {
      ...current, options: { ...current.options, reasoning_effort: effort },
    } } });
  }

  /** Model selection is a full provider/model pair in the v3 settings patch. */
  async setSessionModel(model: string | null): Promise<void> {
    if (model == null) throw new Error("请选择服务商和模型");
    const current = this.metaModelSelection;
    if (!current) throw new Error("当前会话没有可继承的 provider 选择，请先选择 Profile 或 provider");
    await this.patchSessionSettings({ model_selection: { kind: "use", value: { ...current, model_id: model } } });
  }

  /** 会话级单回合输出上限;`null` = 跟随 Profile。 */
  async setSessionMaxTokens(maxTokens: number | null): Promise<void> {
    const current = this.metaModelSelection;
    if (!current) throw new Error("当前会话没有可继承的 model_selection，请先选择 Profile 或 provider");
    await this.patchSessionSettings({
      model_selection: {
        kind: "use",
        value: { ...current, options: { ...current.options, max_output_tokens: maxTokens } },
      },
    });
  }

  private async patchSessionSettings(patch: SessionSettingsPatch): Promise<void> {
    if (this.metaSettingsRevision == null) await this.refreshProfile();
    const revision = this.metaSettingsRevision;
    if (revision == null) throw new Error("无法读取会话设置版本，请刷新会话后重试");
    try {
      const ack = await transport.command(
        { type: "session.settings.patch", patch },
        sessionTarget(this.seed),
        [{ kind: "settings_revision", revision }],
      );
      this.metaSettingsRevision = typeof ack.revision === "number" ? ack.revision : null;
      await this.refreshProfile();
    } catch (error) {
      if (String((error as { code?: unknown })?.code ?? "").includes("revision")
        || String(error instanceof Error ? error.message : error).includes("409")) {
        this.metaSettingsRevision = null;
        await this.refreshProfile();
        throw new Error("会话设置已被其他客户端修改，当前更改没有覆盖新值；请重新选择后再试", { cause: error });
      }
      throw error;
    }
  }

  /**
   * 会话级换工具模式(`session.settings.patch.tools`)。
   *
   * 与 effort 不同,这里**先乐观落信号再发命令**:切档是低频显式操作,
   * 弹卡已经关了,回滚靠 `refreshProfile()` 重读 meta(后端持久化失败
   * 返回 400,meta 未动,重读即恢复真值)。失败把异常抛给调用方出 toast。
   */
  async setSessionToolMode(mode: string, customTools: string[]): Promise<void> {
    this.metaToolMode = mode === "" ? "standard" : mode;
    this.metaCustomTools = customTools;
    this.composerToolMode[1]({ mode: this.metaToolMode, customTools: this.metaCustomTools });
    try {
      await this.patchSessionSettings({ tools: toolsSettingPatch(this.metaToolMode, customTools) });
    } finally {
      // 成功:重读对账(daemon ack ≠ 已应用);失败:重读即回滚。
      await this.refreshProfile();
    }
  }

  async refreshActivity(): Promise<void> {
    try {
      const bootstrap = await this.host().sessionBootstrap(this.seed);
      if (this.disposed || !this.active) return;
      const waiting = bootstrap.state.interactions.some((item) => item.resolution == null);
      this.activity[1](waiting ? "waiting_user" : normalizeActivity(bootstrap.state.activity, "projection"));
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
    if (this.todoRetryTimer != null) {
      clearTimeout(this.todoRetryTimer);
      this.todoRetryTimer = null;
    }
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
    const activation = this.activationGeneration;
    while (this.todoRefreshPending && !this.disposed && activation === this.activationGeneration) {
      this.todoRefreshPending = false;
      try {
        const result = await transport.query("todo.list", { session_id: this.seed });
        if (this.disposed || activation !== this.activationGeneration || this.todoRefreshPending) continue;
        if (!Array.isArray(result?.items)) throw new Error("todo.list response is missing items");
        writeStable(this.todos, result.items as TodoItemWire[]);
        this.todosSyncPending[1](false);
        this.todoFailures = 0;
        if (this.todoRetryTimer != null) clearTimeout(this.todoRetryTimer);
        this.todoRetryTimer = null;
      } catch (error) {
        // Preserve the last successful list, expose stale state and retry without
        // waiting for another tool or user action.
        if (!this.disposed && activation === this.activationGeneration) {
          this.todosSyncPending[1](true);
          console.warn("[qaqh-webui] todo.list refresh failed", error);
          this.scheduleTodoRetry();
        }
      }
    }
  }

  // ── 审批(单源:approvals RPC) ───────────────────────────────────────────────

  private scheduleTodoRetry(): void {
    if (!this.active || this.disposed || this.todoRetryTimer != null) return;
    this.todoFailures++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.todoFailures - 1, 6));
    this.todoRetryTimer = setTimeout(() => {
      this.todoRetryTimer = null;
      void this.refreshTodos();
    }, delay);
  }

  private scheduleApprovalRetry(): void {
    this.scheduleApprovalRevalidation();
  }

  private markApprovalsUnverified(revokeChallenges = true): void {
    const current = this.markApprovalsUnverifiedLocally();
    if (current.length > 0) {
      for (const view of current) void transport.invalidateApprovals(this.seed, view.challenge_id, revokeChallenges ? "revoke" : false).catch(() => {});
    }
  }

  /** Lock renderer actions without invalidating the host challenge in flight. */
  private markApprovalsUnverifiedLocally(): ApprovalView[] {
    this.approvalsVerified = false;
    this.approvalsVerifiedState[1](false);
    const current = this.pending[0]();
    if (current.length > 0) writeStable(this.pending, current.map((view) => ({ ...view, verified: false })));
    return current;
  }

  private scheduleApprovalRevalidation(): void {
    if (!this.active || this.disposed || this.approvalRetryTimer != null) return;
    this.approvalFailures++;
    const delay = Math.min(15_000, 300 * 2 ** Math.min(this.approvalFailures - 1, 6));
    this.approvalRetryTimer = setTimeout(() => {
      this.approvalRetryTimer = null;
      void this.refreshApprovals();
    }, delay);
  }

  refreshApprovals(): Promise<void> {
    if (this.disposed || !this.active) return Promise.resolve();
    this.markApprovalsUnverified(false);
    if (this.approvalRetryTimer != null) {
      clearTimeout(this.approvalRetryTimer);
      this.approvalRetryTimer = null;
    }
    this.approvalRefreshPending = true;
    if (this.approvalRefresh != null) return this.approvalRefresh;
    const activation = this.activationGeneration;
    const run = async (): Promise<void> => {
      while (this.approvalRefreshPending && this.active && !this.disposed && activation === this.activationGeneration) {
        this.approvalRefreshPending = false;
        const generation = this.approvalGeneration;
        const eventRevision = this.approvalEventRevision;
        try {
          const response = await transport.approvals(this.seed) as ApprovalView[] & { control_revision?: number };
          if (this.disposed || !this.active || activation !== this.activationGeneration) return;
          if (generation !== this.approvalGeneration || eventRevision !== this.approvalEventRevision) {
            this.approvalRefreshPending = true;
            continue;
          }
          const raw = Array.isArray(response) ? response : [];
          const observedChallenges = new Set(raw.map((view) => view.challenge_id));
          for (const old of this.pending[0]()) {
            if (observedChallenges.has(old.challenge_id)) {
              void transport.invalidateApprovals(this.seed, old.challenge_id, raw.find((view) => view.challenge_id === old.challenge_id)?.verified === true).catch(() => {});
            } else void transport.invalidateApprovals(this.seed, old.challenge_id, "revoke").catch(() => {});
          }
      const next = raw.map((view) => ({ ...view, verified: view.verified === true }));
          const previous = this.pending[0]();
          writeStable(this.pending, next);
          this.recordWaitTransition(previous, next);
          this.approvalsVerified = next.every((view) => view.verified === true);
          this.approvalsVerifiedState[1](this.approvalsVerified);
          if (this.approvalsVerified) this.approvalFailures = 0;
          if (!this.approvalsVerified) {
            this.markApprovalsUnverified(false);
            this.scheduleApprovalRetry();
          }
          if (this.approvalsVerified && this.approvalRetryTimer != null) {
            clearTimeout(this.approvalRetryTimer);
            this.approvalRetryTimer = null;
          }
          if (next.some((view) => view.details_unavailable === true || view.details?.details_unavailable === true)) {
            this.scheduleApprovalRetry();
          }
          this.activity[1](next.length > 0 ? "waiting_user" : this.activityIsWorking() ? "working" : "idle");
        } catch (error) {
          if (this.disposed || !this.active || activation !== this.activationGeneration) return;
          console.warn("[qaqh-webui] approvals refresh failed", error);
          this.markApprovalsUnverified(false);
          this.scheduleApprovalRetry();
        }
      }
    };
    this.approvalRefresh = run().finally(() => {
      this.approvalRefresh = null;
      if (this.approvalRefreshPending && this.active && !this.disposed) void this.refreshApprovals();
    });
    return this.approvalRefresh;
  }

  private activityIsWorking(): boolean {
    const activity = this.activity[0]();
    return activity === "working" || activity === "cancelling";
  }

  /** 0→N 开区间 / N→0 闭区间,挂到当前运行回合(spec D3:已工作扣除等待)。 */
  private recordWaitTransition(previous: ApprovalView[], next: ApprovalView[]): void {
    if (previous.length === 0 && next.length > 0) {
      const kind = next[0]!.kind === "ask" ? "ask" : "approval";
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
    const view = this.pending[0]().find((item) => item.challenge_id === challengeId);
    const approvalDecision = decision === "approve" || decision === "trust" || decision === "submit";
    if (approvalDecision && (!this.approvalsVerified || view?.verified !== true || view.details_unavailable === true || view.details?.details_unavailable === true)) {
      this.scheduleApprovalRevalidation();
      throw new Error("approval_not_verified_or_details_unavailable");
    }
    if (this.connection[0]() !== "connected" && decision !== "reject" && decision !== "dismiss") {
      throw new Error("approval_connection_unverified");
    }
    // Keep the renderer locked during submission, but leave this challenge
    // verified in the host until respond_approval consumes it.
    this.markApprovalsUnverifiedLocally();
    try {
      await transport.respondApproval(this.seed, challengeId, decision, payload);
    } finally {
      // 宿主 challenge 一次性消费；daemon 拒绝或 IPC 短暂失败时也必须重取，
      // 让仍然 pending 的交互获得新 challenge，避免界面卡在已消费的旧 ID 上。
      await this.refreshApprovals();
    }
  }

  // ── 动作 ────────────────────────────────────────────────────────────────────

  async sendMessageWithAttachments(text: string, attachments: SessionContentRef[] = []): Promise<void> {
    this.isSending[1](true);
    try {
      await transport.command(
        { type: "conversation.send_message", text, attachments, input_purpose: "trigger_turn" },
        sessionTarget(this.seed),
      );
    } catch (error) {
      this.isSending[1](false);
      throw error;
    }
  }

  async interruptExecSession(id: string): Promise<void> {
    await transport.command({ type: "exec_session.interrupt" }, execSessionTarget(id));
  }

  async terminateExecSession(id: string): Promise<void> {
    await transport.command({ type: "exec_session.terminate" }, execSessionTarget(id));
  }

  /** Load one evicted source turn for a session-level execution card. */
  async loadExecSessionOrigin(turnId: string): Promise<void> {
    if (this.stateGet.originTurns[turnId]) return;
    const snapshot = await transport.query("session.turn", { session_id: this.seed, turn_id: turnId });
    if (!snapshot) return;
    this.mutate((draft) => { draft.originTurns[turnId] = snapshot; });
    this.hydrateContent(contentRefsInPayload(snapshot));
  }

  async sendMessage(text: string): Promise<void> {
    const attachments = this.pendingAttachments[0]()
      .filter((item) => item.state === "ready" && item.reference != null)
      .map((item) => item.reference as SessionContentRef);
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
          reference: uploaded.content_ref,
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

  /**
   * 停止当前回合。
   *
   * 默认**不带** `turn_id`。后端 §7（e5bc39c）之后只有「取消当前回合」
   * （`turn_id: null`）在 registry 入队时就置位取消标记，gate 流式与在途工具
   * 下一个轮询点就能看到；显式 `turn_id` 的取消要先经 actor 校验，而 actor 的
   * 常规派发只在回合结束后发生——那等于「等回合自己结束才取消」。长回合
   * （工具自循环、子代理未收尾）里停止按钮因此完全无效，命令收据也永远停在
   * Running（BUG-2026-10-28，实测 340s 后回合仍在跑）。
   *
   * 需要取消某个特定回合（多客户端/历史视图）时才传 `turnId`，并接受它只在
   * 回合边界生效的语义。
   */
  async cancelTurn(options: { turnId?: string | null } = {}): Promise<void> {
    const turnId = options.turnId ?? null;
    await transport.command({ type: "conversation.cancel", turn_id: turnId }, sessionTarget(this.seed));
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
      this.composerMetrics[1]((current) => ({ ...current, isStreaming: false, isGeneratingToolInput: false }));
      // 蓝点:后端仍报 working(卡死的 actor),本地先按已中断呈现;
      // 真实 activity 投影到达时会被覆盖。
      if (this.activity[0]() === "working") this.activity[1]("interrupted");
      this.mutate((draft) => {
        forceSealTurn(draft, turnId, "cancelled");
      });
      void this.loadBootstrap();
    }, CANCEL_WATCHDOG_MS);
  }

  private clearCancelWatchdog(): void {
    if (this.cancelWatchdog != null) {
      clearTimeout(this.cancelWatchdog);
      this.cancelWatchdog = null;
    }
  }

  async createSession(): Promise<void> {
    await transport.command({ type: "session.create" });
  }

  /** 向上翻页：单流由 bootstrap 提供全量快照，无 timeline 分页。 */
  async loadOlder(): Promise<boolean> {
    return false;
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
