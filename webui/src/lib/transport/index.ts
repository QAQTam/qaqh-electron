/**
 * 传输单例 — Electron 桌面壳后端。
 *
 * 浏览器 gateway 部署形态已随 `qaqh-webui-gateway` 移除:webui 的唯一运行形态
 * 是 Electron 壳,主进程经 `@qaqh/sdk` 直连 daemon,daemon token 不进 webview。
 * 类型与接口见 `./backend`。
 */
import { ElectronTransport, listenHostDiagnostics, openExternalUrl } from "./electron";
import {
  desktopHostSurface,
  type Ack,
  type ApprovalKind,
  type ApprovalView,
  type AttachmentUploadWire,
  type ProjectionStatusWire,
  type ReconnectStatusWire,
  type ScreenshotWire,
  type ShotMode,
  type StreamHandlers,
  type TodoItemWire,
  type TransportBackend,
} from "./backend";

export const transport: TransportBackend = new ElectronTransport();

export { listenHostDiagnostics, openExternalUrl, desktopHostSurface };

export { RINGING_SCHEMA, RINGING_VERSION, execSessionTarget, globalTarget, sessionTarget, workspaceTarget } from "./backend";
export type { CommandPrecondition, CommandTarget, RingingCommand, ServiceMethod, ServiceParams, ServiceResult } from "./backend";
export { isDesktopRuntime } from "../desktop-host";
export type {
  Ack,
  ApprovalKind,
  ApprovalView,
  AttachmentUploadWire,
  ProjectionStatusWire,
  ReconnectStatusWire,
  ScreenshotWire,
  ShotMode,
  StreamHandlers,
  TodoItemWire,
  TransportBackend,
};
