/**
 * 传输后端接口 — 前端到后端的唯一门面。
 *
 * Electron 桌面壳模式:主进程经 @qaqh/sdk 直连 daemon,
 * 前端只走 preload 的类型化 invoke + 事件订阅(daemon token 不会出现在 webview)。
 * store/组件只面向本接口;连接管理由宿主事件驱动(见 `StreamHandlers`)。
 */

import type {

  CommandPrecondition,
  CommandTarget,
  ConfigDto,
  ConversationSendMessage,
  RingingCommand,
  RingingV2CommandAck,
  ServiceMap as SdkServiceMap,
  SessionBootstrap,
  SessionEventFrame,

} from "../../api/contract";
import { isDesktopRuntime } from "../desktop-host";

export { isDesktopRuntime };
export type { CommandPrecondition, CommandTarget, RingingCommand };

/** Renderer-facing command surface excludes fields reserved for trusted runtime calls. */
export type RendererRingingCommand = Exclude<RingingCommand, { type: "conversation.send_message" }>
  | ({ type: "conversation.send_message" } & Omit<ConversationSendMessage, "as_system" | "inter_agent" | "subagent_terminal">);

/** Public service methods not yet present in the current generated ServiceMap. */
export type ElectronServiceMap = SdkServiceMap & {
  "config.load": { params: Record<never, never>; result: ConfigDto };
  /** qaqh-client QueryRequest 枚举仍列有 profile.list（daemon 已无实现；仅对齐白名单）。 */
  "profile.list": { params: Record<never, never>; result: unknown };
  "skills.list_tools": { params: Record<never, never>; result: unknown };
  "todo.status": { params: { session_id: string }; result: unknown };
  "todo.list": { params: { session_id: string; [key: string]: unknown }; result: Record<string, unknown> };
  "plan.read": { params: { session_id: string }; result: unknown };
  "diagnostics.memory.snapshot": { params: { after_sequence?: number }; result: unknown };
};

export type ServiceMethod = keyof ElectronServiceMap;
export type ServiceParams<K extends ServiceMethod> = ElectronServiceMap[K]["params"];
export type ServiceResult<K extends ServiceMethod> = ElectronServiceMap[K]["result"];

export const RINGING_SCHEMA = "qaqh.Ringing";
/** Ringing v2 单一信封版本:历史 v1 兼容已拆除。 */
export const RINGING_VERSION = 2;

/**
 * 命令确认。形状是生成绑定,本地只留别名。
 */
export type Ack = RingingV2CommandAck;

export const globalTarget = (): CommandTarget => ({ kind: "global" });
export const sessionTarget = (sessionId: string): CommandTarget => ({ kind: "session", session_id: sessionId });
export const workspaceTarget = (workspaceId: string): CommandTarget => ({ kind: "workspace", workspace_id: workspaceId });
export const execSessionTarget = (id: string): CommandTarget => ({ kind: "exec_session", id });

/** Host 审批面词表：admin 投影只有 permission/ask 两类（plan 已随
 *  `plan.review.respond` 退役，仅存于 device challenge 词表）。 */
export type ApprovalKind = "tool_permission" | "ask";

export type ApprovalView = {
  challenge_id: string;
  kind: ApprovalKind;
  expires_in: number;
  details: Record<string, any>;
  /** False until a fresh authoritative approvals read confirms the view. */
  details_unavailable?: boolean;
  /** The view is stale or its latest authoritative check failed. */
  verified?: boolean;
};

/** Electron 宿主转发的 projection 状态(projection://status)。 */
export interface ProjectionStatusWire {
  status: "connecting" | "live" | "reconnecting" | "paused" | "closed";
  session_id?: string;
}

/** Electron host scheduled SSE reconnect (conn://reconnect). */
export type ReconnectStatusWire = {
  session_id: string;
  attempt: number;
  delay_ms: number;
  at: number;
};

/** todo.list 的条目线类型(daemon typed 投影;status 归一化在 UI 侧做)。 */
export type TodoItemWire = {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  evidence?: string;
};

/**
 * `upload_attachment` 的返回体 = 线类型 `ContentRef` + 两个纯展示字段。
 * 文件名/字节数由宿主在读盘时顺手带回(daemon 的 `POST /ringing/v2/content`
 * 只回 content_id/media_type/sha256/truncated,没有名字)。
 */
export type AttachmentUploadWire = { content_ref: string; media_type: string; name: string; size: number; truncated: boolean };

/**
 * `capture_screenshot` 的返回体(宿主侧的临时文件信息)。
 *
 * 刻意与 `AttachmentUploadWire` 分开:那是**上传后**的引用,这条只是"本机有这么个
 * 文件"。前端只把它当 `uploadAttachment` 的入参,不解析、不展示路径细节。
 */
export type ScreenshotWire = { path: string; name: string; size: number };

/**
 * 截图范围。`selection` = 系统十字准星拉一块(快捷键走这条,"就指这里");
 * `fullscreen` = 整屏一张,适合抓一闪即逝的状态。
 *
 * 没有 `window` 档是有意的:宿主侧拿窗口号需要平台特定 API,而"截错窗口"
 * 与"截错范围"一样难查——先给两个确定能截对的范围。
 */
export type ShotMode = "selection" | "fullscreen";

/** 宿主事件的订阅面(事件 payload 与现行 SSE 帧同形)。 */
export interface StreamHandlers {
  onProjectionStatus?(status: ProjectionStatusWire): void;
  onProjectionBootstrap?(seed: string, bootstrap: SessionBootstrap): void;
  onProjectionEvent(seed: string, event: SessionEventFrame): void;
  onProjectionReset(seed: string, reset: Record<string, any>): void;
  onIncompatible(details: Record<string, any>): void;
  onHostError(message: string): void;
  onReconnect?(info: ReconnectStatusWire): void;
}

export interface TransportBackend {
  /** 会话列表(宿主把 `session.list` 的 G2 条目投影成侧栏卡片字段)。 */
  sessions(): Promise<any[]>;

  /** attach:宿主切 active seed + attach + 激活 single stream。 */
  attach(seed: string, limit?: number): Promise<void>;

  /** 待审批(challenge 由宿主签发,canonical id 不出宿主)。 */
  approvals(sessionId: string): Promise<ApprovalView[]>;

  /** Team 投影快照(`GET /ringing/v2/sessions/{seed}/team`;无推送,按需拉取)。 */
  teamSnapshot(sessionId: string): Promise<unknown>;

  invalidateApprovals(sessionId: string, challengeId?: string, verified?: boolean | "revoke"): Promise<void>;

  respondApproval(sessionId: string, challengeId: string, decision: string, payload?: Record<string, unknown>): Promise<null>;

  /** Submit one daemon command (catalog op / channel command / service call) and return its acknowledgement. */
  command(command: RendererRingingCommand, target?: CommandTarget, preconditions?: CommandPrecondition[]): Promise<Ack>;

  /** Read a service method; required session identifiers belong in params. */
  query<K extends ServiceMethod>(method: K, params?: ServiceParams<K>): Promise<ServiceResult<K>>;

  /** per-session bootstrap RPC(获取权威快照)。 */
  sessionBootstrap(seed: string): Promise<SessionBootstrap>;

  /** 由宿主经 SDK 读取引用正文，认证信息留在主进程。 */
  readContentText(contentRef: string, signal?: AbortSignal): Promise<string>;

  /** 原生目录选择(新建会话的目标工作区);null = 用户取消或该形态无对话框。 */
  pickDirectory(): Promise<string | null>;

  /** 原生多选附件对话框;空数组 = 用户取消或该形态无对话框。 */
  pickAttachments(): Promise<string[]>;

  /**
   * 应用内截图(macOS 走系统 `screencapture`)。`null` = 用户取消(交互态按 Esc);
   * 拒绝 = 平台不支持或系统工具报错,调用方必须把原因说出来。
   *
   * 回的是**本机临时文件**信息:路径只用来接着调 `uploadAttachment`,字节不进 webview。
   */
  captureScreenshot(mode: ShotMode): Promise<ScreenshotWire | null>;

  /**
   * 上传单个本地附件。字节读取与上传都在宿主侧完成(命令里不允许出现本地路径),
   * 返回的引用直接进 `conversation.send_message` 的 `attachments`。
   */
  uploadAttachment(seed: string, path: string): Promise<AttachmentUploadWire>;
}

/** Electron 桌面壳专属面。 */
export interface DesktopHostSurface {
  /** 订阅宿主转发事件;返回反订阅函数。 */
  subscribe(handlers: StreamHandlers): Promise<() => void>;
  /** per-session bootstrap RPC(刷新 activity)。 */
  sessionBootstrap(seed: string): Promise<SessionBootstrap>;
  /** 宿主侧重连(用户点「重试」/窗口聚焦)。 */
  streamsRetry(seed?: string): Promise<void>;
  /** D1 不兼容路径:停止旧 daemon(不静默杀;Busy 时返回 "busy")。 */
  stopStaleDaemon(): Promise<"stopping" | "busy" | "unsupported">;
}

/** 若当前后端是 Electron 桌面壳宿主,返回其专属面;否则 null。 */
export function desktopHostSurface(backend: TransportBackend): DesktopHostSurface | null {
  return backend instanceof Object && "subscribe" in backend
    ? (backend as TransportBackend & DesktopHostSurface)
    : null;
}
