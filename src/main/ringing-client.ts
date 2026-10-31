// Ringing v2 transport adapter over @qaqh/sdk.
//
// Owns the EventSender contract consumed by the renderer
// (projection://*, conn://liveness); all HTTP/SSE/lease
// mechanics — cursor resumption, backoff reconnects, lease renewal with
// credential refresh, multipart content upload — live in the SDK.
import {
  createClient,
  SdkError,
  type ApprovalsView,
  type ClientV2Bootstrap,
  type ClientState,
  type RingingClient as SdkRingingClient,
  type SessionWatch,
  type WatchStatus,
} from "@qaqh/sdk";
import { readDiscovery } from "./daemon.js";
import { requireAccepted, requireId } from "./approvals.js";
import type { ControlCommand, ConversationCommand, RingingChannel, RingingCommand, ToolCommand } from "@qaqh/sdk/protocol";
import type {
  DaemonDiscovery,
  ProjectionStatusWire,
  ReconnectStatusWire,
  RingingCommandAck,
} from "./types.js";

export type EventSender = (eventName: string, payload: any) => void;

type CommandByChannel = { control: ControlCommand; conversation: ConversationCommand; tool: ToolCommand };
const RECOVERABLE_RESETS = new Set([
  "cursor_expired", "log_id_mismatch", "replay_overflow", "epoch_mismatch",
  "snapshot_missing", "snapshot_expired", "snapshot_hash_mismatch",
  "per_connection_overflow", "progress_buffer_overflow",
]);
const MAX_PROJECTION_RESYNCS = 3;

export class RingingClient {
  private readonly sdk: SdkRingingClient;
  private readonly eventSender: EventSender;
  private activeSeed: string | null = null;
  private sessionWatch: SessionWatch | null = null;
  private streamGeneration = 0;
  private projectionStatus: WatchStatus = "closed";
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncAttempts = 0;

  constructor(discovery: DaemonDiscovery, eventSender: EventSender) {
    this.eventSender = eventSender;
    this.sdk = createClient({
      credentials: discovery,
      // Daemon restarts re-publish daemon.json (new port/token); the SDK
      // consults this hook before every recovery reconnect.
      refreshCredentials: async () => {
        const fresh = await readDiscovery();
        if (!fresh) throw new Error("daemon discovery document disappeared");
        return fresh;
      },
      logger: console,
    });
    this.sdk.onStateChange((state: ClientState) => {
      if (state === "recovering") console.warn("[ringing] Lease lost; SDK is recovering");
    });
  }

  async init(): Promise<void> {
    await this.sdk.connect();
  }

  getActiveSeed(): string | null {
    return this.activeSeed;
  }

  async attach(seed: string, _limit: number | null = null): Promise<void> {
    requireId(seed, "session_id");
    this.detachActive();
    this.activeSeed = seed;
    const generation = this.streamGeneration;
    const isCurrent = () => this.activeSeed === seed && this.streamGeneration === generation;
    this.projectionStatus = "connecting";
    this.sendProjectionStatus("connecting", seed);

    // 1. session_resume 绑定该 seed 的展示通道（拒绝不影响只读 attach）
    await this.command("control", { type: "session_resume", session_id: seed }, seed)
      .then(requireAccepted).catch((err) => {
        if (isCurrent()) this.reportError(`session_resume failed for ${seed}`, err);
      });
    if (!isCurrent()) return;

    // 2. 投影单流（bootstrap + since_cursor 无缝续传）
    this.sessionWatch = this.sdk.watchSession(
      seed,
      {
        onBootstrap: () => {
          if (!isCurrent()) return;
          // Initial attach and resync both rebuild the authoritative approvals.
          this.eventSender("projection://reset", { session_id: seed, reason: "bootstrap" });
        },
        onEvent: (envelope) => {
          if (!isCurrent()) return;
          this.resyncAttempts = 0;
          this.eventSender("conn://liveness", {});
          this.eventSender("projection://event", envelope);
        },
        onReset: (reset) => {
          if (!isCurrent()) return;
          console.warn(`[ringing] Reset required (${reset.reason}) for ${seed}`);
          this.eventSender("projection://reset", { ...reset, session_id: reset.session_id || seed });
          if (RECOVERABLE_RESETS.has(reset.reason)) this.scheduleProjectionResync(seed, generation);
          else this.reportError(`Session stream paused for ${seed}: ${reset.reason}`);
        },
        onStatus: (status) => {
          if (!isCurrent()) return;
          this.projectionStatus = status;
          this.sendProjectionStatus(status, seed);
        },
        onReconnectScheduled: ({ attempt, delayMs }) => {
          if (isCurrent()) this.sendReconnectScheduled(seed, attempt, delayMs);
        },
        onTerminated: (info) => {
          if (isCurrent()) this.reportError(`Session stream terminated (${info.code}) for ${seed}: ${info.message}`);
        },
        onError: (error) => { if (isCurrent()) this.reportError(`Session watch error for ${seed}`, error); },
      },
      { skipBootstrap: false }
    );
  }

  detachActive(): void {
    this.streamGeneration += 1;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    this.resyncAttempts = 0;
    this.sessionWatch?.close();
    this.sessionWatch = null;
    this.projectionStatus = "closed";
    if (this.activeSeed) {
      this.sendProjectionStatus("closed", this.activeSeed);
      this.activeSeed = null;
    }
  }

  async command<C extends RingingChannel>(
    channel: C,
    cmd: CommandByChannel[C],
    targetSeed?: string | null
  ): Promise<RingingCommandAck> {
    const target = targetSeed === undefined ? this.activeSeed : targetSeed;
    if (target !== null) requireId(target, "session_id");
    try {
      const { ack } = await this.sdk.submit(channel, { ...cmd, channel } as RingingCommand, target);
      return {
        status: ack.status,
        command_id: ack.command_id,
        code: ack.code ?? undefined,
        message: ack.message ?? undefined,
        retry_after_ms: ack.retry_after_ms ?? undefined,
      };
    } catch (err) {
      // 维持旧契约：daemon 明确拒绝时返回 rejected ack 而不是抛错；其余错误上抛。
      if (err instanceof SdkError && err.kind === "command_rejected") {
        return { status: "rejected", command_id: err.commandId, code: err.code, message: err.message };
      }
      // 提交超时 = 结果未知：命令可能已被 daemon 接受。按 command_id 轮询
      // commandStatus 闭环，而不是把未知结果当失败抛给渲染层。
      if (err instanceof SdkError && err.kind === "outcome_unknown" && err.commandId) {
        const resolved = await this.sdk.resolveOutcome(err, { timeoutMs: 10_000 }).catch(() => null);
        if (resolved) {
          if (resolved.state === "succeeded") {
            return { status: "accepted", command_id: resolved.command_id };
          }
          if (resolved.state === "rejected") {
            return {
              status: "rejected",
              command_id: resolved.command_id,
              code: resolved.error_code ?? undefined,
              message: "command rejected (resolved via commandStatus)",
            };
          }
          if (resolved.state === "failed") {
            return { status: "rejected", command_id: resolved.command_id, code: resolved.error_code ?? undefined, message: "command execution failed (resolved via commandStatus)" };
          }
        }
      }
      throw err;
    }
  }

  async serviceRpc<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
    // ServiceMap covers only the exported typed slice, not every implemented
    // backend service. Dynamic names use the same route at runtime.
    return this.sdk.service(method as never, params as never) as Promise<T>;
  }

  adminService<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
    return this.sdk.adminService<T>(method, params);
  }

  adminSessionService<T = unknown>(method: string, seed: string, params: Record<string, any> = {}): Promise<T> {
    return this.sdk.adminService<T>(method, { ...params, session_id: seed });
  }

  adminRequest<T = unknown>(credential: { endpoint: string; token: string }, path: string, init: { method: string; body?: BodyInit; contentType?: string | false }): Promise<T> {
    return this.sdk.adminRequest<T>(credential, path, init);
  }

  /** Canonical bootstrap 快照（渲染层读取 control.state.activity 与 conversation）。 */
  bootstrap(seed: string): Promise<ClientV2Bootstrap> {
    return this.sdk.bootstrap(seed);
  }

  async readContentText(contentRef: string): Promise<string> {
    const content = await this.sdk.downloadContent(contentRef);
    return new TextDecoder("utf-8", { fatal: true }).decode(content.bytes);
  }

  /** approvals.admin capability；渲染层拿到的仍是 ChallengeManager 发出的 challenge 视图。 */
  approvals(seed: string): Promise<ApprovalsView> {
    return this.sdk.approvals(seed);
  }

  async uploadContent(seed: string, _filename: string, buffer: Uint8Array, mediaType: string): Promise<any> {
    return this.sdk.uploadContent(seed, { bytes: buffer, mediaType });
  }

  stopDaemon(idleOnly: boolean): Promise<"stopping" | "busy" | "unsupported"> {
    return this.sdk.stopDaemon(idleOnly);
  }

  issuePairToken(request: { scope_grant: string; device_name: string; platform: string }) {
    return this.sdk.issuePairToken(request);
  }

  listDevices() { return this.sdk.listDevices(); }

  revokeDevice(deviceId: string): Promise<void> { return this.sdk.revokeDevice(deviceId); }

  reconnect(): Promise<void> {
    this.detachActive();
    return this.sdk.reconnect().then(() => {});
  }

  reconnectWithCredentials(credentials: DaemonDiscovery): Promise<void> {
    this.detachActive();
    return this.sdk.reconnectWithCredentials(credentials).then(() => {});
  }

  destroy(): void {
    this.detachActive();
    void this.sdk.disconnect();
  }

  getProjectionStatus(seed: string): WatchStatus {
    return this.activeSeed === seed ? this.projectionStatus : "closed";
  }

  private sendProjectionStatus(status: WatchStatus, seed: string): void {
    this.eventSender("projection://status", {
      status,
      session_id: seed,
    } satisfies ProjectionStatusWire);
  }

  private sendReconnectScheduled(seed: string, attempt: number, delayMs: number): void {
    this.eventSender("conn://reconnect", {
      session_id: seed,
      attempt,
      delay_ms: delayMs,
      at: Date.now(),
    } satisfies ReconnectStatusWire);
  }

  private reportError(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${message}: ${error.message}` : message;
    console.warn(`[ringing] ${detail}`);
    this.eventSender("conn://error", { message: detail });
  }

  private scheduleProjectionResync(seed: string, generation: number): void {
    if (this.resyncTimer || this.activeSeed !== seed || this.streamGeneration !== generation) return;
    if (this.resyncAttempts >= MAX_PROJECTION_RESYNCS) {
      this.reportError(`Session stream recovery exhausted for ${seed}; retry the connection`);
      return;
    }
    const delay = 250 * 2 ** this.resyncAttempts++;
    // Defer until the SDK has finished pausing the old pump. Never resync
    // synchronously inside onReset: the SDK sets paused after that callback.
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (this.activeSeed !== seed || this.streamGeneration !== generation) return;
      const watch = this.sessionWatch;
      if (!watch) return;
      this.projectionStatus = "reconnecting";
      this.sendProjectionStatus("reconnecting", seed);
      void watch.resync().catch(error => {
        if (this.activeSeed !== seed || this.streamGeneration !== generation) return;
        this.projectionStatus = "paused";
        this.sendProjectionStatus("paused", seed);
        this.reportError(`Session resync failed for ${seed}`, error);
        this.scheduleProjectionResync(seed, generation);
      });
    }, delay);
  }
}
