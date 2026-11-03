/**
 * Electron 桌面壳传输后端 — 经 preload 的 `window.qaqhHost` 访问 daemon。
 *
 * 前端只见两类通道:
 *  - `invoke` 请求/响应(与 Electron 主进程的固定命令表一一对应);
 *  - 宿主转发的事件(timeline://*, projection://*, conn://*, payload 与 SSE 帧同形)。
 *
 * 连接语义:重连/退避/续传责任在 Electron 宿主/SDK,connection 状态由
 * `timeline://status` 驱动;offline 后由用户动作(重试按钮/窗口聚焦)触发
 * `streams_retry`。
 */
import { isDesktopRuntime, type HostEvent } from "../desktop-host";
import { invoke, listen, type Event, type UnlistenFn } from "./electron-core";
import { noteEvent, noteRpc } from "../devlog";
import {
  type Ack,
  type ApprovalView,
  type AttachmentUploadWire,
  type ScreenshotWire,
  type ShotMode,
  type StreamHandlers,
  type ProjectionStatusWire,
  type ReconnectStatusWire,
  type TransportBackend,
  type DaemonCommand,
  type UnifiedTarget,
  type UserSkillsWire,
} from "./backend";

type HostDiagnostics = {
  onIncompatible?: (details: Record<string, any>) => void;
  onHostError?: (message: string) => void;
  onLiveness?: (at: number) => void;
  onReconnect?: (info: ReconnectStatusWire) => void;
};

function rejectAck(ack: Ack): Error {
  return new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
}

export class ElectronTransport implements TransportBackend {
  sessions(): Promise<any[]> {
    return invoke<any[]>("session_list");
  }

  async attach(seed: string, limit?: number): Promise<void> {
    // limit:宿主按这个大小取权威首页并推给 webview;省略则后端用默认页大小。
    await invoke("attach", { seed, limit: limit ?? null });
  }

  approvals(sessionId: string): Promise<ApprovalView[]> {
    return invoke<ApprovalView[]>("pending_approvals", { seed: sessionId });
  }

  async invalidateApprovals(sessionId: string, challengeId?: string, verified: boolean | "revoke" = false): Promise<void> {
    await invoke("invalidate_approvals", { seed: sessionId, challengeId: challengeId ?? null, verified });
  }

  async respondApproval(sessionId: string, challengeId: string, decision: string, payload: Record<string, unknown> = {}): Promise<null> {
    await invoke("respond_approval", { seed: sessionId, challengeId, decision, payload });
    return null;
  }

  async command(command: DaemonCommand, target: UnifiedTarget = { kind: "global" }): Promise<Ack> {
    const startedAt = Date.now();
    try {
      const ack = await invoke<Ack>("command", { command, target });
      noteRpc(command.type, startedAt, null);
      if (ack.status === "rejected") throw rejectAck(ack);
      return ack;
    } catch (cause) {
      noteRpc(command.type, startedAt, cause);
      throw cause;
    }
  }

  async query<T = unknown>(command: DaemonCommand, target: UnifiedTarget = { kind: "global" }): Promise<T> {
    const ack = await this.command(command, target);
    return (ack.result ?? null) as T;
  }

  /** 用户级 skills:宿主自己扫 `~/.qaqh/skills` 与 `~/.agents/skills`(不经 daemon)。 */
  userSkills(): Promise<UserSkillsWire> {
    return invoke<UserSkillsWire>("skills_user_scan");
  }

  // ── Electron 宿主专属面(DesktopHostSurface) ────────────────────────────────

  pickDirectory(): Promise<string | null> {
    return invoke<string | null>("pick_directory");
  }

  pickAttachments(): Promise<string[]> {
    return invoke<string[]>("pick_attachments");
  }

  /** 应用内截图(macOS 系统 `screencapture`);`null` = 用户在准星上按了 Esc。 */
  captureScreenshot(mode: ShotMode): Promise<ScreenshotWire | null> {
    return invoke<ScreenshotWire | null>("capture_screenshot", { mode });
  }

  uploadAttachment(seed: string, path: string): Promise<AttachmentUploadWire> {
    return invoke<AttachmentUploadWire>("upload_attachment", { seed, path });
  }

  /** 订阅宿主转发事件;返回反订阅函数(store 切换/销毁时调用)。 */
  async subscribe(handlers: StreamHandlers): Promise<() => void> {
    const unlistens: UnlistenFn[] = [];
    const on = async <P>(name: HostEvent, run: (payload: P) => void): Promise<void> => {
      unlistens.push(await listen<P>(name, (event: Event<P>) => {
        noteEvent(name, event.payload);
        run(event.payload);
      }));
    };
    await on<ProjectionStatusWire>("projection://status", (payload) => handlers.onProjectionStatus?.(payload));
    await on<Record<string, any>>("projection://bootstrap", (payload) => {
      const seed = typeof payload?.session_id === "string" ? payload.session_id : "";
      if (seed && payload?.bootstrap && typeof payload.bootstrap === "object") handlers.onProjectionBootstrap?.(seed, payload.bootstrap);
    });
    await on<Record<string, any>>("projection://event", (payload) => {
      const seed = typeof payload?.session_id === "string" ? payload.session_id : "";
      handlers.onProjectionEvent(seed, payload);
    });
    await on<Record<string, any>>("projection://reset", (payload) => {
      const seed = typeof payload?.session_id === "string" ? payload.session_id : "";
      handlers.onProjectionReset(seed, payload);
    });
    await on<Record<string, any>>("conn://incompatible", (payload) => handlers.onIncompatible(payload ?? {}));
    await on<{ message?: string }>("conn://error", (payload) => handlers.onHostError(String(payload?.message ?? "host error")));
    await on<ReconnectStatusWire>("conn://reconnect", (payload) => handlers.onReconnect?.(payload));
    return () => {
      for (const unlisten of unlistens.splice(0)) unlisten();
    };
  }

  sessionBootstrap(seed: string): Promise<unknown> {
    return invoke<unknown>("session_bootstrap", { seed });
  }

  readContentText(contentRef: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    const requestId = crypto.randomUUID();
    const request = invoke<string>("content_read_text", { contentRef, requestId });
    if (!signal) return request;
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        void invoke("content_read_cancel", { requestId }).catch(() => {});
        reject(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async streamsRetry(seed?: string): Promise<void> {
    await invoke("streams_retry", { seed: seed ?? null });
  }

  async stopStaleDaemon(): Promise<"stopping" | "busy" | "unsupported"> {
    return invoke<"stopping" | "busy" | "unsupported">("stop_stale_daemon");
  }

}

/** 外链经宿主系统浏览器打开(仅 http/https)。 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  await invoke("open_external", { url });
}

/** 宿主级诊断事件(App 装配期订阅,与具体标签无关)。非 Electron 环境返回空操作。 */
export async function listenHostDiagnostics(handlers: HostDiagnostics): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  const unlistens: UnlistenFn[] = [];
  if (handlers.onIncompatible) {
    unlistens.push(
      await listen<Record<string, any>>("conn://incompatible", (event) => handlers.onIncompatible!(event.payload ?? {})),
    );
  }
  if (handlers.onHostError) {
    unlistens.push(
      await listen<{ message?: string }>("conn://error", (event) =>
        handlers.onHostError!(String(event.payload?.message ?? "host error")),
      ),
    );
  }
  if (handlers.onLiveness) {
    unlistens.push(
      await listen<Record<string, never>>("conn://liveness", () => handlers.onLiveness!(Date.now())),
    );
  }
  if (handlers.onReconnect) {
    unlistens.push(
      await listen<ReconnectStatusWire>("conn://reconnect", (event) => handlers.onReconnect!(event.payload)),
    );
  }
  return () => {
    for (const unlisten of unlistens.splice(0)) unlisten();
  };
}
