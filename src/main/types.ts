// 协议契约类型直接复用 backend exporter 生成、webui 镜像持有的同一份产物，
// main 与 renderer 不再有第二份生成目录（原 @qaqh/sdk/protocol 依赖已退役）。
import type { ClientsListParams } from "../../webui/src/api/qaqh/ClientsListParams";
import type { ConfigDto } from "../../webui/src/api/qaqh/ConfigDto";
import type { DaemonDiscovery as ContractDaemonDiscovery } from "../../webui/src/api/qaqh/DaemonDiscovery";
import type { RingingV2ClientView } from "../../webui/src/api/qaqh/RingingV2ClientView";
import type { FsEntry } from "../../webui/src/api/qaqh/FsEntry";
import type { FsReadResult } from "../../webui/src/api/qaqh/FsReadResult";
import type { RingingV2CommandAck } from "../../webui/src/api/qaqh/RingingV2CommandAck";
import type { RingingV2CommandStatus } from "../../webui/src/api/qaqh/RingingV2CommandStatus";
import type { SessionActivity } from "../../webui/src/api/qaqh/SessionActivity";
import type { SessionDashboard } from "../../webui/src/api/qaqh/SessionDashboard";
import type { SessionListEntry } from "../../webui/src/api/qaqh/SessionListEntry";
import type { SessionMeta } from "../../webui/src/api/qaqh/SessionMeta";
import type { WorkspaceEntry } from "../../webui/src/api/qaqh/WorkspaceEntry";

export type DaemonDiscovery = ContractDaemonDiscovery;

export type RingingCommandAck = RingingV2CommandAck;

/**
 * 服务面 IPC 的 typed 方法表：params/result 与 daemon 真源对齐。方法全集由
 * native addon 的 `serviceMethods()` 提供（QueryRequest 封闭枚举 + 账号面白名单），
 * 这里只补 TS 侧的形状（账号面 18 个方法沿用 `unknown` result——见 docs B08）。
 */
export type MainServiceMap = {
  /** 活跃连接 presence 视图；daemon 基础设施查询，不属于会话业务，故无 session_id。 */
  "clients.list": { params: ClientsListParams; result: RingingV2ClientView[] };
  "daemon.version": { params: Record<never, never>; result: string };
  "session.list": { params: { include_archived?: boolean }; result: SessionListEntry[] };
  "session.meta": { params: { session_id: string }; result: SessionListEntry | null };
  "session.activity": { params: Record<never, never>; result: SessionActivity[] };
  "session.get_activity": { params: { session_id: string }; result: unknown };
  "session.dashboard": { params: { session_id: string }; result: SessionDashboard };
  "session.turn": { params: { session_id: string; turn_id: string }; result: unknown };
  "workspace.get": { params: { session_id: string }; result: string };
  "workspace.list": { params: Record<never, never>; result: WorkspaceEntry[] };
  "fs.list": { params: { path: string }; result: FsEntry[] };
  "fs.read": { params: { path: string; max_bytes?: number }; result: FsReadResult };
  "config.load": { params: Record<never, never>; result: ConfigDto };
  "profile.list": { params: Record<never, never>; result: unknown };
  "skills.catalog": { params: { cwd?: string }; result: unknown };
  "skills.list_tools": { params: Record<never, never>; result: unknown };
  "todo.status": { params: { session_id: string }; result: unknown };
  "todo.list": { params: { session_id: string; [key: string]: unknown }; result: Record<string, unknown> };
  "plan.read": { params: { session_id: string }; result: unknown };
  "diagnostics.memory.snapshot": { params: { after_sequence?: number }; result: unknown };
  "siwc.status": { params: Record<never, never>; result: unknown };
  "siwc.profiles": { params: Record<never, never>; result: unknown };
  "siwc.models": { params: { profile_id?: string }; result: unknown };
  "siwc.sign_in.start": { params: Record<string, unknown>; result: unknown };
  "siwc.sign_in.status": { params: { flow_id: string }; result: unknown };
  "siwc.sign_in.cancel": { params: { flow_id: string }; result: unknown };
  "siwc.profile.select": { params: { profile_id: string }; result: unknown };
  "siwc.sign_out": { params: { profile_id?: string }; result: unknown };
  "dsaccount.status": { params: Record<never, never>; result: unknown };
  "dsaccount.balance": { params: Record<never, never>; result: unknown };
  "dsaccount.bonuses": { params: Record<never, never>; result: unknown };
  "dsaccount.sign_in.start": { params: Record<string, unknown>; result: unknown };
  "dsaccount.sign_in.status": { params: Record<never, never>; result: unknown };
  "dsaccount.sign_in.cancel": { params: { attempt_id: string }; result: unknown };
  "dsaccount.sign_out": { params: Record<never, never>; result: unknown };
  "dsaccount.bonus.ack": { params: { order_id: string }; result: unknown };
  "dsaccount.models": { params: Record<never, never>; result: unknown };
  "dsaccount.verify": { params: Record<never, never>; result: unknown };
};

export type MainServiceMethod = keyof MainServiceMap;

/** 运行时方法清单（与 addon `serviceMethods()` 双向一致性由 packaging 测试校验）。 */
export const MAIN_SERVICE_METHODS: readonly MainServiceMethod[] = [
  "clients.list",
  "daemon.version", "session.list", "session.meta", "session.activity", "session.get_activity",
  "session.dashboard", "session.turn", "workspace.get", "workspace.list", "fs.list", "fs.read", "config.load",
  "profile.list", "skills.catalog", "skills.list_tools", "todo.status", "todo.list", "plan.read",
  "diagnostics.memory.snapshot", "siwc.status", "siwc.profiles", "siwc.models",
  "siwc.sign_in.start", "siwc.sign_in.status", "siwc.sign_in.cancel", "siwc.profile.select",
  "siwc.sign_out", "dsaccount.status", "dsaccount.balance", "dsaccount.bonuses",
  "dsaccount.sign_in.start", "dsaccount.sign_in.status", "dsaccount.sign_in.cancel",
  "dsaccount.sign_out", "dsaccount.bonus.ack", "dsaccount.models", "dsaccount.verify",
];

/**
 * discovery 文档 `protocol_version` 字段的期望值：daemon 发布的是**控制面协议**
 * 版本（真源 `qaqh_types::CONTROL_PROTOCOL_VERSION`），不是 Ringing wire 版本。
 * Ringing wire v2 由握手 capabilities 表达（addon `ringingV2Version()`）。
 */
export const CONTROL_PROTOCOL_VERSION = 1;
export type { RingingV2CommandStatus };

export type ApprovalKind = "tool_permission" | "ask" | "plan";

export interface ApprovalView {
  challenge_id: string;
  kind: ApprovalKind;
  expires_in: number;
  details: Record<string, any>;
  /** True when the canonical interaction request body could not be loaded. */
  details_unavailable?: boolean;
  verified?: boolean;
}

export interface ProjectionStatusWire {
  status: "connecting" | "live" | "reconnecting" | "paused" | "closed";
  session_id?: string;
}

/** Scheduled SSE reconnect after a transport drop (conn://reconnect). */
export interface ReconnectStatusWire {
  session_id: string;
  /** 1-based attempt number for the next reconnect. */
  attempt: number;
  delay_ms: number;
  /** Host clock at scheduling time, so the renderer can age the notice. */
  at: number;
}

export interface ScreenshotWire {
  path: string;
  name: string;
  size: number;
}

export interface AttachmentUploadWire {
  content_ref: string;
  media_type: string;
  name: string;
  size: number;
  truncated: boolean;
}
