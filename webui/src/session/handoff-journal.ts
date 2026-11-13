/**
 * 交接账本(本地)——ADR-016 后只剩**只读遗留**。
 *
 * 内核 fork(ADR-016 切片 1)接管了建后继、投文档与幂等:
 * - 「同一条交接只 fork 一次」的权威闸是内核 `handoff_chain_head == root`
 *   (`qaqh-session` store 层幂等),前端不再记账;
 * - 血缘的权威是读模型 `SessionListEntry.handoff_from_session_id`(切片 2 导出),
 *   侧栏/标题栏徽标先读它;
 * - 开箱卡判据走权威两源(HandoffSealed 事件 + 血缘字段),投递指纹
 *   (`deliveredDocMatch`)已随前端 fork 一起退役。
 *
 * 本文件保留的唯一职责:升级前写入 localStorage 的旧 fork 记录
 * (`qaqh.handoff.fork.*`)的兼容读取——旧数据没有后端血缘字段,徽标靠它兜底;
 * 没有任何写入口,记录集在模块求值时定型。
 *
 * 账本里**不存交接文档正文**(旧设计纪律,不变):权威副本在 A 会话的
 * `tool_calls.args_json` 与 timeline 的 tool_result 里,bootstrap 读得到。
 */
const FORK_PREFIX = "qaqh.handoff.fork.";

/** 落盘形状是 snake_case(与本仓其它持久化字段一致),读时按未知结构逐字段收。 */
type StoredForkRecord = {
  from_session_id?: unknown;
  turn_id?: unknown;
  child_session_id?: unknown;
  work_summary?: unknown;
  at_ms?: unknown;
};

/** 升级前旧账本条目的最小投影(只保留徽标要读的字段)。 */
type LegacyForkRecord = {
  key: string;
  fromSessionId: string;
  turnId: string;
  childSessionId: string;
  workSummary: string;
  at: number;
};

const records = new Map<string, LegacyForkRecord>();

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
        workSummary: typeof parsed.work_summary === "string" ? parsed.work_summary : "",
        at: typeof parsed.at_ms === "number" ? parsed.at_ms : 0,
      });
    }
  } catch {
    // 隐私模式 / 无 storage:内存里已有的那一份照常可用。
  }
}
loadStored();

/**
 * 这条交接会话(B)是从哪个会话 fork 来的;null = 不是 fork 对话。
 * 升级前旧数据的兼容读取;新数据走目录血缘字段(`handoff_from_session_id`)。
 */
export function parentSessionOf(childSessionId: string): string | null {
  for (const record of records.values()) {
    if (record.childSessionId === childSessionId) return record.fromSessionId;
  }
  return null;
}
