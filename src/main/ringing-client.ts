// Ringing v2 transport adapter over @qaqh/sdk.
//
// Owns the legacy EventSender contract consumed by the renderer
// (timeline://*, projection://*, conn://liveness); all HTTP/SSE/lease
// mechanics — cursor resumption, backoff reconnects, lease renewal with
// credential refresh, multipart content upload — live in the SDK.
import {
  createClient,
  SdkError,
  type ClientState,
  type RingingClient as SdkRingingClient,
  type SessionWatch,
  type TimelineWatch,
  type WatchStatus,
} from "@qaqh/sdk";
import type { DaemonDiscovery as SdkDaemonDiscovery } from "@qaqh/sdk/protocol";
import { readDiscovery } from "./daemon.js";
import type { DaemonDiscovery, RingingCommandAck, TimelineStatusWire } from "./types.js";

export type EventSender = (eventName: string, payload: any) => void;

function toSdkDiscovery(discovery: DaemonDiscovery): SdkDaemonDiscovery {
  return {
    endpoint: discovery.endpoint,
    token: discovery.token,
    pid: discovery.pid,
    server_epoch: discovery.server_epoch ?? "",
    protocol_version: discovery.protocol_version,
    daemon_version: discovery.daemon_version ?? "",
    build_id: discovery.build_id ?? "",
    channel: discovery.channel ?? "",
    executable: discovery.executable ?? "",
    lan_endpoint: discovery.lan_endpoint ?? null,
    tls_fingerprint: discovery.tls_fingerprint ?? null,
  };
}

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
      credentials: toSdkDiscovery(discovery),
      // Daemon restarts re-publish daemon.json (new port/token); the SDK
      // consults this hook before every recovery reconnect.
      refreshCredentials: async () => {
        const fresh = readDiscovery();
        if (!fresh) throw new Error("daemon discovery document disappeared");
        return toSdkDiscovery(fresh);
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
