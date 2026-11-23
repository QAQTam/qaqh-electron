/**
 * 「本机」遥测面:壳进程 + 界面进程组 + 宿主机水位 + 渲染层自身。
 * daemon 内存仍走 `memwatch.ts` 的 RPC。
 */
import { invoke } from "./host";
import { desktopHost } from "./desktop-host";
import { isDesktopRuntime } from "./transport";
import type { ProcessMemory } from "./memwatch";

export interface HostProcessMemory extends ProcessMemory {
  pid?: number | null;
  cpu_percent?: number | null;
  idle_wakeups?: number | null;
  creation_time?: number | null;
}

export interface HostTelemetry {
  systemMemory: {
    totalBytes: number;
    freeBytes: number;
    swapTotalBytes: number | null;
    swapFreeBytes: number | null;
  };
  eventLoop: {
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  cpuCores: number;
  uptimeSec: number;
}

export interface HostRuntimeInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  osRelease: string;
  cpuCores: number;
  display: {
    width: number;
    height: number;
    scaleFactor: number;
    refreshRate: number;
  };
  logDir: string;
}

/** 渲染层自报的数字;`performance.memory` 只有 Chromium 渲染进程有。 */
export interface RendererMemory {
  usedJsHeapBytes: number | null;
  totalJsHeapBytes: number | null;
  jsHeapLimitBytes: number | null;
  blinkAllocatedBytes: number | null;
  blinkTotalBytes: number | null;
  /** 主文档元素节点数(不含 Shadow DOM 内部与跨域 iframe)。 */
  domNodes: number;
  childFrames: number;
}

export interface MachineProcessRow {
  id: "shell" | "daemon";
  label: string;
  pid: number | null;
  resident: number | null;
  private: number | null;
  peak: number | null;
  cpuPercent: number | null;
  idleWakeups: number | null;
  source: string;
}

export interface MachineMemoryView {
  rows: MachineProcessRow[];
  group: GroupRow[];
  renderer: RendererMemory | null;
  totalBytes: number | null;
  totalCpuPercent: number | null;
  totalIdleWakeups: number | null;
  excluded: string[];
}

export interface ProcessGroupMember {
  pid: number;
  kind: string;
  name?: string | null;
  resident_bytes: number | null;
  private_bytes: number | null;
  peak_resident_bytes?: number | null;
  cpu_percent?: number | null;
  idle_wakeups?: number | null;
  creation_time?: number | null;
  sandboxed?: boolean | null;
  error: string | null;
}

export interface ProcessGroup {
  source: string;
  error: string | null;
  members: ProcessGroupMember[];
}

export interface GroupRow {
  kind: string;
  label: string;
  count: number;
  pids: number[];
  resident: number | null;
  private: number | null;
  peak: number | null;
  cpuPercent: number | null;
  idleWakeups: number | null;
  failed: number;
}

const KIND_LABEL: Record<string, string> = {
  browser: "Browser",
  renderer: "Renderer",
  gpu: "GPU",
  utility: "Utility",
  network: "Network",
  zygote: "Zygote",
  sandbox_helper: "Sandbox Helper",
  ppapi_plugin: "PPAPI Plugin",
  ppapi_broker: "PPAPI Broker",
  other: "Other",
  unknown: "Unknown",
};

const SHARED_PAGE_KINDS = new Set(["zygote", "sandbox_helper"]);

export const loadProcessGroup = (): Promise<ProcessGroup | null> =>
  isDesktopRuntime() ? invoke<ProcessGroup | null>("host_process_group") : Promise.resolve(null);

export const loadHostTelemetry = (): Promise<HostTelemetry | null> =>
  isDesktopRuntime() ? invoke<HostTelemetry | null>("host_telemetry") : Promise.resolve(null);

export const stopHostTelemetry = (): Promise<void> =>
  isDesktopRuntime() ? invoke("host_telemetry_stop").then(() => undefined, () => undefined) : Promise.resolve();

export const loadHostRuntimeInfo = (): Promise<HostRuntimeInfo | null> =>
  isDesktopRuntime() ? invoke<HostRuntimeInfo | null>("host_runtime_info") : Promise.resolve(null);

export const openHostLogs = (): Promise<{ ok: boolean; error: string | null } | null> =>
  isDesktopRuntime() ? invoke<{ ok: boolean; error: string | null }>("host_open_logs") : Promise.resolve(null);

/** 按角色聚合;保持首次出现的顺序,免得每秒重排一次表格。 */
export function groupRowsByKind(group: ProcessGroup | null): GroupRow[] {
  if (group == null) return [];
  const byKind = new Map<string, GroupRow>();
  for (const member of group.members) {
    const row = byKind.get(member.kind) ?? {
      kind: member.kind,
      label: KIND_LABEL[member.kind] ?? member.kind,
      count: 0,
      pids: [],
      resident: null,
      private: null,
      peak: null,
      cpuPercent: null,
      idleWakeups: null,
      failed: 0,
    };
    row.count += 1;
    row.pids.push(member.pid);
    if (member.resident_bytes == null) row.failed += 1;
    if (member.resident_bytes != null) row.resident = (row.resident ?? 0) + member.resident_bytes;
    if (member.private_bytes != null) row.private = (row.private ?? 0) + member.private_bytes;
    if (member.peak_resident_bytes != null) row.peak = (row.peak ?? 0) + member.peak_resident_bytes;
    if (member.cpu_percent != null) row.cpuPercent = (row.cpuPercent ?? 0) + member.cpu_percent;
    if (member.idle_wakeups != null) row.idleWakeups = (row.idleWakeups ?? 0) + member.idle_wakeups;
    byKind.set(member.kind, row);
  }
  return [...byKind.values()];
}

export async function loadHostMemory(): Promise<HostProcessMemory | null> {
  if (!isDesktopRuntime()) return null;
  const value = await invoke<HostProcessMemory | null>("host_memory");
  return value == null ? null : value;
}

interface MemoryInfoLike {
  usedJSHeapSize?: unknown;
  totalJSHeapSize?: unknown;
  jsHeapSizeLimit?: unknown;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const positiveOrNull = (value: unknown): number | null => {
  const parsed = finiteOrNull(value);
  return parsed == null || parsed === 0 ? null : parsed;
};

export function readRendererMemory(
  perf: { memory?: MemoryInfoLike },
  domNodes: number,
  childFrames: number,
  blink?: { allocated?: unknown; total?: unknown } | null,
): RendererMemory {
  const info = perf.memory ?? {};
  const blinkAlloc = finiteOrNull(blink?.allocated);
  const blinkTotal = finiteOrNull(blink?.total);
  return {
    usedJsHeapBytes: finiteOrNull(info.usedJSHeapSize),
    totalJsHeapBytes: finiteOrNull(info.totalJSHeapSize),
    jsHeapLimitBytes: positiveOrNull(info.jsHeapSizeLimit),
    blinkAllocatedBytes: blinkAlloc != null ? blinkAlloc * 1024 : null,
    blinkTotalBytes: blinkTotal != null ? blinkTotal * 1024 : null,
    domNodes,
    childFrames,
  };
}

export function captureRendererMemory(): RendererMemory {
  if (typeof document === "undefined" || typeof performance === "undefined") {
    return readRendererMemory({}, 0, 0, null);
  }
  const frames = window?.frames?.length ?? 0;
  let blink: { allocated: number; total: number } | null = null;
  try {
    blink = desktopHost()?.devtools?.blinkMemory?.() ?? null;
  } catch {}
  return readRendererMemory(
    performance as Performance & { memory?: MemoryInfoLike },
    document.getElementsByTagName("*").length,
    frames,
    blink,
  );
}

const rowOf = (
  id: MachineProcessRow["id"],
  label: string,
  proc: HostProcessMemory | null,
): MachineProcessRow | null => {
  if (proc == null) return null;
  return {
    id,
    label,
    pid: proc.pid ?? null,
    resident: proc.resident_bytes,
    private: proc.private_bytes,
    peak: proc.peak_resident_bytes,
    cpuPercent: proc.cpu_percent ?? null,
    idleWakeups: proc.idle_wakeups ?? null,
    source: proc.source,
  };
};

export function summarizeMachineMemory(
  host: HostProcessMemory | null,
  daemon: ProcessMemory | null,
  renderer: RendererMemory | null,
  group: ProcessGroup | null,
): MachineMemoryView {
  const rows: MachineProcessRow[] = [];
  const excluded: string[] = [];
  for (const [id, label, proc] of [
    ["shell", "Electron 主进程", host],
    ["daemon", "daemon 进程", daemon],
  ] as const) {
    const entry = rowOf(id, label, proc);
    if (entry == null) excluded.push(`${label}(未读到)`);
    else rows.push(entry);
  }
  const parts: number[] = [];
  const cpuParts: number[] = [];
  const wakeupParts: number[] = [];
  for (const entry of rows) {
    if (entry.resident != null) parts.push(entry.resident);
    else excluded.push(`${entry.label} 的 resident 缺测`);
    if (entry.cpuPercent != null) cpuParts.push(entry.cpuPercent);
    if (entry.idleWakeups != null) wakeupParts.push(entry.idleWakeups);
  }
  const groupRows = groupRowsByKind(group);
  for (const entry of groupRows) {
    if (SHARED_PAGE_KINDS.has(entry.kind)) {
      if (entry.resident != null) excluded.push(`${entry.label} ${entry.count} 个(共享 fork 页)`);
      continue;
    }
    if (entry.resident != null) parts.push(entry.resident);
    if (entry.cpuPercent != null) cpuParts.push(entry.cpuPercent);
    if (entry.idleWakeups != null) wakeupParts.push(entry.idleWakeups);
    if (entry.failed > 0) excluded.push(`${entry.label} 有 ${entry.failed} 个进程读不到`);
  }
  if (group == null) excluded.push("界面进程组(壳未提供)");
  else if (group.source === "unsupported") excluded.push(`界面进程组(${group.error ?? "本平台未实现"})`);
  else if (group.members.length === 0) excluded.push("界面进程组(0 个子进程)");
  if (renderer?.usedJsHeapBytes != null) {
    const rendererCountedInGroup = groupRows.some((row) => row.kind === "renderer" && row.resident != null);
    if (rendererCountedInGroup) excluded.push("页面 JS 堆(已含在 Renderer 工作集)");
    else parts.push(renderer.usedJsHeapBytes);
  } else {
    excluded.push("页面 JS 堆");
  }
  return {
    rows,
    group: groupRows,
    renderer,
    totalBytes: parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null,
    totalCpuPercent: cpuParts.length > 0 ? cpuParts.reduce((sum, value) => sum + value, 0) : null,
    totalIdleWakeups: wakeupParts.length > 0 ? wakeupParts.reduce((sum, value) => sum + value, 0) : null,
    excluded,
  };
}
