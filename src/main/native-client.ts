// Loader + typed facade over the qaqh-napi-client Node-API addon.
//
// 协议运行时已经由 Rust 侧 `qaqh-client` 提供（与 TUI / Android / HarmonyOS
// 同一个 crate），本模块只负责：
//   1. 按平台解析 .node 路径（开发: repo/native；打包: app.asar.unpacked）；
//   2. 把 addon 的 JSON-message 错误解包成结构化 NativeClientError，
//      保持旧 @qaqh/sdk SdkError.kind 的语义（尤其 command_rejected 携带原始
//      rejected ack，供 normalizeAck 回退成 rejected ack 而不是抛错）；
//   3. 暴露与旧 SDK 等价的方法面，供 RingingClient 适配层消费。
//
// 协议契约类型继续复用 backend exporter 生成、webui 镜像持有的同一份产物
// （webui/src/api/qaqh），main 与 renderer 不再有第二份生成目录。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 结构化协议错误（对应旧 SdkError.kind 词汇表的可消费子集）。 */
export class NativeClientError extends Error {
  readonly kind: string;
  readonly status?: number;
  readonly code?: string;
  readonly commandId?: string;
  readonly retryAfterMs?: number;
  readonly existing?: unknown;
  readonly ack?: Record<string, unknown>;

  constructor(detail: {
    kind: string;
    message?: string;
    status?: number;
    code?: string;
    commandId?: string;
    retryAfterMs?: number;
    existing?: unknown;
    ack?: Record<string, unknown>;
  }) {
    super(detail.message ?? detail.kind);
    this.name = "NativeClientError";
    this.kind = detail.kind;
    this.status = detail.status;
    this.code = detail.code;
    this.commandId = detail.commandId;
    this.retryAfterMs = detail.retryAfterMs;
    this.existing = detail.existing;
    this.ack = detail.ack;
  }

  /** addon 的 message 是一段 JSON（见 qaqh-napi-client structured_error）。 */
  static from(error: unknown): NativeClientError {
    if (error instanceof NativeClientError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message) as Record<string, unknown>;
        return new NativeClientError({
          kind: String(parsed.kind ?? "transport"),
          message: typeof parsed.message === "string" ? parsed.message : message,
          status: typeof parsed.status === "number" ? parsed.status : undefined,
          code: typeof parsed.code === "string" ? parsed.code : undefined,
          commandId: typeof parsed.commandId === "string" ? parsed.commandId : undefined,
          retryAfterMs: typeof parsed.retryAfterMs === "number" ? parsed.retryAfterMs : undefined,
          existing: parsed.existing,
          ack: (parsed.ack != null && typeof parsed.ack === "object"
            ? parsed.ack
            : undefined) as Record<string, unknown> | undefined,
        });
      } catch {
        // fall through to generic transport error
      }
    }
    return new NativeClientError({ kind: "transport", message });
  }
}

export interface NativeSubmitOptions {
  command_id?: string;
  preconditions?: unknown[];
}

export interface NativeSubmitResult {
  command_id: string;
  ack: Record<string, unknown>;
}

export interface NativeUploadedContent {
  content_id: string;
  content_ref: string;
  media_type: string;
  sha256: string;
  size: number;
  truncated: boolean;
}

export interface NativeStatusPayload {
  session_id: string;
  state: "connecting" | "open" | "reconnecting" | "closed";
  server_epoch?: string;
  cursor?: string | null;
  retry_ms?: number;
  reason?: unknown;
  last_cursor?: string | null;
}

export interface NativeEventPayload {
  session_id: string;
  event: Record<string, unknown>;
}

export interface NativeResetPayload {
  session_id: string;
  reset: Record<string, unknown>;
}

/** addon 的加载与表面类型（.node 由 build 链产出，见 scripts/build-all.mjs）。 */
export interface NativeAddon {
  NativeClient: {
    connect(
      options: { base_url: string; token: string; tls_fp: string | null },
      onEvent: (payload: NativeEventPayload) => void,
      onReset: (payload: NativeResetPayload) => void,
      onStatus: (payload: NativeStatusPayload) => void,
      onLiveness: () => void,
    ): NativeRingingClient;
  };
  ringingV2Version(): number;
  commandContractRevision(): string;
  serviceMethods(): string[];
}

/** Rust 侧 NativeClient 的方法面（同名方法由 qaqh-napi-client 导出）。 */
export interface NativeRingingClient {
  watchSession(seed: string): Promise<void>;
  deactivateStream(seed: string): Promise<void>;
  submit(target: unknown, command: unknown, options?: NativeSubmitOptions): Promise<NativeSubmitResult>;
  commandStatus(commandId: string): Promise<unknown>;
  serviceCall(method: string, params: unknown): Promise<unknown>;
  bootstrap(seed: string): Promise<unknown>;
  approvalsRaw(seed: string): Promise<unknown>;
  downloadContent(reference: string): Promise<Uint8Array>;
  uploadContentRaw(seed: string, mediaType: string, data: Uint8Array): Promise<NativeUploadedContent>;
  stopDaemon(idleOnly: boolean): Promise<"stopping" | "busy" | "unsupported">;
  issuePairingToken(scopeGrant: string, deviceName: string, platform: string): Promise<Record<string, unknown>>;
  listDevices(): Promise<unknown[]>;
  revokeDevice(deviceId: string): Promise<void>;
  close(): void;
}

const ADDON_NAME = "qaqh_napi_client";

/** 平台三段名（与 napi-rs 命名约定一致；build 链按此复制重命名）。 */
export function nativeAddonFile(platform: string = process.platform, arch: string = process.arch): string {
  const plat = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const report = process.report?.getReport?.() as { header?: Record<string, unknown> } | undefined;
  const musl = plat === "linux" && report?.header?.glibcVersionRuntime == null;
  const suffix = plat === "linux"
    ? `${plat}-${arch}-${musl ? "musl" : "gnu"}`
    : plat === "win32"
      ? `${plat}-${arch}-msvc`
      : `${plat}-${arch}`;
  return `${ADDON_NAME}.${suffix}.node`;
}

/**
 * 测试缝：进程级覆写 addon 单例。生产路径永远走真实 .node；
 * test-host.mjs 通过 bundle 导出的 setNativeAddonOverride 注入 fake。
 */
let addonOverride: NativeAddon | null = null;

export function setNativeAddonOverride(addon: NativeAddon | null): void {
  addonOverride = addon;
}

/** 依次尝试打包路径与开发路径，找到第一个存在的 .node。 */
export function loadNativeAddon(): NativeAddon {
  if (addonOverride) return addonOverride;
  // main bundle 位于 dist/main/index.cjs（CJS），__dirname 即 dist/main。
  const require = createRequire(__filename);
  const file = nativeAddonFile();
  const override = process.env.QAQH_NATIVE_DIR?.trim();
  const candidates = [
    // 显式覆盖（多实例/测试）。
    ...(override ? [join(override, file)] : []),
    // 打包：asarUnpack 把 .node 解到 <resources>/app.asar.unpacked/native/。
    // 必须走 process.resourcesPath——热更新 asar 可能把 app 代码放在 asar 根
    // (asar flavor)，用 __dirname 两级向上会推到 <asar>/app.asar.unpacked 这种
    // 错误位置；resourcesPath 与 asar 内部布局无关。
    ...(process.resourcesPath
      ? [join(process.resourcesPath, "app.asar.unpacked", "native", file)]
      : []),
    // 兼容 electron-builder 嵌套布局（dist/main 在 asar 内）的推导，兜底保留。
    join(__dirname, "..", "..", "app.asar.unpacked", "native", file),
    // 开发：repo/native。
    join(__dirname, "..", "..", "native", file),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // .node 只能 require 加载；路径在运行时解析，esbuild 不会静态打包它。
      return require(candidate) as NativeAddon;
    }
  }
  throw new Error(
    `qaqh native client addon not found (${file}); run the build pipeline (scripts/build-all.mjs) or place the binary under native/`,
  );
}

export { ADDON_NAME };

/** Ringing v2 命令目标 helpers（等价旧 @qaqh/sdk 的 globalTarget/sessionTarget）。 */
export function globalCommandTarget(): { kind: "global" } {
  return { kind: "global" };
}

export function sessionCommandTarget(sessionId: string): { kind: "session"; session_id: string } {
  return { kind: "session", session_id: sessionId };
}
