/**
 * 压缩展示态机单测。样本抄自后端 golden 线(`crates/qaqh-runtime/src/ringing/v2.rs`
 * 的 `publish_compact_*` 用例)与 `crates/qaqh-session/src/session_fact_v2/projection_event.rs`
 * 的三个变体定义——字段名与语义错位在这里就该红。
 *
 * 最要紧的一条:`compact_progress.delta` 是**累积全文快照**(桥按 256 字符合并),
 * 不是增量分片。按分片拼加会让摘要按帧长重复堆叠。
 */
import { describe, expect, test } from "vitest";
import { compactedAnchor, reduceCompact, type CompactState } from "../src/session/compact";
import type { Slot, Turn } from "../src/session/types";

const run = (state: CompactState, action: Parameters<typeof reduceCompact>[1], body: Record<string, unknown>) =>
  reduceCompact(state, action, body, 1000);

describe("reduceCompact:累积快照必须整段替换", () => {
  test("第二帧覆盖第一帧,而不是拼在后面", () => {
    const started = run({ phase: "idle" }, "compact_started", { compact_id: "c1", turns_total: 12, turns_keeping: 3 });
    expect(started).toEqual({ phase: "running", compactId: "c1", turnsTotal: 12, turnsKeeping: 3, summary: "" });

    // 线上每帧都是"到目前为止的全文",所以第二帧本身就含第一帧的内容。
    const first = run(started, "compact_progress", { compact_id: "c1", delta: "第一段" });
    const second = run(first, "compact_progress", { compact_id: "c1", delta: "第一段第二段" });
    expect(second).toEqual({ phase: "running", compactId: "c1", turnsTotal: 12, turnsKeeping: 3, summary: "第一段第二段" });
  });

  test("进行中重连只重放最新一帧(started 缺失),turns_* 保持未知而不是编造", () => {
    const resumed = run({ phase: "idle" }, "compact_progress", { compact_id: "c9", delta: "已流出的摘要" });
    expect(resumed).toEqual({ phase: "running", compactId: "c9", turnsTotal: null, turnsKeeping: null, summary: "已流出的摘要" });

    // 同一 id 的后续帧继续沿用(不能把 turns_* 抹掉两次)。
    const next = run(resumed, "compact_progress", { compact_id: "c9", delta: "已流出的摘要续" });
    expect(next).toMatchObject({ compactId: "c9", summary: "已流出的摘要续" });
  });

  test("换了另一次压缩才重建 running", () => {
    const running: CompactState = { phase: "running", compactId: "c1", turnsTotal: 12, turnsKeeping: 3, summary: "旧" };
    const switched = run(running, "compact_progress", { compact_id: "c2", delta: "新" });
    expect(switched).toEqual({ phase: "running", compactId: "c2", turnsTotal: null, turnsKeeping: null, summary: "新" });
  });

  test("字段缺失/类型漂移不变成 NaN", () => {
    expect(run({ phase: "idle" }, "compact_started", {})).toEqual({
      phase: "running", compactId: null, turnsTotal: null, turnsKeeping: null, summary: "",
    });
    expect(run({ phase: "idle" }, "compact_progress", { delta: 42 })).toMatchObject({ summary: "" });
  });
});

describe("reduceCompact:终态词表", () => {
  test("completed 带计数进 done", () => {
    expect(run({ phase: "idle" }, "compact_finished", {
      compact_id: "c1", status: "completed", summary_chars: 812, turns_compacted: 9, turns_removed: 6,
    })).toEqual({ phase: "done", completedAt: 1000, summaryChars: 812, turnsRemoved: 6 });
  });

  test("failed / skipped / cancelled 都不算「已压缩」", () => {
    expect(run({ phase: "idle" }, "compact_finished", { status: "failed" })).toEqual({ phase: "failed", reason: null });
    expect(run({ phase: "idle" }, "compact_finished", { status: "skipped" })).toEqual({ phase: "skipped", status: "skipped", reason: null });
    expect(run({ phase: "idle" }, "compact_finished", { status: "cancelled" })).toEqual({ phase: "skipped", status: "cancelled", reason: null });
  });

  test("skipped 的计数缺省时仍收敛(线上这些字段是 Option)", () => {
    expect(run({ phase: "idle" }, "compact_finished", { status: "skipped" })).toMatchObject({ phase: "skipped" });
  });
});

describe("reduceCompact:终态原因(线上加法字段 `reason`)", () => {
  test("failed 带出后端的中文原因", () => {
    expect(run({ phase: "idle" }, "compact_finished", {
      status: "failed", reason: "HTTP 429: rate limited",
    })).toEqual({ phase: "failed", reason: "HTTP 429: rate limited" });
  });

  test("skipped / cancelled 也带原因:每种「没压缩」都要能区分", () => {
    expect(run({ phase: "idle" }, "compact_finished", {
      status: "skipped", reason: "没有可压缩的历史：当前上下文里还没有任何消息。",
    })).toEqual({
      phase: "skipped", status: "skipped", reason: "没有可压缩的历史：当前上下文里还没有任何消息。",
    });
    expect(run({ phase: "idle" }, "compact_finished", {
      status: "cancelled",
      reason: "压缩期间上下文已更新（revision 3 → 4），为避免覆盖新内容已丢弃本次摘要；请重新发起压缩。",
    })).toMatchObject({ phase: "skipped", status: "cancelled", reason: expect.stringContaining("上下文已更新") });
  });

  test("旧 daemon 缺字段 / 空串 / 空白 / 非字符串都收敛成 null,不渲染空原因行", () => {
    const asFailed = (reason: unknown) => run({ phase: "idle" }, "compact_finished", { status: "failed", reason });
    expect(asFailed(undefined)).toEqual({ phase: "failed", reason: null });
    expect(asFailed("")).toEqual({ phase: "failed", reason: null });
    expect(asFailed("   ")).toEqual({ phase: "failed", reason: null });
    expect(asFailed(42)).toEqual({ phase: "failed", reason: null });
    expect(run({ phase: "idle" }, "compact_finished", { status: "skipped", reason: null }))
      .toEqual({ phase: "skipped", status: "skipped", reason: null });
  });

  test("成功终态不带原因(线上成功为 None),reason 不挤进 done", () => {
    expect(run({ phase: "idle" }, "compact_finished", {
      status: "completed", summary_chars: 812, turns_removed: 6, reason: null,
    })).toEqual({ phase: "done", completedAt: 1000, summaryChars: 812, turnsRemoved: 6 });
  });

  test("重新发起压缩时旧原因不残留", () => {
    const failed: CompactState = { phase: "failed", reason: "上一次的错误" };
    expect(run(failed, "compact_started", { compact_id: "c2", turns_total: 8, turns_keeping: 2 })).toEqual({
      phase: "running", compactId: "c2", turnsTotal: 8, turnsKeeping: 2, summary: "",
    });
  });
});

describe("reduceCompact:落盘事实收口", () => {
  test("running → done,避免卡片永远停在「正在压缩」", () => {
    const running: CompactState = { phase: "running", compactId: null, turnsTotal: null, turnsKeeping: null, summary: "半截" };
    expect(run(running, "compacted", {})).toEqual({ phase: "done", completedAt: 1000, summaryChars: null, turnsRemoved: null });
  });

  test("事实先到时保留已落定终态(次序无关收敛)", () => {
    const done: CompactState = { phase: "done", completedAt: 1, summaryChars: 9, turnsRemoved: 2 };
    expect(run(done, "compacted", {})).toBe(done);
    const skipped: CompactState = { phase: "skipped", status: "skipped", reason: null };
    expect(run(skipped, "compacted", {})).toBe(skipped);
  });
});

describe("compactedAnchor:「此前已压缩」分隔线锚在压缩时点前最后一个已收口槽位", () => {
  const turn = (key: string, status: Turn["status"] = "done"): Turn => ({
    id: key, key, turnIndex: null, user: { text: "" }, steps: [], answer: null,
    answerStepId: null, status, expanded: false,
  });
  const turnSlot = (key: string): Slot => ({ kind: "turn", key });
  const gapSlot = (key = "gap:g1"): Slot => ({ kind: "gap", key, spans: [] });
  const table = (...turns: Turn[]): Record<string, Turn> => {
    const out: Record<string, Turn> = {};
    for (const item of turns) out[item.key] = item;
    return out;
  };

  test("压缩发生在新回合开跑后:跳过运行中的回合,锚到它前面的已封回合", () => {
    const slots = [turnSlot("t1"), turnSlot("t2"), turnSlot("t3")];
    expect(compactedAnchor(slots, table(turn("t1"), turn("t2"), turn("t3", "running")))).toBe("t2");
  });

  test("压缩发生在回合间隙:最后一个已封回合就是锚点", () => {
    const slots = [turnSlot("t1"), turnSlot("t2")];
    expect(compactedAnchor(slots, table(turn("t1"), turn("t2")))).toBe("t2");
  });

  test("占位段是合法锚点:淘汰掉的旧回合全部早于压缩时点,分隔线画在它下方", () => {
    const slots = [gapSlot(), turnSlot("t3")];
    expect(compactedAnchor(slots, table(turn("t3", "running")))).toBe("gap:g1");
  });

  test("只有运行中回合 / 空表 → null(不渲染)", () => {
    expect(compactedAnchor([turnSlot("t1")], table(turn("t1", "running")))).toBeNull();
    expect(compactedAnchor([], {})).toBeNull();
  });
});
