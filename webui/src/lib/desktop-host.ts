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
  | "session_bootstrap"
  | "content_read_text"
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
  | "host_gpu_info"
  | "pairing_create"
  | "devices_list"
  | "device_revoke"
  | "daemon_lan_status"
  | "daemon_lan_enable"
  | "daemon_lan_disable"
  | "updater_check"
  | "updater_stage"
  | "updater_status"
  | "updater_apply";

export type HostEvent =
  | "projection://status"
  | "projection://event"
  | "projection://reset"
  | "conn://incompatible"
  | "conn://error"
  | "conn://liveness"
  | "conn://reconnect"
  | "app://window-state"
  | "app://quit-requested";

export interface WindowState {
  visible: boolean;
  maximized: boolean;
  fullscreen: boolean;
  closeToTray: boolean;
  tray: boolean;
}

export interface DesktopWindowControls {
  state(): Promise<WindowState>;
  hide(): Promise<void>;
  show(): Promise<void>;
  setCloseToTray(value: boolean): Promise<WindowState>;
  setTrayStatus(text: string): Promise<void>;
  /** WCO 配色跟随主题;平台不支持时 resolve(false),仅外观不承担关窗职责。 */
  setTitleBarOverlay(options: { color?: string; symbolColor?: string }): Promise<boolean>;
}

export interface DevToolsBridge {
  /** 切换 Chrome DevTools;返回开关后的状态(true=已打开)。 */
  toggle(): Promise<boolean>;
}

/** 休眠限制模式:off=不干预;keep-awake=阻止系统休眠(允许熄屏);
 *  keep-awake-bright=阻止休眠且保持屏幕常亮(演示/监控)。 */
export type PowerBlockerMode = "off" | "keep-awake" | "keep-awake-bright";

export interface PowerBlockerState {
  mode: PowerBlockerMode;
  /** 主进程侧 blocker 是否真实生效(powerSaveBlocker.isStarted)。 */
  active: boolean;
}

export interface PowerBlockerBridge {
  /** 设置模式并返回主进程侧的实际状态;非法模式会 throw。 */
  set(mode: PowerBlockerMode): Promise<PowerBlockerState>;
  /** 查询主进程侧当前状态(不改动)。 */
  state(): Promise<PowerBlockerState>;
}

/** GPU 加速偏好(渲染性能模式驱动;命令行开关启动前定格,改档须重启壳)。 */
export interface GpuPrefState {
  /** 本次启动实际是否禁用 GPU(启动时按偏好追加开关的结果)。 */
  currentLaunchDisabled: boolean;
  /** 偏好文件里的下次启动值;与 current 不同即"待重启生效"。 */
  nextLaunchDisabled: boolean;
}

export interface GpuPrefBridge {
  state(): Promise<GpuPrefState>;
  set(disabled: boolean): Promise<GpuPrefState>;
}

export interface DesktopHostBridge {
  readonly platform: "electron";
  invoke<T = unknown>(command: HostCommand, args?: Record<string, unknown>): Promise<T>;
  listen(event: HostEvent, callback: (payload: any) => void): () => void;
  windowControls?: DesktopWindowControls;
  devtools?: DevToolsBridge;
  powerBlocker?: PowerBlockerBridge;
  gpuPref?: GpuPrefBridge;
  relaunch?(): Promise<void>;
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
