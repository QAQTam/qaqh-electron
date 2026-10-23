export interface DaemonDiscovery {
  endpoint: string;
  token: string;
  pid: number;
  server_epoch: string;
  protocol_version: number;
  daemon_version?: string;
  build_id?: string;
  channel?: string;
  executable?: string;
  lan_endpoint?: string;
  tls_fingerprint?: string;
}

export interface RingingCommandAck {
  status: "accepted" | "rejected";
  command_id?: string;
  code?: string;
  message?: string;
  retry_after_ms?: number;
}

export type ApprovalKind = "tool_permission" | "ask" | "plan";

export interface ApprovalView {
  challenge_id: string;
  kind: ApprovalKind;
  expires_in: number;
  details: Record<string, any>;
}

export interface TimelineStatusWire {
  status: "connecting" | "open" | "reconnecting" | "closed";
  session_id?: string;
  [key: string]: unknown;
}

export interface UserSkillRoot {
  path: string;
  label: string;
  exists: boolean;
}

export interface UserSkillFile {
  root: string;
  path: string;
  content: string;
  bytes: number;
}

export interface UserSkillDiagnostic {
  path: string;
  message: string;
}

export interface UserSkillsWire {
  roots: UserSkillRoot[];
  skills: UserSkillFile[];
  diagnostics: UserSkillDiagnostic[];
}

export interface ScreenshotWire {
  path: string;
  name: string;
  size: number;
}

export interface AttachmentUploadWire {
  content_id: string;
  sha256: string;
  media_type: string;
  name: string;
  size: number;
  truncated: boolean;
}
