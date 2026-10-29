/**
 * updater 前端桥:组件热更新的检查/暂存/应用,全部走 qaqhHost.invoke →
 * 主进程 ipc-handlers 的 updater_* 命令 → qaqh-update CLI。
 * 纯浏览器环境(无 qaqhHost)一律返回 null,由面板兜成一行提示。
 */
import { desktopHost, requireDesktopHost } from "./desktop-host";

export interface UpdatePlanView {
  operationId: string;
  releaseId: string;
  mode: string;
  artifacts: string[];
  actions: string[];
}

export interface UpdateCheckResult {
  upToDate: boolean;
  plan: UpdatePlanView;
}

export interface StagedArtifactView {
  id: string;
  kind: string;
  path: string;
  size: number;
  sha256: string;
}

export interface StagedStatus {
  staged: true;
  operationId: string;
  releaseId: string;
  mode: string;
  artifacts: StagedArtifactView[];
  restartPolicy: "daemon" | "electron";
}

export async function checkForUpdates(source?: string): Promise<UpdateCheckResult | null> {
  const host = desktopHost();
  if (!host) return null;
  return host.invoke<UpdateCheckResult>("updater_check", source ? { source } : {});
}

export async function stageUpdate(source?: string): Promise<StagedStatus | null> {
  const host = desktopHost();
  if (!host) return null;
  return host.invoke<StagedStatus>("updater_stage", source ? { source } : {});
}

export async function loadStagedStatus(): Promise<StagedStatus | null> {
  const host = desktopHost();
  if (!host) return null;
  return host.invoke<StagedStatus | null>("updater_status", {});
}

export type ApplyResult =
  | { policy: "daemon"; reconnect: unknown }
  | { policy: "electron"; quit: true };

export async function applyStagedUpdate(): Promise<ApplyResult> {
  const host = requireDesktopHost();
  return host.invoke<ApplyResult>("updater_apply", {});
}
