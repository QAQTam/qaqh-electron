// Ringing v2 transport adapter over @qaqh/sdk.
//
// Owns the legacy EventSender contract consumed by the renderer
// (timeline://*, projection://*, conn://liveness); all HTTP/SSE/lease
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
  type TimelineWatch,
  type WatchStatus,
} from "@qaqh/sdk";
import { readDiscovery } from "./daemon.js";
import type { DaemonDiscovery, RingingCommandAck, TimelineStatusWire } from "./types.js";

export type EventSender = (eventName: string, payload: any) => void;

const TIMELINE_STATUS_BY_WATCH: Record<WatchStatus, TimelineStatusWire["status"]> = {
  connecting: "connecting",
  live: "open",
  reconnecting: "reconnecting",
  paused: "closed",
  closed: "closed",
};

export class RingingClient {
  private readonly sdk: SdkRingingClient;
  private readonly eventSender: EventSender;
  private activeSeed: string | null = null;
  private sessionWatch: SessionWatch | null = null;
  private timelineWatch: TimelineWatch | null = null;

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

  async attach(seed: string, limit: number | null = null): Promise<void> {
    if (this.activeSeed !== seed) {
      this.detachActive();
      this.activeSeed = seed;
    }

    // 1. session_resume 绑定该 seed 的展示通道（拒绝不影响只读 attach）
    await this.command("control", { type: "session_resume", session_id: seed }, seed).catch((err) => {
      console.warn("[ringing] session_resume warning:", err);
    });

    this.sendTimelineStatus("connecting", seed);

    // 2. 首页 timeline 快照立刻推给渲染层
    try {
      const page = await this.timelinePage(seed, limit ?? 30, null);
      this.eventSender("timeline://snapshot", page);
    } catch (err) {
      console.warn(`[ringing] Initial timeline snapshot failed for ${seed}:`, err);
    }

    // 3. 双路流：投影单流（bootstrap + since_cursor 无缝续传）+ timeline 流（Last-Event-ID 续传）
    this.sessionWatch?.close();
    this.sessionWatch = this.sdk.watchSession(
      seed,
      {
        onEvent: (envelope) => {
          this.eventSender("conn://liveness", {});
          this.eventSender("projection://event", envelope);
        },
        onReset: (reset) => {
          console.warn(`[ringing] Reset required (${reset.reason}) for ${seed}`);
          this.eventSender("projection://reset", { ...reset, session_id: reset.session_id || seed });
        },
        onTerminated: (info) => {
          console.warn(`[ringing] Session stream terminated (${info.code}) for ${seed}: ${info.message}`);
        },
        onError: (error) => console.warn(`[ringing] Session watch error for ${seed}:`, error),
      },
      { skipBootstrap: false }
    );

    this.timelineWatch?.close();
    this.timelineWatch = this.sdk.watchTimeline(seed, {
      onEntry: (frame) => {
        this.eventSender("conn://liveness", {});
        this.eventSender("timeline://entry", { session_id: frame.session_id, entry: frame.entry });
      },
      onStatus: (status) => this.sendTimelineStatus(TIMELINE_STATUS_BY_WATCH[status], seed),
      onTerminated: (info) => {
        console.warn(`[ringing] Timeline stream terminated (${info.code}) for ${seed}: ${info.message}`);
      },
      onError: (error) => console.warn(`[ringing] Timeline watch error for ${seed}:`, error),
    });
  }

  detachActive(): void {
    this.sessionWatch?.close();
    this.sessionWatch = null;
    this.timelineWatch?.close();
    this.timelineWatch = null;
    if (this.activeSeed) {
      this.sendTimelineStatus("closed", this.activeSeed);
      this.activeSeed = null;
    }
  }

  async command(
    channel: "control" | "conversation",
    cmd: Record<string, any>,
    targetSeed?: string
  ): Promise<RingingCommandAck> {
    try {
      const { ack } = await this.sdk.submit(channel, cmd as any, targetSeed ?? this.activeSeed ?? null);
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
        return { status: "rejected", code: err.code, message: err.message };
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
              code: resolved.error_code ?? undefined,
              message: "command rejected (resolved via commandStatus)",
            };
          }
          if (resolved.state === "failed") {
            // 提交已被接受、执行失败：失败经由 timeline/turn 事件呈现给渲染层
            console.warn(`[ringing] command ${resolved.command_id} failed: ${resolved.error_code ?? "unknown"}`);
            return { status: "accepted", command_id: resolved.command_id };
          }
        }
      }
      throw err;
    }
  }

  async serviceRpc<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
    // ServiceMap covers the typed slice; dynamic names (pending backend
    // delivery) ride the same POST /service/{method} route at runtime.
    return this.sdk.service(method as never, params as never) as Promise<T>;
  }

  async timelinePage(seed: string, limit?: number | null, beforeIndex?: number | null): Promise<any> {
    return this.sdk.timelinePage(seed, {
      limit: limit ?? undefined,
      beforeIndex: beforeIndex ?? undefined,
    });
  }

  /** Canonical bootstrap 快照（渲染层读取 control.state.activity）。 */
  bootstrap(seed: string): Promise<ClientV2Bootstrap> {
    return this.sdk.bootstrap(seed);
  }

  /** approvals.admin capability；渲染层拿到的仍是 ChallengeManager 发出的 challenge 视图。 */
  approvals(seed: string): Promise<ApprovalsView> {
    return this.sdk.approvals(seed);
  }

  async uploadContent(seed: string, _filename: string, buffer: Uint8Array, mediaType: string): Promise<any> {
    return this.sdk.uploadContent(seed, { bytes: buffer, mediaType });
  }

  destroy(): void {
    this.detachActive();
    void this.sdk.disconnect();
  }

  private sendTimelineStatus(status: TimelineStatusWire["status"], seed: string): void {
    this.eventSender("timeline://status", { status, session_id: seed } as TimelineStatusWire);
  }
}
