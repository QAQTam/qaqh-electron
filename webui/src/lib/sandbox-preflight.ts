/**
 * 沙箱启动分步自检客户端封装（RingingV2 服务面：`sandbox.preflight.start` / `status`）。
 *
 * 与 `siwc.ts` 同构：后端真源负责执行真实内核探针（Token / DACL / Deny / ProjFS /
 * Bubblewrap / Landlock），前端只消费结构化快照并渲染进度与修复指引。
 */
import type {
  SandboxPreflightReport,
  SandboxPreflightStepStatus,
} from "../api/contract";
import { transport } from "./transport";

export type {
  SandboxPreflightReport,
  SandboxPreflightState,
  SandboxPreflightStep,
  SandboxPreflightStepStatus,
} from "../api/contract";

export const fetchSandboxPreflightStatus = (runId?: string): Promise<SandboxPreflightReport> =>
  transport.query("sandbox.preflight.status", runId == null ? {} : { run_id: runId });

export const startSandboxPreflight = (force = false): Promise<SandboxPreflightReport> =>
  transport.query("sandbox.preflight.start", { force });

export interface BackendDescription {
  name: string;
  badge: string;
  summary: string;
  tone: "ok" | "warn" | "err" | "muted";
}

export function describeSandboxBackend(
  backend: string,
  writeEnforced: boolean,
): BackendDescription {
  switch (backend) {
    case "windows_redirect":
      return {
        name: "Windows RedirectPlane (ProjFS + 受限令牌)",
        badge: "RedirectPlane · 最强",
        summary: "虚拟视图写重定向 + 受限令牌 + 内核 DACL，默认拦截误删并在命令结束时同步合并。",
        tone: writeEnforced ? "ok" : "warn",
      };
    case "windows_token":
      return {
        name: "Windows TokenPlane (受限令牌 + DACL)",
        badge: "TokenPlane · 写隔离",
        summary: "WRITE_RESTRICTED 受限令牌 + Capability SID DACL + 私有桌面 + Job Object，支持 NTFS / ReFS。",
        tone: writeEnforced ? "ok" : "warn",
      };
    case "linux_bubblewrap":
      return {
        name: "Linux Bubblewrap 命名空间沙箱",
        badge: "Bubblewrap · 写+网隔离",
        summary: "非特权用户命名空间 + 只读根挂载 + 独立网络命名空间。",
        tone: writeEnforced ? "ok" : "warn",
      };
    case "linux_landlock_seccomp":
      return {
        name: "Linux Landlock LSM + Seccomp-BPF",
        badge: "Landlock + Seccomp",
        summary: "内核 Landlock 写路径白名单 + Seccomp-BPF 网络与危险系统调用过滤。",
        tone: writeEnforced ? "ok" : "warn",
      };
    case "process_hardening":
      return {
        name: "仅进程加固（无文件系统/网络隔离）",
        badge: "未隔离",
        summary: "宿主机缺少 Bubblewrap 或 Landlock/Seccomp，命令将回退为人工审批模式。",
        tone: "err",
      };
    case "auto":
      return {
        name: "自动探测中",
        badge: "探测中",
        summary: "正在执行宿主机内核探针以确认最佳沙箱后端…",
        tone: "muted",
      };
    default:
      return {
        name: "未启用内核沙箱",
        badge: "未生效",
        summary: "当前平台未接线或自检未通过，exec_command 已自动回退为逐条人工审批（Fail-Closed）。",
        tone: "err",
      };
  }
}

export function describePlatform(platform: string): string {
  switch (platform) {
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "macos":
      return "macOS";
    default:
      return platform || "未知平台";
  }
}

export function stepStatusLabel(status: SandboxPreflightStepStatus): string {
  switch (status) {
    case "passed":
      return "通过";
    case "warning":
      return "提示";
    case "failed":
      return "失败";
    case "running":
      return "检测中";
    case "skipped":
      return "跳过";
    default:
      return "待检测";
  }
}

export interface ParsedRemediation {
  text: string;
  command: string | null;
}

/** 从后端返回的修复文案中提取可直接复制执行的命令（如 DISM / sysctl），避免把命令埋在长句里。 */
export function parseRemediation(text: string): ParsedRemediation {
  const dism = text.match(/DISM\s+\/Online\s+\/Enable-Feature\s+\/FeatureName:[^\s；。]+(?:\s+\/NoRestart)?/i);
  if (dism != null) {
    return { text, command: dism[0] };
  }
  const sysctl = text.match(/kernel\.unprivileged_userns_clone=1/);
  if (sysctl != null) {
    return { text, command: "sudo sysctl -w kernel.unprivileged_userns_clone=1" };
  }
  return { text, command: null };
}
