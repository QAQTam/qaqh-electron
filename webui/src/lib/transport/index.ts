/**
 * 传输单例 — Tauri 桌面壳后端(webui-tauri C3 起)。
 *
 * 浏览器 gateway 部署形态已随 `qaqh-webui-gateway` 移除:webui 的唯一运行形态
 * 是 Tauri 壳,Rust 宿主经 `qaqh-client` 直连 daemon,daemon token 不进 webview。
 * 类型与接口见 `./backend`。
 */
import { TauriTransport, listenHostDiagnostics, openExternalUrl } from "./tauri";
import {
  BrowserPreviewTransport,
  listenBrowserPreviewDiagnostics,
  openBrowserPreviewUrl,
} from "./browser-preview";
import {
  type Ack,
  type ApprovalKind,
  type ApprovalView,
  type AttachmentUploadWire,
  type ScreenshotWire,
  type ShotMode,
  type StreamHandlers,
  type TimelinePageResponse,
  type TimelineStatusWire,
  type TodoItemWire,
  type TransportBackend,
  type UserSkillDiagnostic,
  type UserSkillFile,
  type UserSkillRoot,
  type UserSkillsWire,
  isTauriRuntime,
  tauriHost,
} from "./backend";

const browserPreview = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("preview") === "tauri";

export const transport: TransportBackend = browserPreview
  ? new BrowserPreviewTransport()
  : new TauriTransport();

const hostDiagnostics = browserPreview ? listenBrowserPreviewDiagnostics : listenHostDiagnostics;
const externalUrl = browserPreview ? openBrowserPreviewUrl : openExternalUrl;

export { externalUrl as openExternalUrl, hostDiagnostics as listenHostDiagnostics };

export { RINGING_SCHEMA, RINGING_VERSION } from "./backend";
export { tauriHost, isTauriRuntime };
export type {
  Ack,
  ApprovalKind,
  ApprovalView,
  AttachmentUploadWire,
  ScreenshotWire,
  ShotMode,
  StreamHandlers,
  TimelinePageResponse,
  TimelineStatusWire,
  TodoItemWire,
  TransportBackend,
  UserSkillDiagnostic,
  UserSkillFile,
  UserSkillRoot,
  UserSkillsWire,
};
