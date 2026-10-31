/**
 * 传输后端接口 — 前端到后端的唯一门面。
 *
 * Electron 桌面壳模式:主进程经 @qaqh/sdk 直连 daemon,
 * 前端只走 preload 的类型化 invoke + 事件订阅(daemon token 不会出现在 webview)。
 * store/组件只面向本接口;连接管理由宿主事件驱动(见 `StreamHandlers`)。
 */

import type { ContentRef } from "../../api/qaqh/ContentRef";
import type { RingingCommandAck } from "../../api/qaqh/RingingCommandAck";
import { isDesktopRuntime } from "../desktop-host";

export { isDesktopRuntime };

export const RINGING_SCHEMA = "qaqh.Ringing";
/** Ringing v2 单一信封版本:历史 v1 兼容已拆除。 */
export const RINGING_VERSION = 2;

/**
 * 命令确认。形状是生成绑定(此前手写镜像漏掉了 `retry_after_ms` —— 限流/退避
 * 提示),本地只留别名。
 */
export type Ack = RingingCommandAck;

export type ApprovalKind = "tool_permission" | "ask" | "plan";

export type ApprovalView = {
  challenge_id: string;
  kind: ApprovalKind;
  expires_in: number;
  details: Record<string, any>;
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
export type AttachmentUploadWire = ContentRef & { name: string; size: number };

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

/**
 * 从命令里取出待发附件引用。空数组等同携带——会被序列化成 `attachments: []`,
 * 所以这里直接收敛成 null,让命令与「本来就没有附件」逐字同形。
 */
export function attachmentRefsOf(command: Record<string, unknown>): ContentRef[] | null {
  const value = command.attachments;
  return Array.isArray(value) && value.length > 0 ? (value as ContentRef[]) : null;
}

/** 宿主事件的订阅面(事件 payload 与现行 SSE 帧同形)。 */
export interface StreamHandlers {
  onProjectionStatus?(status: ProjectionStatusWire): void;
  onProjectionEvent(seed: string, envelope: Record<string, any>): void;
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

  respondApproval(sessionId: string, challengeId: string, decision: string, payload?: Record<string, unknown>): Promise<null>;

  command(channel: "control" | "conversation", command: Record<string, unknown>, sessionId?: string): Promise<Ack>;

  rpc<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;

  /** per-session bootstrap RPC(获取权威快照)。 */
  sessionBootstrap(seed: string): Promise<unknown>;

  /** 由宿主经 SDK 读取引用正文，认证信息留在主进程。 */
  readContentText(contentRef: string): Promise<string>;

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
   * 返回的引用直接进 `send_message` 的 `attachments`。
   */
  uploadAttachment(seed: string, path: string): Promise<AttachmentUploadWire>;

  /**
   * 用户级 skills 扫描结果(`~/.qaqh/skills`、`~/.agents/skills`)。
   *
   * 这两个根**不在** daemon `fs.*` 的 allowed_roots 里(数据根 + UI 注册工作区 +
   * 会话 cwd,`qaqh-backend/crates/qaqh-runtime/src/service/fs_git.rs:28-51`),
   * 渲染层读不到;daemon 自己的 catalog 又只经 Ringing 控制事件出去(投影里没有
   * 对应 fact),所以由宿主按同一份规则读出来。
   */
  userSkills(): Promise<UserSkillsWire>;
}

/** 用户级发现根(展示用)。 */
export type UserSkillRoot = {
  /** 绝对路径。 */
  path: string;
  /** `~/.agents/skills` 形态的展示标签。 */
  label: string;
  /** 目录存在且可读。 */
  exists: boolean;
};

/** 一条用户级 skill 的原始文件;frontmatter 由 `skills/parse.ts` 解析。 */
export type UserSkillFile = {
  /** 发现它的根(绝对路径)。 */
  root: string;
  /** `SKILL.md` 绝对路径。 */
  path: string;
  /** 正文(CRLF 已归一)。 */
  content: string;
  bytes: number;
};

export type UserSkillDiagnostic = { path: string; message: string };

export type UserSkillsWire = {
  roots: UserSkillRoot[];
  skills: UserSkillFile[];
  diagnostics: UserSkillDiagnostic[];
};

/** Electron 桌面壳专属面。 */
export interface DesktopHostSurface {
  /** 订阅宿主转发事件;返回反订阅函数。 */
  subscribe(handlers: StreamHandlers): Promise<() => void>;
  /** per-session bootstrap RPC(刷新 activity)。 */
  sessionBootstrap(seed: string): Promise<unknown>;
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
