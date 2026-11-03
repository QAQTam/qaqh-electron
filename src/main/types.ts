// 协议契约类型直接复用 @qaqh/sdk 的生成产物，避免两份定义漂移
import type {
  DaemonDiscovery as SdkDaemonDiscovery,
  ConfigDto,
  RingingV2CommandAck,
  ServiceMap,
} from "@qaqh/sdk/protocol";

export type DaemonDiscovery = SdkDaemonDiscovery;

export type RingingCommandAck = RingingV2CommandAck;

/** Service entry points not yet included in the backend's generated ServiceMap. */
export type MainServiceMap = ServiceMap & {
  "config.load": { params: Record<never, never>; result: ConfigDto };
  "profile.list": { params: Record<never, never>; result: unknown };
  "skills.list_tools": { params: Record<never, never>; result: unknown };
  "todo.status": { params: { session_id: string }; result: unknown };
  "todo.list": { params: { session_id: string; [key: string]: unknown }; result: Record<string, unknown> };
  "plan.read": { params: { session_id: string }; result: unknown };
  "diagnostics.memory.snapshot": { params: { after_sequence?: number }; result: unknown };
};

export type MainServiceMethod = keyof MainServiceMap;

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
