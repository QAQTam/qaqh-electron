/**
 * 内存探测客户端 —— daemon `diagnostics.memory.*` 的读面(宿主白名单见
 * `src-tauri/src/commands.rs:SERVICE_METHODS`)。
 *
 * 三条来自后端的硬约束在类型上有直接体现:
 *  - 采集是 **opt-in**:`start` 之前不采样,`snapshot` 只读环形缓冲
 *    (`service.rs:383`)。所以调用方必须成对 start/stop,否则探测常驻。
 *  - 字节量全是 `Option<u64>`(`memwatch/lib.rs:78-89`):Windows 有 private_bytes,
 *    别的平台可能没有——`null` 不能渲染成 0。
 *  - `phases` 是 4096 条的有界环(`lib.rs` MAX_PHASE_*),`phase_gap`/
 *    `dropped_phase_samples` 非零时历史不连续,UI 不得装作连续。
 * 方法名与字段名以 daemon 的 serde 输出为准(snake_case),改一边另一边会红。
 */
import { transport } from "./transport";

export type ProcessMemory = {
  resident_bytes: number | null;
  private_bytes: number | null;
  virtual_bytes: number | null;
  peak_resident_bytes: number | null;
  /** 数据来源(如 `windows:GetProcessMemoryInfo` / `procfs`),没有就是 `unavailable`。 */
  source: string;
  error: string | null;
};

export type ComponentGroup = "other" | "ringing" | "agent_registry" | "service" | "transport" | "workspace";

export type PhaseKind =
  | "other"
  | "session_resume"
  | "context_build"
  | "token_preflight"
  | "provider_request"
  | "compact"
  | "request_log";

export type ComponentMemory = {
  name: string;
  group: ComponentGroup;
  item_count: number;
  payload_bytes: number | null;
  heap_estimate_bytes: number | null;
  updated_at_ms: number;
};

export type SessionMemory = {
  session_id: string;
  resident: boolean;
  message_count: number;
  turn_count: number;
  content_block_count: number;
  text_bytes: number;
  image_bytes: number;
  store_heap_estimate_bytes: number;
  agent_aux_heap_estimate_bytes: number;
  pending_persist_ops: number;
  context_message_count: number;
  context_payload_bytes: number;
  estimate_json_bytes: number;
  last_phase: string;
  last_phase_kind: PhaseKind;
  updated_at_ms: number;
};

export type PhaseSample = {
  sequence: number;
  at_ms: number;
  phase: string;
  kind: PhaseKind;
  session_id: string | null;
  process: ProcessMemory;
  store_heap_estimate_bytes: number | null;
  context_payload_bytes: number | null;
  estimate_json_bytes: number | null;
};

export type MemorySnapshot = {
  schema_version: number;
  enabled: boolean;
  started_at_ms: number;
  sampled_at_ms: number;
  process: ProcessMemory;
  peak_sampled_private_bytes: number | null;
  peak_sampled_resident_bytes: number | null;
  tracked_session_count: number;
  resident_session_count: number;
  dropped_session_gauges: number;
  dropped_phase_samples: number;
  oldest_phase_sequence: number | null;
  latest_phase_sequence: number | null;
  phase_gap: boolean;
  components: ComponentMemory[];
  sessions: SessionMemory[];
  phases: PhaseSample[];
};

/** 与 daemon 推送 ticker 同调(`axum_impl/v2.rs:76` MEMORY_PUSH_INTERVAL)。 */
export const MEMORY_POLL_MS = 1000;

/** 前端保留的 phase 行数:够画趋势条,又不至于无界增长。 */
export const PHASE_KEEP = 240;

export type MemoryStartResult = { enabled: boolean; started_at_ms: number };

export const startMemoryProbe = (): Promise<MemoryStartResult> =>
  transport.rpc<MemoryStartResult>("diagnostics.memory.start", {});

export const stopMemoryProbe = (): Promise<{ enabled: boolean }> =>
  transport.rpc<{ enabled: boolean }>("diagnostics.memory.stop", {});

/** `afterSequence` = 上次拿到的 `latest_phase_sequence`;null = 全量有界环。 */
export const loadMemorySnapshot = (afterSequence: number | null): Promise<MemorySnapshot> =>
  transport.rpc<MemorySnapshot>("diagnostics.memory.snapshot", {
    after_sequence: afterSequence,
  });

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 权限不足判定:daemon 对这三个方法要求 Admin scope
 * (`service_methods.rs:126-128` → `service_api.rs:27`),本地 sidecar 走 admin
 * token 天然满足,连远程 daemon 的设备令牌则按 scope 拒绝。
 */
export const isScopeError = (cause: unknown): boolean =>
  messageOf(cause).includes("insufficient_scope") || /\b403\b/.test(messageOf(cause));

export const errorTextOf = messageOf;

/** 二进制单位;`null`/`undefined` 一律显式缺,不冒充 0。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 会话估算合计:与 daemon 排序用的同一组字段(`lib.rs` snapshot_since 的 sort)。 */
export const sessionEstimateBytes = (row: SessionMemory): number =>
  row.store_heap_estimate_bytes + row.agent_aux_heap_estimate_bytes + row.context_payload_bytes;

/** epoch-ms → 本地 `HH:MM:SS`(表格里的时间列,不带日期——面板本来就只看当下)。 */
export function formatClock(atMs: number | null | undefined): string {
  if (atMs == null || !Number.isFinite(atMs) || atMs <= 0) return "—";
  const date = new Date(atMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 增量合并 phase 行:游标之后的新行按 sequence 追加,重复的以新到的为准,尾部保留
 * `cap` 条。快照响应在没有新行时 `phases` 为空数组,所以这里必须保持既有顺序。
 */
export function mergePhaseSamples(
  existing: readonly PhaseSample[],
  incoming: readonly PhaseSample[],
  cap: number = PHASE_KEEP,
): PhaseSample[] {
  if (incoming.length === 0) return existing.slice();
  const bySequence = new Map<number, PhaseSample>();
  for (const row of existing) bySequence.set(row.sequence, row);
  for (const row of incoming) bySequence.set(row.sequence, row);
  const merged = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
