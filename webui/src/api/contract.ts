/**
 * 契约类型统一入口。
 *
 * backend exporter 生成的每文件 DTO（./qaqh/*）经此汇聚；@qaqh/sdk 已退役，
 * renderer 与 Electron main 共享同一份生成产物（../qaqh 的镜像）。
 * ServiceMap 是本地手写的 36 方法表——与 native addon `serviceMethods()` 的
 * 运行时白名单一致性由 Electron 侧 packaging 测试校验；账号面方法的 result
 * 维持 unknown（见 docs B08：后端尚未导出这批 DTO）。
 */
export type { ActivityState } from "./qaqh/ActivityState";
export type { CodeDelta } from "./qaqh/CodeDelta";
export type { CommandPrecondition } from "./qaqh/CommandPrecondition";
export type { CommandTarget } from "./qaqh/CommandTarget";
export type { ConfigDto } from "./qaqh/ConfigDto";
export type { ContentValue } from "./qaqh/ContentValue";
export type { ConversationSendMessage } from "./qaqh/ConversationSendMessage";
export type { ExecSessionState } from "./qaqh/ExecSessionState";
export type { ExecSessionView } from "./qaqh/ExecSessionView";
export type { ModelDef } from "./qaqh/ModelDef";
export type { ModelSelection } from "./qaqh/ModelSelection";
export type { RingingCommand } from "./qaqh/RingingCommand";
export type { RingingV2CommandAck } from "./qaqh/RingingV2CommandAck";
export type { SessionActivityState } from "./qaqh/SessionActivityState";
export type { SessionBootstrap } from "./qaqh/SessionBootstrap";
export type { SessionContentRef } from "./qaqh/SessionContentRef";
export type { SessionEventFrame } from "./qaqh/SessionEventFrame";
export type { SessionListEntry } from "./qaqh/SessionListEntry";
export type { SessionSettingsPatch } from "./qaqh/SessionSettingsPatch";
export type { SessionTurnSnapshot } from "./qaqh/SessionTurnSnapshot";
export type { TimelineEntry } from "./qaqh/TimelineEntry";
export type { ToolCallOutcome } from "./qaqh/ToolCallOutcome";
export type { ToolCallState } from "./qaqh/ToolCallState";
export type { ToolCallView } from "./qaqh/ToolCallView";
export type { ToolEffectInfo } from "./qaqh/ToolEffectInfo";
export type { ToolsSettingPatch } from "./qaqh/ToolsSettingPatch";
export type { TurnOutcome } from "./qaqh/TurnOutcome";
export type { TurnPhase } from "./qaqh/TurnPhase";
export type { UsageInfo } from "./qaqh/UsageInfo";
export type { WidgetContext } from "./qaqh/WidgetContext";
export type { WidgetRef } from "./qaqh/WidgetRef";
export type { JsonValue } from "./serde_json/JsonValue";

import type { ConfigDto } from "./qaqh/ConfigDto";
import type { SessionListEntry } from "./qaqh/SessionListEntry";
import type { SessionActivity } from "./qaqh/SessionActivity";
import type { SessionTurnSnapshot } from "./qaqh/SessionTurnSnapshot";
import type { SkillsCatalogResult } from "./qaqh/SkillsCatalogResult";
import type { WorkspaceEntry } from "./qaqh/WorkspaceEntry";
import type { DsAccountBalanceResult } from "./qaqh/DsAccountBalanceResult";
import type { DsAccountBonus } from "./qaqh/DsAccountBonus";
import type { DsAccountModel } from "./qaqh/DsAccountModel";
import type { DsAccountSignInStartResult } from "./qaqh/DsAccountSignInStartResult";
import type { DsAccountSignInStatusResult } from "./qaqh/DsAccountSignInStatusResult";
import type { DsAccountStatusResult } from "./qaqh/DsAccountStatusResult";
import type { DsAccountVerifyResult } from "./qaqh/DsAccountVerifyResult";
import type { SiwcSignInStartParams } from "./qaqh/SiwcSignInStartParams";
import type { DsAccountSignInStartParams } from "./qaqh/DsAccountSignInStartParams";
import type { SiwcModel } from "./qaqh/SiwcModel";
import type { SiwcProfilesResult } from "./qaqh/SiwcProfilesResult";
import type { SiwcSignInStartResult } from "./qaqh/SiwcSignInStartResult";
import type { SiwcSignInStatusResult } from "./qaqh/SiwcSignInStatusResult";
import type { SiwcSignOutResult } from "./qaqh/SiwcSignOutResult";
import type { SiwcStatusResult } from "./qaqh/SiwcStatusResult";

/** 服务面 typed 方法表（真源：qaqh-client 的封闭查询枚举 + 账号面白名单）。 */
export type ServiceMap = {
  "daemon.version": { params: Record<never, never>; result: string };
  "session.list": { params: { include_archived?: boolean }; result: SessionListEntry[] };
  "session.meta": { params: { session_id: string }; result: SessionListEntry | null };
  "session.activity": { params: Record<never, never>; result: SessionActivity[] };
  "session.get_activity": { params: { session_id: string }; result: unknown };
  "session.dashboard": { params: { session_id: string }; result: unknown };
  "session.turn": { params: { session_id: string; turn_id: string }; result: SessionTurnSnapshot | null };
  "workspace.get": { params: { session_id: string }; result: string };
  "workspace.list": { params: Record<never, never>; result: WorkspaceEntry[] };
  "fs.list": { params: { path: string }; result: unknown };
  "fs.read": { params: { path: string; max_bytes?: number }; result: unknown };
  "config.load": { params: Record<never, never>; result: ConfigDto };
  "profile.list": { params: Record<never, never>; result: unknown };
  "skills.catalog": { params: { cwd?: string | null }; result: SkillsCatalogResult };
  "skills.list_tools": { params: Record<never, never>; result: unknown };
  "todo.status": { params: { session_id: string }; result: unknown };
  "todo.list": { params: { session_id: string; [key: string]: unknown }; result: Record<string, unknown> };
  "plan.read": { params: { session_id: string }; result: unknown };
  "diagnostics.memory.snapshot": { params: { after_sequence?: number }; result: unknown };
  "siwc.status": { params: Record<never, never>; result: SiwcStatusResult };
  "siwc.profiles": { params: Record<never, never>; result: SiwcProfilesResult };
  "siwc.models": { params: { profile_id?: string }; result: SiwcModel[] };
  "siwc.sign_in.start": { params: SiwcSignInStartParams; result: SiwcSignInStartResult };
  "siwc.sign_in.status": { params: { flow_id: string }; result: SiwcSignInStatusResult };
  "siwc.sign_in.cancel": { params: { flow_id: string }; result: null };
  "siwc.profile.select": { params: { profile_id: string }; result: SiwcStatusResult };
  "siwc.sign_out": { params: { profile_id?: string }; result: SiwcSignOutResult };
  "dsaccount.status": { params: Record<never, never>; result: DsAccountStatusResult };
  "dsaccount.balance": { params: Record<never, never>; result: DsAccountBalanceResult };
  "dsaccount.bonuses": { params: Record<never, never>; result: DsAccountBonus[] };
  "dsaccount.sign_in.start": { params: DsAccountSignInStartParams; result: DsAccountSignInStartResult };
  "dsaccount.sign_in.status": { params: Record<never, never>; result: DsAccountSignInStatusResult };
  "dsaccount.sign_in.cancel": { params: { attempt_id: string }; result: null };
  "dsaccount.sign_out": { params: Record<never, never>; result: null };
  "dsaccount.bonus.ack": { params: { order_id: string }; result: null };
  "dsaccount.models": { params: Record<never, never>; result: DsAccountModel[] };
  "dsaccount.verify": { params: Record<never, never>; result: DsAccountVerifyResult };
};
