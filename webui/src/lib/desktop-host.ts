/**
 * Electron preload bridge (`window.qaqhHost`).
 *
 * The renderer never sees Node/Electron primitives or daemon credentials; the
 * preload exposes a fixed command/event contract. This module is the single
 * typed entry point so feature code does not reach into `window` directly.
 */

export type HostCommand =
  | "session_list"
  | "attach"
  | "pending_approvals"
  | "respond_approval"
  | "send_message"
  | "cancel_turn"
  | "compact_context"
  | "create_session"
  | "service_rpc"
  | "skills_user_scan"
  | "timeline_page"
  | "session_bootstrap"
  | "timeline_status"
  | "streams_retry"
  | "stop_stale_daemon"
  | "pick_directory"
  | "pick_attachments"
  | "capture_screenshot"
  | "upload_attachment"
  | "open_external"
  | "set_window_theme"
  | "exit_app"
  | "app_version"
  | "host_memory"
  | "host_process_group"
  | "pairing_create"
  | "devices_list"
  | "device_revoke"
  | "daemon_lan_status"
  | "daemon_lan_enable"
  | "daemon_lan_disable";

export type HostEvent =
  | "timeline://entry"
  | "timeline://status"
  | "timeline://snapshot"
  | "projection://event"
  | "projection://reset"
  | "conn://incompatible"
  | "conn://error"
  | "conn://liveness"
  | "conn://reconnect"
  | "app://quit-requested";

export interface ModelPickerBridge {
  load(args?: { sessionId?: string | null }): Promise<any>;
  save(args: { sessionId?: string | null; selection: unknown; alsoDefault?: boolean }): Promise<null>;
}

export interface DesktopHostBridge {
  readonly platform: "electron";
  invoke<T = unknown>(command: HostCommand, args?: Record<string, unknown>): Promise<T>;
  listen(event: HostEvent, callback: (payload: any) => void): () => void;
  modelPicker?: ModelPickerBridge;
  requestQuit(options: { stopDaemon: boolean; stopActiveWork: boolean }): Promise<void>;
}

declare global {
  interface Window {
    qaqhHost?: DesktopHostBridge;
  }
}

export function desktopHost(): DesktopHostBridge | null {
  return typeof window !== "undefined" && window.qaqhHost != null ? window.qaqhHost : null;
}

export function isDesktopRuntime(): boolean {
  return desktopHost() != null;
}

export function requireDesktopHost(): DesktopHostBridge {
  const host = desktopHost();
  if (host == null) throw new Error("Electron desktop host is unavailable");
  return host;
}
