// Ringing v2 transport adapter over the qaqh-napi-client native addon.
//
// Owns the EventSender contract consumed by the renderer
// (projection://*, conn://liveness); all HTTP/SSE/lease
// mechanics — cursor resumption, backoff reconnects, lease renewal with
// credential refresh, multipart content upload — live in qaqh-client
// (Rust, shared with the TUI / Android / HarmonyOS shells) behind the addon.
//
// bootstrap 顺序契约：单流**不携带快照**（规范顺序 open -> bootstrap ->
// subscribe）。本适配层在收到 status=open 后拉取 bootstrap、先投递
// projection://bootstrap，再 flush 缓冲的事件——旧 SDK watch 内嵌的
// bootstrap-before-events 顺序由此保持。
import {
  NativeClientError,
  globalCommandTarget,
  loadNativeAddon,
  sessionCommandTarget,
  type NativeRingingClient,
  type NativeStatusPayload,
} from "./native-client.js";
import { readDiscovery } from "./daemon.js";
import { requireAccepted, requireId } from "./approvals.js";
import type { CommandPrecondition } from "../../webui/src/api/qaqh/CommandPrecondition";
import type { CommandTarget } from "../../webui/src/api/qaqh/CommandTarget";
import type { RingingCommand } from "../../webui/src/api/qaqh/RingingCommand";
import type { RingingV2CommandStatus } from "../../webui/src/api/qaqh/RingingV2CommandStatus";
import type { RingingV2PendingApprovals } from "../../webui/src/api/qaqh/RingingV2PendingApprovals";
import type { SessionBootstrap } from "../../webui/src/api/qaqh/SessionBootstrap";
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
  private native: NativeRingingClient | null = null;
  private credentials: DaemonDiscovery | null = null;
  private readonly eventSender: EventSender;
  private activeSeed: string | null = null;
  private streamGeneration = 0;
  private projectionStatus: ProjectionStatusWire["status"] = "closed";
  private attachRequest = 0;
  /** status=open 之后、bootstrap 投递之前到达的事件缓冲（按活跃 seed）。 */
  private pendingEvents: Array<Record<string, unknown>> = [];
  /** bootstrap 是否已投递（true 之后事件直通）。 */
  private bootstrapDelivered = false;
  /** 当前 seed 的单飞 bootstrap 投递（status=open 与 attach 共享）。 */
  private bootstrapInFlight: { seed: string; promise: Promise<void> } | null = null;
  /** 当前 seed 的重连序号（conn://reconnect.attempt）。 */
  private reconnectAttempts = 0;

  constructor(discovery: DaemonDiscovery, eventSender: EventSender) {
    this.credentials = discovery;
    this.eventSender = eventSender;
  }

  async init(): Promise<void> {
    if (this.native) return;
    this.native = this.createNative();
  }

  /** 用当前已知凭据建立 addon 客户端；回调统一进适配层分派。 */
  private createNative(): NativeRingingClient {
    if (!this.credentials) throw new Error("daemon credentials unavailable");
    const addon = loadNativeAddon();
    return addon.NativeClient.connect(
      {
        base_url: this.credentials.endpoint,
        token: this.credentials.token,
        tls_fp: this.credentials.tls_fingerprint ?? null,
      },
      (payload) => this.onNativeEvent(payload),
      (payload) => this.onNativeReset(payload),
      (payload) => this.onNativeStatus(payload),
      () => this.onNativeLiveness(),
    );
  }

  private onNativeEvent(payload: { session_id: string; event: Record<string, unknown> }): void {
    if (payload.session_id !== this.activeSeed) return;
    this.eventSender("conn://liveness", {});
    if (!this.bootstrapDelivered) {
      this.pendingEvents.push(payload.event);
      return;
    }
    this.eventSender("projection://event", { session_id: payload.session_id, event: payload.event });
  }

  private onNativeReset(payload: { session_id: string; reset: Record<string, unknown> }): void {
    if (payload.session_id !== this.activeSeed) return;
    const reason = (payload.reset as { reason?: unknown } | null)?.reason;
    console.warn(`[ringing] Resync required (${String(reason)}) for ${payload.session_id}`);
    this.pendingEvents = [];
    this.bootstrapDelivered = false;
    this.eventSender("projection://reset", { session_id: payload.session_id, reason });
  }

  private onNativeStatus(payload: NativeStatusPayload): void {
    if (payload.session_id !== this.activeSeed) return;
    const status = payload.state === "open" ? "live" : payload.state;
    if (payload.state === "open") {
      // 拉快照 → 先发 bootstrap → flush 缓冲事件；attach 也等待同一次投递。
      this.scheduleBootstrap(payload.session_id);
      this.reconnectAttempts = 0;
    } else if (payload.state === "reconnecting") {
      this.reconnectAttempts += 1;
      if (typeof payload.retry_ms === "number") {
        this.sendReconnectScheduled(payload.session_id, this.reconnectAttempts, payload.retry_ms);
      }
    }
    this.projectionStatus = status;
    this.sendProjectionStatus(status, payload.session_id);
    if (payload.state === "closed") {
      this.reportError(`Session stream closed for ${payload.session_id}: ${payload.reason ?? "unknown"}`);
    }
  }

  /** 单飞 bootstrap 投递：status=open 与 attach 共享同一次拉取。 */
  private scheduleBootstrap(seed: string): Promise<void> {
    if (this.bootstrapInFlight?.seed === seed) return this.bootstrapInFlight.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this.bootstrapInFlight = { seed, promise };
    void this.deliverBootstrap(seed).finally(() => {
      if (this.bootstrapInFlight?.seed === seed) this.bootstrapInFlight = null;
      resolve();
    });
    return promise;
  }

  private async deliverBootstrap(seed: string, rethrow = false): Promise<void> {
    try {
      const native = this.native;
      if (!native || seed !== this.activeSeed) return;
      const bootstrap = await native.bootstrap(seed);
      if (seed !== this.activeSeed) return;
      this.eventSender("projection://bootstrap", { session_id: seed, bootstrap });
      this.eventSender("conn://liveness", {});
      this.bootstrapDelivered = true;
      const buffered = this.pendingEvents;
      this.pendingEvents = [];
      for (const event of buffered) {
        this.eventSender("projection://event", { session_id: seed, event });
      }
    } catch (err) {
      if (rethrow) throw err;
      this.reportError(`bootstrap failed for ${seed}`, err);
    }
  }

  private onNativeLiveness(): void {
    this.eventSender("conn://liveness", {});
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
    await this.init();

    // Bind the selected session through the canonical command endpoint before watching it.
    await this.command({ type: "session.resume" }, sessionCommandTarget(seed))
      .then(requireAccepted).catch((err) => {
        if (isCurrent()) this.reportError(`session.resume failed for ${seed}`, err);
      });
    if (!isCurrent() || request !== this.attachRequest) return;

    this.bootstrapDelivered = false;
    this.pendingEvents = [];
    this.reconnectAttempts = 0;
    const native = this.native!;
    await native.watchSession(seed);
    // status=open 先到（同步回调）时，attach 等待同一次 bootstrap 投递完成，
    // 保证调用方拿到控制权时快照已先行送达（事件顺序契约的入口）。
    if (this.bootstrapInFlight?.seed === seed) await this.bootstrapInFlight.promise;
    void isCurrent;
  }

  detachActive(): void {
    this.attachRequest++;
    this.streamGeneration += 1;
    const seed = this.activeSeed;
    if (this.native && seed) {
      void this.native.deactivateStream(seed).catch(() => {});
    }
    this.pendingEvents = [];
    this.bootstrapDelivered = false;
    this.projectionStatus = "closed";
    if (this.activeSeed) {
      this.sendProjectionStatus("closed", this.activeSeed);
      this.activeSeed = null;
    }
  }

  /** Submit one typed command through the single Ringing v2 command endpoint. */
  async command(
    command: RingingCommand,
    target: CommandTarget = globalCommandTarget(),
    preconditions: CommandPrecondition[] = [],
  ): Promise<RingingCommandAck> {
    if (target.kind === "session") requireId(target.session_id, "session_id");
    await this.init();
    try {
      const { ack } = await this.native!.submit(target, command, { preconditions });
      return ack as RingingCommandAck;
    } catch (err) {
      const nativeError = NativeClientError.from(err);
      // 维持旧契约：daemon 明确拒绝时返回 rejected ack 而不是抛错；其余错误上抛。
      if (nativeError.kind === "command_rejected") {
        if (nativeError.ack != null) return nativeError.ack as RingingCommandAck;
        return {
          status: "rejected",
          command_id: nativeError.commandId ?? "",
          code: nativeError.code,
          message: nativeError.message,
        } as RingingCommandAck;
      }
      throw nativeError;
    }
  }

  /** Typed service query/read boundary. The caller must include session_id in params when required. */
  async serviceCall<K extends MainServiceMethod>(
    method: K,
    params: MainServiceMap[K]["params"],
  ): Promise<MainServiceMap[K]["result"]> {
    await this.init();
    return this.native!.serviceCall(method as string, params) as Promise<MainServiceMap[K]["result"]>;
  }

  /** Resolve a pending approval submission using the original durable command id. */
  async commandStatus(commandId: string): Promise<RingingV2CommandStatus> {
    await this.init();
    return this.native!.commandStatus(commandId) as Promise<RingingV2CommandStatus>;
  }

  /** Canonical flattened session state. */
  async bootstrap(seed: string): Promise<SessionBootstrap> {
    await this.init();
    return this.native!.bootstrap(seed) as Promise<SessionBootstrap>;
  }

  async readContentText(contentRef: string, signal?: AbortSignal): Promise<string> {
    await this.init();
    const download = this.native!.downloadContent(contentRef);
    // addon 暂不支持 AbortSignal 入参：取消时立即向调用方返回 abort 语义，
    // 后台传输自然结束后丢弃（内容体积受 daemon 上限约束）。
    const bytes = await raceAbort(download, signal);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  /** approvals.admin capability；渲染层拿到的仍是 ChallengeManager 发出的 challenge 视图。 */
  async approvals(
    seed: string,
  ): Promise<{ kind: "admin"; pending: RingingV2PendingApprovals } | { kind: "device"; challenges: unknown }> {
    await this.init();
    const body = (await this.native!.approvalsRaw(seed)) as Record<string, unknown> | null;
    if (body && typeof body === "object" && "challenges" in body) {
      return { kind: "device", challenges: body.challenges };
    }
    return { kind: "admin", pending: body as RingingV2PendingApprovals };
  }

  approvalsSnapshot(seed: string): Promise<SessionBootstrap> {
    return this.bootstrap(seed);
  }

  /** Team 投影快照(任务板/花名册/留言板,读侧按需拉取)。 */
  async teamSnapshot(seed: string): Promise<unknown> {
    await this.init();
    return this.native!.teamRaw(seed);
  }

  async uploadContent(seed: string, _filename: string, buffer: Uint8Array, mediaType: string) {
    await this.init();
    return this.native!.uploadContentRaw(seed, mediaType, buffer);
  }

  stopDaemon(idleOnly: boolean): Promise<"stopping" | "busy" | "unsupported"> {
    if (!this.native) return Promise.resolve("unsupported");
    return this.native.stopDaemon(idleOnly);
  }

  issuePairToken(request: { scope_grant: string; device_name: string; platform: string }) {
    if (!this.native) return Promise.reject(new Error("client not initialized"));
    return this.native.issuePairingToken(request.scope_grant, request.device_name, request.platform);
  }

  listDevices() {
    if (!this.native) return Promise.reject(new Error("client not initialized"));
    return this.native.listDevices();
  }

  revokeDevice(deviceId: string): Promise<void> {
    if (!this.native) return Promise.reject(new Error("client not initialized"));
    return this.native.revokeDevice(deviceId);
  }

  async reconnect(): Promise<void> {
    this.detachActive();
    await this.recreateClient();
  }

  async reconnectWithCredentials(credentials: DaemonDiscovery): Promise<void> {
    this.detachActive();
    this.credentials = credentials;
    await this.recreateClient();
  }

  /** 关闭旧客户端并按当前凭据重建（daemon 重启换端口/token 的恢复路径）。 */
  private async recreateClient(): Promise<void> {
    if (this.native) {
      const stale = this.native;
      this.native = null;
      try { stale.close(); } catch { /* already gone */ }
    }
    await this.init();
  }

  destroy(): void {
    this.detachActive();
    if (this.native) {
      const stale = this.native;
      this.native = null;
      try { stale.close(); } catch { /* already gone */ }
    }
  }

  getProjectionStatus(seed: string): ProjectionStatusWire["status"] {
    return this.activeSeed === seed ? this.projectionStatus : "closed";
  }

  /** 恢复重连前重读 discovery；凭据变化说明 daemon 换了端口/token，整客户端重建。 */
  async refreshCredentialsIfChanged(): Promise<boolean> {
    const fresh = await readDiscovery();
    if (!fresh || !this.credentials) return false;
    if (fresh.endpoint === this.credentials.endpoint && fresh.token === this.credentials.token) {
      return false;
    }
    await this.reconnectWithCredentials(fresh);
    return true;
  }

  async retryActive(seed: string): Promise<void> {
    if (this.activeSeed === seed) {
      // 单流的重连/重基线由 Rust 侧 V2Stream 循环负责；这里只负责把
      // bootstrap 顺序重新走一遍（等价旧 watch.resync 的观察面）。
      this.bootstrapDelivered = false;
      this.pendingEvents = [];
      await this.deliverBootstrap(seed, true);
      return;
    }
    await this.attach(seed);
  }

  private sendProjectionStatus(status: ProjectionStatusWire["status"], seed: string): void {
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

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}
