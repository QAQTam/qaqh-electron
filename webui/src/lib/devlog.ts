/**
 * 开发者控制台的采集缓冲:webview 实际收发的宿主事件与 RPC 调用。
 *
 * 只在开发者模式开着时记录——`note*` 首行就 early-return,关闭态零开销、零行为
 * 差异(埋点绝不能改变被观测的东西:传输层的返回值与错误传播路径保持原样)。
 * 有界环形缓冲,不落盘,和 `devmode.ts` 同一个理由。
 */
import { createSignal } from "solid-js";
import { devMode } from "./devmode";

export type DevLogKind = "rpc" | "event" | "error";

export interface DevLogEntry {
  id: number;
  at: number;
  kind: DevLogKind;
  /** 事件名或 RPC 方法名。 */
  tag: string;
  detail: string;
  /** RPC 往返耗时;事件类为 null。 */
  ms: number | null;
  failed: boolean;
}

/** 保留条数:1s 心跳下约够用几分钟,再多就不是一屏能看完的东西。 */
const CAP = 400;
/** 摘要文本上限:payload 可以很大,日志格不能。 */
const DETAIL_MAX = 160;

const [devLogEntries, setDevLogEntries] = createSignal<DevLogEntry[]>([]);
const [devLogCount, setDevLogCount] = createSignal(0);
let nextId = 1;

function push(kind: DevLogKind, tag: string, detail: string, ms: number | null, failed: boolean): void {
  if (!devMode()) return;
  const entry: DevLogEntry = { id: nextId++, at: Date.now(), kind, tag, detail, ms, failed };
  setDevLogEntries((rows) => (rows.length >= CAP ? [...rows.slice(rows.length - CAP + 1), entry] : [...rows, entry]));
  setDevLogCount((n) => n + 1);
}

/** 传输层 `rpc()` 的唯一埋点:成功/失败都要记,失败原样再抛。 */
export function noteRpc(method: string, startedAtMs: number, cause: unknown | null): void {
  const ms = Date.now() - startedAtMs;
  push("rpc", method, cause == null ? "ok" : clip(textOf(cause)), ms, cause != null);
}

/** 宿主转发事件(timeline://*、projection://*、conn://*)。 */
export function noteEvent(name: string, payload: unknown): void {
  // 这两条本身就是故障通知,归到 error 类,日志里要一眼看见而不是混在事件流里。
  const failing = name === "conn://error" || name === "conn://incompatible";
  push(failing ? "error" : "event", name, summarize(payload), null, failing);
}

export const clearDevLog = (): void => {
  setDevLogEntries([]);
  setDevLogCount(0);
};

export { devLogEntries, devLogCount };

function textOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

/**
 * 从 payload 里挑几个有辨识度的标量字段拼摘要,而不是 `JSON.stringify` 整包:
 * timeline 一条 entry 可能带几百 KB 正文,日志要的是「哪条、什么类、到第几」。
 */
const HIGHLIGHT_KEYS = ["type", "kind", "event", "status", "index", "seq", "code", "message", "session_id"] as const;

function summarize(payload: unknown): string {
  if (payload == null || typeof payload !== "object") return clip(textOf(payload));
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of HIGHLIGHT_KEYS) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
    if (parts.length >= 4) break;
  }
  if (parts.length === 0) parts.push(`keys=${Object.keys(record).slice(0, 6).join(",")}`);
  return clip(parts.join(" "));
}
