/**
 * 交接账本（本地）。
 *
 * 两件事只能在前端自己落，因为契约里没有它们的位置：
 * 1. **同一条交接只允许 fork 一次**（施工单 §一·3）：判据是
 *    `from_session_id + turn_id`。后端对同回合重复调用只回一句
 *    「这一回合已经交接过了」，不会再发第二份 `handed_off:true`，所以事件面
 *    天然不会重复触发；真正会重复的是**人**——客户端关掉重开、离线后点两次
 *    「继续这条交接」。账本必须落盘，不能只在内存里去重。
 * 2. **血缘**（施工单 §六）：`session.create` 没有 `parent` 字段（加它 = 改命令
 *    判别 = 契约破坏，LTS 禁），所以 B 的 `parent_session_id` 恒为 NULL、
 *    `SessionListEntry` 也不导出它。「【此对话为 fork 交接对话】」只能由这份
 *    本地 child→parent 映射现算。v3.1 换锁时后端会补 `SessionCreate.parent_session_id`
 *    + `handed_off` 终态，届时这份账本退化成兼容旧数据的读取路径。
 *
 * 账本里**不存交接文档正文**：权威副本在 A 会话的 `tool_calls.args_json` 与
 * timeline 的 tool_result 里，bootstrap 读得到；把几十 KB 正文再抄一份进
 * localStorage 只会多一个没有版本管理的真相源。
 *
 * 结构取舍：权威是一份**普通 Map**，信号只带一个 revision 版本号给 UI 订阅。
 * 本仓的 Solid 2 rc 在 root 外写信号不会同步可见（`tests/create-session-workspace.test.ts`
 * 为这个专门 `flush()`），而 fork 的去重判定必须"写下去就立刻算数"——同一 tick
 * 里连着两条事件时，读旧值等于开出第二条会话。所以逻辑面读 Map，渲染面读版本。
 */
import { createSignal } from "solid-js";
import type { HandoffFact } from "./handoff";

const FORK_PREFIX = "qaqh.handoff.fork.";

export type HandoffForkRecord = {
  /** `${from_session_id}|${turn_id}`。 */
  key: string;
  fromSessionId: string;
  turnId: string;
  /** fork 出来的新会话 id（B）。 */
  childSessionId: string;
  /** 交接文档是否已作为 B 的第一条输入投出去（false = 建了会话但没投递）。 */
  delivered: boolean;
  workSummary: string;
  at: number;
};

/** 落盘形状是 snake_case（与本仓其它持久化字段一致），读时按未知结构逐字段收。 */
type StoredForkRecord = {
  from_session_id?: unknown;
  turn_id?: unknown;
  child_session_id?: unknown;
  delivered?: unknown;
  work_summary?: unknown;
  at_ms?: unknown;
};

/** 同步权威：写下去立刻可读，不等任何 flush。 */
const records = new Map<string, HandoffForkRecord>();
/** 仅用于让渲染面（侧栏徽标、交接卡）订阅变化。 */
const [revision, setRevision] = createSignal(0);

function loadStored(): void {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const storageKey = localStorage.key(index);
      if (storageKey == null || !storageKey.startsWith(FORK_PREFIX)) continue;
      const raw = localStorage.getItem(storageKey);
      if (raw == null) continue;
      const parsed = JSON.parse(raw) as StoredForkRecord;
      const key = storageKey.slice(FORK_PREFIX.length);
      if (typeof parsed.child_session_id !== "string" || parsed.child_session_id === "") continue;
      records.set(key, {
        key,
        fromSessionId: typeof parsed.from_session_id === "string" ? parsed.from_session_id : key.split("|")[0] ?? "",
        turnId: typeof parsed.turn_id === "string" ? parsed.turn_id : key.split("|")[1] ?? "",
        childSessionId: parsed.child_session_id,
        delivered: parsed.delivered === true,
        workSummary: typeof parsed.work_summary === "string" ? parsed.work_summary : "",
        at: typeof parsed.at_ms === "number" ? parsed.at_ms : 0,
      });
    }
  } catch {
    // 隐私模式 / 无 storage：内存里已有的那一份照常可用。
  }
}
loadStored();

function persist(record: HandoffForkRecord): void {
  try {
    localStorage.setItem(`${FORK_PREFIX}${record.key}`, JSON.stringify({
      from_session_id: record.fromSessionId,
      turn_id: record.turnId,
      child_session_id: record.childSessionId,
      delivered: record.delivered,
      work_summary: record.workSummary,
      at_ms: record.at,
    }));
  } catch {
    // 写不进存储也要让本次进程内的去重成立（Map 已经写了）。
  }
}

function store(record: HandoffForkRecord): void {
  records.set(record.key, record);
  persist(record);
  setRevision((current) => current + 1);
}

/** 渲染面订阅点：任何 fork 记账都会推这个版本号。 */
function subscribe(): void {
  revision();
}

/** 这条交接 fork 出的会话记录（null = 还没 fork）。 */
export function forkRecordOfFact(fact: Pick<HandoffFact, "key">): HandoffForkRecord | null {
  subscribe();
  return records.get(fact.key) ?? null;
}

/**
 * 记下 fork 结果。投递失败也先记 child——宁可留一条「没投出去」的事实，
 * 也不再开第二条会话。
 */
export function recordHandoffFork(
  fact: Pick<HandoffFact, "key" | "fromSessionId" | "turnId" | "workSummary">,
  childSessionId: string,
  delivered: boolean,
): HandoffForkRecord {
  const record: HandoffForkRecord = {
    key: fact.key,
    fromSessionId: fact.fromSessionId,
    turnId: fact.turnId,
    childSessionId,
    delivered,
    workSummary: fact.workSummary,
    at: Date.now(),
  };
  store(record);
  return record;
}

/** 文档投递成功（B 的第一条输入已发出）。 */
export function markHandoffDelivered(key: string): void {
  const current = records.get(key);
  if (current == null || current.delivered) return;
  store({ ...current, delivered: true });
}

/** 这条交接会话（B）是从哪个会话 fork 来的；null = 不是 fork 对话。 */
export function parentSessionOf(childSessionId: string): string | null {
  subscribe();
  for (const record of records.values()) {
    if (record.childSessionId === childSessionId) return record.fromSessionId;
  }
  return null;
}

/** 一个会话 fork 出去的子会话（A 侧的「已交接」状态与跳转目标）。 */
export function forkedChildrenOf(parentSessionId: string): HandoffForkRecord[] {
  subscribe();
  return [...records.values()]
    .filter((record) => record.fromSessionId === parentSessionId)
    .sort((left, right) => left.at - right.at);
}
