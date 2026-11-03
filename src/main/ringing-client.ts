// Ringing v2 transport adapter over @qaqh/sdk.
//
// Owns the EventSender contract consumed by the renderer
// (projection://*, conn://liveness); all HTTP/SSE/lease
// mechanics — cursor resumption, backoff reconnects, lease renewal with
// credential refresh, multipart content upload — live in the SDK.
import {
  createClient,
  globalTarget,
  SdkError,
  sessionTarget,
  type ApprovalsView,
  type SessionBootstrap,
  type ClientState,
  type RingingClient as SdkRingingClient,
  type SessionWatch,
  type WatchStatus,
} from "@qaqh/sdk";
import { readDiscovery } from "./daemon.js";
import { requireAccepted, requireId } from "./approvals.js";
import type { CommandPrecondition, CommandTarget, RingingCommand } from "@qaqh/sdk/protocol";
import type {
  DaemonDiscovery,
  MainServiceMap,
  MainServiceMethod,
  ProjectionStatusWire,
  ReconnectStatusWire,
  RingingCommandAck,
} from "./types.js";

export type EventSender = (eventName: string, payload: any) => void;

export class RingingClient {
  private readonly sdk: SdkRingingClient;
  private readonly eventSender: EventSender;
  private activeSeed: string | null = null;
  private sessionWatch: SessionWatch | null = null;
  private streamGeneration = 0;
  private projectionStatus: WatchStatus = "closed";
  private attachRequest = 0;

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
    const request = ++this.attachRequest;
    this.activeSeed = seed;
    const generation = this.streamGeneration;
    const isCurrent = () => this.activeSeed === seed && this.streamGeneration === generation;
    this.projectionStatus = "connecting";
    this.sendProjectionStatus("connecting", seed);

    // Bind the selected session through the canonical command endpoint before watching it.
    await this.command({ type: "session.resume" }, sessionTarget(seed))
      .then(requireAccepted).catch((err) => {
        if (isCurrent()) this.reportError(`session.resume failed for ${seed}`, err);
      });
    if (!isCurrent() || request !== this.attachRequest) return;

    // 2. 投影单流（bootstrap + since_cursor 无缝续传）
    this.sessionWatch = this.sdk.watchSession(
      seed,
      {
        onBootstrap: (bootstrap) => {
          if (!isCurrent()) return;
          this.eventSender("projection://bootstrap", { session_id: seed, bootstrap });
          this.eventSender("conn://liveness", {});
        },
        onEvent: (event) => {
          if (!isCurrent()) return;
          this.eventSender("conn://liveness", {});
          this.eventSender("projection://event", { session_id: seed, event });
        },
        onResyncRequired: (reset) => {
          if (!isCurrent()) return;
          console.warn(`[ringing] Resync required (${reset.reason}) for ${seed}`);
          this.eventSender("projection://reset", { session_id: seed, reason: reset.reason });
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
    // Test/facade implementations may synchronously publish a status before
    // returning their watch handle; ensure the reset callback owns recovery.
    const watch = this.sessionWatch;
    void watch;
  }

  detachActive(): void {
    this.attachRequest++;
    this.streamGeneration += 1;
    this.sessionWatch?.close();
    this.sessionWatch = null;
    this.projectionStatus = "closed";
    if (this.activeSeed) {
      this.sendProjectionStatus("closed", this.activeSeed);
      this.activeSeed = null;
    }
  }

  /** Submit one typed command through the single Ringing v2 command endpoint. */
  async command(
    command: RingingCommand,
    target: CommandTarget = globalTarget(),
    preconditions: CommandPrecondition[] = [],
  ): Promise<RingingCommandAck> {
    if (target.kind === "session") requireId(target.session_id, "session_id");
    return this.normalizeAck(this.sdk.submit(target, command, { preconditions }).then(({ ack }) => ack));
  }

  /** Typed service query/read boundary. The caller must include session_id in params when required. */
  async serviceCall<K extends MainServiceMethod>(
    method: K,
    params: MainServiceMap[K]["params"],
  ): Promise<MainServiceMap[K]["result"]> {
    return this.sdk.serviceCall(
      method as never,
      params as never,
    ) as Promise<MainServiceMap[K]["result"]>;
  }

  private async normalizeAck(submit: Promise<RingingCommandAck>): Promise<RingingCommandAck> {
    try {
      return await submit;
    } catch (err) {
      // 维持旧契约：daemon 明确拒绝时返回 rejected ack 而不是抛错；其余错误上抛。
      if (err instanceof SdkError && err.kind === "command_rejected") {
        if (err.ack != null) return err.ack;
        return { status: "rejected", command_id: err.commandId!, code: err.code, message: err.message };
      }
      // Keep outcome_unknown (and its original command id) explicit. Receipts
      // do not carry the synchronous result needed by query-style commands.
      throw err;
    }
  }

  /** Resolve a pending approval submission using the original durable command id. */
  async commandStatus(commandId: string) {
    return this.sdk.commandStatus(commandId);
  }

  adminRequest<T = unknown>(credential: { endpoint: string; token: string }, path: string, init: { method: string; body?: BodyInit; contentType?: string | false }): Promise<T> {
    return this.sdk.adminRequest<T>(credential, path, init);
  }

  /** Canonical flattened session state. */
  bootstrap(seed: string): Promise<SessionBootstrap> {
    return this.sdk.bootstrap(seed);
  }

  async readContentText(contentRef: string, signal?: AbortSignal): Promise<string> {
    const content = await this.sdk.downloadContent(contentRef, { signal });
    return new TextDecoder("utf-8", { fatal: true }).decode(content.bytes);
  }

  /** approvals.admin capability；渲染层拿到的仍是 ChallengeManager 发出的 challenge 视图。 */
  approvals(seed: string): Promise<ApprovalsView> {
    return this.sdk.approvals(seed);
  }

  approvalsSnapshot(seed: string): Promise<SessionBootstrap> {
    return this.sdk.bootstrap(seed);
  }

  async uploadContent(seed: string, _filename: string, buffer: Uint8Array, mediaType: string) {
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

  async retryActive(seed: string): Promise<void> {
    if (this.activeSeed === seed && this.sessionWatch) {
      await this.sessionWatch.resync();
      return;
    }
    await this.attach(seed);
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

}
