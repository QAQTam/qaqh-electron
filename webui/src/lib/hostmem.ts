/**
 * 「本机」内存面:壳进程 + 渲染层自己。daemon 那一行仍走 `memwatch.ts` 的 RPC。
 *
 * 为什么壳要单独读:桌面端一共三个进程,daemon 的 `diagnostics.memory` 只看得见
 * daemon 自己。普通用户问的「这软件吃不吃内存」,答案大头其实在壳和 WebView2 上。
 * 壳侧复用 `qaqh-memwatch` 的 `global().snapshot()`(读的是调用方进程),所以 DTO
 * 与 daemon 完全同形,前端一张表能拼两行——见 `commands.rs::host_memory`。
 *
 * 一条诚实边界:WebView2 的 renderer/GPU 子进程**没有**被算进来(COM 侧要
 * `ICoreWebView2ProcessInfo2::MemoryUsage`,本仓 lock 里的 webview2-com-sys 0.39.1
 * 还没有那个接口)。所以合计一律标成「已覆盖部分」,别让人当成交换机占用。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./transport";
import type { ProcessMemory } from "./memwatch";

/** 渲染层自报的数字;`performance.memory` 只有 Chromium(WebView2)有。 */
export interface RendererMemory {
  usedJsHeapBytes: number | null;
  totalJsHeapBytes: number | null;
  jsHeapLimitBytes: number | null;
  /** 主文档元素节点数(不含 Shadow DOM 内部与跨域 iframe)。 */
  domNodes: number;
  childFrames: number;
}

export interface MachineProcessRow {
  id: "shell" | "daemon";
  label: string;
  resident: number | null;
  private: number | null;
  peak: number | null;
  source: string;
}

export interface MachineMemoryView {
  rows: MachineProcessRow[];
  /** 界面进程组按角色聚合;Windows 上有数,其他平台是空 + excluded 里说明。 */
  group: GroupRow[];
  renderer: RendererMemory | null;
  /** 已覆盖部分之和;一个数都没有时为 null(而不是冒充 0 B)。 */
  totalBytes: number | null;
  /** 没算进合计的部分,UI 要跟着说清口径。 */
  excluded: string[];
}

/** `procgroup.rs::GroupMember` 的镜像(serde 字段是 snake_case)。 */
export interface ProcessGroupMember {
  pid: number;
  kind: string;
  resident_bytes: number | null;
  private_bytes: number | null;
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
  resident: number | null;
  private: number | null;
  /** 这个角色里读不到字节量的进程数(权限/沙箱),不能悄悄少加。 */
  failed: number;
}

/** 角色标签来自引擎自己认领的 Kind,不是我们按进程名猜的。 */
const KIND_LABEL: Record<string, string> = {
  browser: "browser(引擎主进程)",
  renderer: "renderer(页面)",
  gpu: "gpu",
  utility: "utility",
  network: "network(网络进程)",
  sandbox_helper: "sandbox_helper",
  ppapi_plugin: "ppapi_plugin",
  ppapi_broker: "ppapi_broker",
  other: "other(其他子进程)",
  unknown: "unknown",
};

/** 壳未提供该命令(旧壳 / 非 Tauri)时返回 null。 */
export const loadProcessGroup = (): Promise<ProcessGroup | null> =>
  isTauriRuntime() ? invoke<ProcessGroup | null>("host_process_group") : Promise.resolve(null);

/** 按角色聚合;保持首次出现的顺序,免得每秒重排一次表格。 */
export function groupRowsByKind(group: ProcessGroup | null): GroupRow[] {
  if (group == null) return [];
  const byKind = new Map<string, GroupRow>();
  for (const member of group.members) {
    const row = byKind.get(member.kind) ?? {
      kind: member.kind,
      label: KIND_LABEL[member.kind] ?? member.kind,
      count: 0,
      resident: null,
      private: null,
      failed: 0,
    };
    row.count += 1;
    // 「读不到」只看 resident:mac 那一档根本没有 private 口径(见 procgroup.rs),
    // 拿它参与判定会把每个 mac 成员都标成失败。
    if (member.resident_bytes == null) row.failed += 1;
    if (member.resident_bytes != null) row.resident = (row.resident ?? 0) + member.resident_bytes;
    if (member.private_bytes != null) row.private = (row.private ?? 0) + member.private_bytes;
    byKind.set(member.kind, row);
  }
  return [...byKind.values()];
}

/** 壳未提供该命令(纯浏览器 / 旧壳)时返回 null,由面板显式缺。 */
export async function loadHostMemory(): Promise<ProcessMemory | null> {
  if (!isTauriRuntime()) return null;
  const value = await invoke<ProcessMemory | null>("host_memory");
  return value == null ? null : value;
}

/** Chromium 的非标准面;TS 的 DOM lib 里没有,所以按 unknown 收窄而不写断言。 */
interface MemoryInfoLike {
  usedJSHeapSize?: unknown;
  totalJSHeapSize?: unknown;
  jsHeapSizeLimit?: unknown;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** 上限报 0 是 Chromium 在非隔离环境下「不给」的写法,不是真的 0 字节上限。 */
const positiveOrNull = (value: unknown): number | null => {
  const parsed = finiteOrNull(value);
  return parsed == null || parsed === 0 ? null : parsed;
};

/**
 * 纯函数:把「带 memory 的对象 + 已经数好的节点/框架数」折算成 RendererMemory。
 * 传进来的是替身,所以单测能覆盖 WKWebView(没有 memory)和上限为 0 的降级态。
 */
export function readRendererMemory(
  perf: { memory?: MemoryInfoLike },
  domNodes: number,
  childFrames: number,
): RendererMemory {
  const info = perf.memory ?? {};
  return {
    usedJsHeapBytes: finiteOrNull(info.usedJSHeapSize),
    totalJsHeapBytes: finiteOrNull(info.totalJSHeapSize),
    // 非隔离环境下 Chromium 会把上限报成 0——那不是「上限是 0」,是没给。
    jsHeapLimitBytes: positiveOrNull(info.jsHeapSizeLimit),
    domNodes,
    childFrames,
  };
}

/** 读实时 DOM 规模。`getElementsByTagName("*")` 只走主文档,Shadow DOM 不在内。 */
export function captureRendererMemory(): RendererMemory {
  if (typeof document === "undefined" || typeof performance === "undefined") {
    return readRendererMemory({}, 0, 0);
  }
  const frames = window?.frames?.length ?? 0;
  return readRendererMemory(
    performance as Performance & { memory?: MemoryInfoLike },
    document.getElementsByTagName("*").length,
    frames,
  );
}

const rowOf = (id: MachineProcessRow["id"], label: string, process: ProcessMemory | null): MachineProcessRow | null => {
  if (process == null) return null;
  return {
    id,
    label,
    resident: process.resident_bytes,
    private: process.private_bytes,
    peak: process.peak_resident_bytes,
    source: process.source,
  };
};

/**
 * 合计口径:壳 resident + daemon resident + 界面进程组 resident + 页面已用 JS 堆。
 *
 * 三者不是同一种量(前两个是工作集,第三个是堆内已用),相加只为给一个可比的
 * 数量级——所以**读不到的那一块也要进 `excluded`**,让 UI 把话说全,而不是悄悄少加
 * 一个数还照样显示合计。
 *
 * 界面进程组与壳/daemon 不会重复计数:那是 WebView2 引擎自己起的子进程
 * (browser/renderer/gpu),既不是壳也不是 sidecar。
 */
export function summarizeMachineMemory(
  host: ProcessMemory | null,
  daemon: ProcessMemory | null,
  renderer: RendererMemory | null,
  group: ProcessGroup | null,
): MachineMemoryView {
  const rows: MachineProcessRow[] = [];
  const excluded: string[] = [];
  for (const [id, label, process] of [["shell", "壳进程", host], ["daemon", "daemon 进程", daemon]] as const) {
    const entry = rowOf(id, label, process);
    if (entry == null) excluded.push(`${label}(未读到)`);
    else rows.push(entry);
  }
  const parts: number[] = [];
  for (const entry of rows) {
    if (entry.resident != null) parts.push(entry.resident);
    else excluded.push(`${entry.label} 的 resident 缺测`);
  }
  const groupRows = groupRowsByKind(group);
  for (const entry of groupRows) {
    if (entry.resident != null) parts.push(entry.resident);
    if (entry.failed > 0) excluded.push(`${entry.label} 有 ${entry.failed} 个进程读不到`);
  }
  if (group == null) excluded.push("界面进程组(壳未提供)");
  else if (group.source === "unsupported") excluded.push(`界面进程组(${group.error ?? "本平台未实现"})`);
  // 空列表和「不支持」是两件事:mac 上如果 WKWebView 的 helper 不是我们的直接子进程,
  // 枚举会成功但一条都没有——不写出来的话,合计看起来就像「界面组本来就是 0」。
  else if (group.members.length === 0) excluded.push("界面进程组(枚举到 0 个子进程)");
  if (renderer?.usedJsHeapBytes != null) parts.push(renderer.usedJsHeapBytes);
  else excluded.push("页面 JS 堆");
  return {
    rows,
    group: groupRows,
    renderer,
    totalBytes: parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null,
    excluded,
  };
}
