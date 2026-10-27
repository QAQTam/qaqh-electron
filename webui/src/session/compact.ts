/**
 * 压缩展示态的状态迁移(纯函数:线字段解析 + 状态机,便于用线上样本锁住契约)。
 *
 * 线形状来自 `ConversationDelta` 的三个瞬态变体,由
 * `crates/qaqh-runtime/src/ringing/compact_mirror.rs` 从 v1 Ringing 的
 * CompactStarted/Progress/Finished 镜像进 conversation 频道(该广播面已删,这是
 * 过程数据的唯一出口);另有 durable 事实 `CompactionApplied`。
 *
 * 唯一容易搞错的一点:`CompactProgress.delta` 是**累积全文快照**——桥把 provider
 * 分片按 256 字符合并后发整段,不是增量分片。所以这里整段替换;拼加会让文本按
 * 帧长堆叠,而丢帧不需要补偿(下一帧自带全文)。
 *
 * 第二个坑:`CompactFinished.reason` 是**加法字段**(`Option<String>`,成功时为
 * `None`,失败/跳过/取消时是面向用户的中文整句)。旧 daemon 不带这个字段,所以
 * 缺省必须收敛成 `null`——不能拿 `status` 反推,也不能把空串当原因渲染。
 */
import type { Slot, Turn } from "./types";

export type CompactState =
  | { phase: "idle" }
  | { phase: "running"; compactId: string | null; turnsTotal: number | null; turnsKeeping: number | null; summary: string }
  | { phase: "done"; completedAt: number; summaryChars: number | null; turnsRemoved: number | null }
  /**
   * 终态但没压缩:`skipped` = 没有可压缩的内容,`cancelled` = 回合被取消。
   * `reason` 是后端给出的具体中文说明(如"没有可压缩的历史:…"),旧 daemon 为 null。
   */
  | { phase: "skipped"; status: "skipped" | "cancelled"; reason: string | null }
  /** 压缩失败;`reason` 是后端的中文失败说明,旧 daemon 无此字段时为 null。 */
  | { phase: "failed"; reason: string | null };

/** 能驱动压缩态的四个动作:三个过程 kind + 一个落盘事实。 */
export type CompactAction = "compacted" | "compact_started" | "compact_progress" | "compact_finished";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 线上 `reason` 是可选的整句中文;空串/纯空白与非字符串一律当"没有原因"。 */
function asReason(value: unknown): string | null {
  const text = asString(value)?.trim() ?? "";
  return text === "" ? null : text;
}

export function reduceCompact(
  state: CompactState,
  action: CompactAction,
  body: Record<string, unknown>,
  at: number,
): CompactState {
  switch (action) {
    case "compacted":
      // 落盘事实是"压缩已生效"的权威信号:无论 running 是命令 ack 乐观置的、
      // 还是 started 事件置的,都在这里收口,卡片不会永远停在"正在压缩"。
      return state.phase === "running"
        ? { phase: "done", completedAt: at, summaryChars: null, turnsRemoved: null }
        : state;
    case "compact_started":
      return {
        phase: "running",
        compactId: asString(body.compact_id),
        turnsTotal: asFiniteNumber(body.turns_total),
        turnsKeeping: asFiniteNumber(body.turns_keeping),
        summary: "",
      };
    case "compact_progress": {
      const snapshot = asString(body.delta) ?? "";
      const id = asString(body.compact_id);
      // 进行中重连只重放到最新一帧(同槽可替换,没有 started),此时 turns_*
      // 拿不到:保留原有值,只有换了另一次压缩才重建。
      const same = state.phase === "running"
        && (state.compactId == null || id == null || state.compactId === id);
      if (!same) {
        return { phase: "running", compactId: id, turnsTotal: null, turnsKeeping: null, summary: snapshot };
      }
      return { ...state, compactId: state.compactId ?? id, summary: snapshot };
    }
    case "compact_finished": {
      const status = asString(body.status) ?? "";
      const reason = asReason(body.reason);
      if (status === "failed") return { phase: "failed", reason };
      if (status === "skipped" || status === "cancelled") return { phase: "skipped", status, reason };
      return {
        phase: "done",
        completedAt: at,
        summaryChars: asFiniteNumber(body.summary_chars),
        turnsRemoved: asFiniteNumber(body.turns_removed),
      };
    }
  }
}

/**
 * 「此前已压缩」分隔线的锚点:压缩时点上最后一个**已收口**的槽位。
 *
 * 自动压缩常发生在新回合已经开跑之后(阈值检查在构建上下文时),且
 * conversation 投影与 timeline 流之间没有跨流顺序保证——若锚到那个运行中的
 * 回合,分隔线画在它的槽位末尾,它此后的全部输出连同之后的新消息都落在
 * 分隔线上方,时间线在视觉上被倒置。所以运行中的回合一律跳过;占位段
 * (已淘汰的旧回合,全部早于压缩时点)是合法锚点。空表返回 null(不渲染)。
 */
export function compactedAnchor(slots: readonly Slot[], turns: Readonly<Record<string, Turn>>): string | null {
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index]!;
    if (slot.kind === "turn" && turns[slot.key]?.status === "running") continue;
    return slot.key;
  }
  return null;
}
