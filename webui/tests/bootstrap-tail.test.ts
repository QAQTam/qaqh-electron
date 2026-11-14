/** 尾窗 bootstrap(`timeline_from_ord`)与 loadOlder 回填的 reducer 语义。 */
import { describe, expect, test } from "vitest";
import { applySessionBootstrap, emptySession, refillGapSpans, sessionTurnFromSnapshot } from "../src/session/reducer";
import { inline, sessionBootstrap } from "./session-fixtures";
import type { SessionTurnSnapshot } from "../src/api/qaqh/SessionTurnSnapshot";
import type { ToolCallView } from "../src/api/qaqh/ToolCallView";

const turnMeta = (id: string) => ({
  turn_id: id,
  input_id: `in-${id}`,
  mode: "normal",
  outcome: { kind: "finished", data: { terminal: "completed", usage: null, error: null } },
});

const inputEntry = (turnId: string, blockId: string, text: string) => ({
  kind: "input" as const,
  data: {
    block_id: blockId,
    turn_id: turnId,
    purpose: "trigger_turn",
    content: inline(text),
    attachments: [],
    actor: { kind: "user", id: "u1", display_name: "Alice" },
  },
});

const toolCallView = (callId: string, turnId: string): ToolCallView => ({
  call_id: callId,
  turn_id: turnId,
  tool_name: "read",
  args: { path: "README.md" },
  state: { kind: "finished", outcome: { kind: "completed" } },
  output: inline('{"output":"ok","exit_code":0}'),
  output_truncated: false,
  metrics: null,
});

/** 三回合会话:T1 在界外(仅元数据),T2/T3 在尾窗内。 */
function tailBootstrap(timelineFromOrd: number | null) {
  return sessionBootstrap("session-tail", {
    seq: 9,
    turns: [turnMeta("T1"), turnMeta("T2"), turnMeta("T3")],
    timeline: [inputEntry("T2", "b2", "第二问"), inputEntry("T3", "b3", "第三问")],
    tools: [
      // 界外回合的工具调用:不得经 ensureTurn 幽灵物化 T1。
      toolCallView("call-old", "T1"),
      toolCallView("call-new", "T3"),
    ],
    timelineFromOrd,
  });
}

describe("applySessionBootstrap tail window", () => {
  test("full bootstrap materializes every turn with no gaps", () => {
    const state = emptySession();
    applySessionBootstrap(state, tailBootstrap(null));
    expect(Object.keys(state.turns).sort()).toEqual(["T1", "T2", "T3"]);
    expect(state.slots.every((slot) => slot.kind === "turn")).toBe(true);
    expect(state.hasMore).toBe(false);
    expect(state.truncatedBefore).toBe(false);
    // 界外守卫只在尾窗生效:全量快照照旧物化工具步骤。
    expect(state.turns["T1"]!.steps.some((step) => step.kind === "tool" && step.id === "call-old")).toBe(true);
  });

  test("tail bootstrap turns pre-window turns into gap placeholders and blocks ghost tools", () => {
    const state = emptySession();
    applySessionBootstrap(state, tailBootstrap(3));
    expect(state.turns["T1"]).toBeUndefined();
    expect(state.turns["T2"]).toBeDefined();
    expect(state.turns["T3"]).toBeDefined();
    expect(state.slots).toEqual([
      { kind: "gap", key: "gap:T1", spans: [{ key: "T1", height: 0 }] },
      { kind: "turn", key: "T2" },
      { kind: "turn", key: "T3" },
    ]);
    expect(state.hasMore).toBe(true);
    expect(state.truncatedBefore).toBe(true);
    // 界外工具不建幽灵回合,窗内工具照常落地。
    expect(state.turns["T2"]!.steps.some((step) => step.kind === "tool" && step.id === "call-old")).toBe(false);
    expect(state.turns["T3"]!.steps.some((step) => step.kind === "tool" && step.id === "call-new")).toBe(true);
  });
});

describe("refillGapSpans", () => {
  const snapshotFor = (turnId: string, text: string, toolName?: string): SessionTurnSnapshot => ({
    turn: turnMeta(turnId),
    timeline: [
      inputEntry(turnId, `b-${turnId}`, text),
      ...(toolName == null
        ? []
        : [{ kind: "tool_call" as const, data: { turn_id: turnId, call_id: `call-${turnId}` } }]),
    ],
    tools: toolName == null ? [] : [{ ...toolCallView(`call-${turnId}`, turnId), tool_name: toolName }],
  });

  test("fills the fetched span, records originTurns, and clears hasMore when the gap drains", () => {
    const state = emptySession();
    applySessionBootstrap(state, tailBootstrap(3));
    const snapshot = snapshotFor("T1", "第一问");
    refillGapSpans(state, "gap:T1", [{ turnId: "T1", snapshot }]);
    expect(state.slots).toEqual([
      { kind: "turn", key: "T1" },
      { kind: "turn", key: "T2" },
      { kind: "turn", key: "T3" },
    ]);
    expect(state.turns["T1"]!.user.text).toBe("第一问");
    expect(state.originTurns["T1"]).toBe(snapshot);
    expect(state.hasMore).toBe(false);
  });

  test("keeps unfetched keys as a merged gap and preserves ordering", () => {
    const state = emptySession();
    applySessionBootstrap(state, tailBootstrap(3));
    // 模拟一次只取到段尾一个键:剩余键留在占位里(下次手势再试)。
    refillGapSpans(state, "gap:T1", [{ turnId: "T1", snapshot: snapshotFor("T1", "第一问") }]);
    // 追加一次淘汰形成的相邻 gap(人工构造):refill 后不得出现两段相邻占位。
    state.slots.unshift({ kind: "gap", key: "gap:T0", spans: [{ key: "T0", height: 40 }] });
    refillGapSpans(state, "gap:T0", [{ turnId: "T0", snapshot: snapshotFor("T0", "第零问") }]);
    expect(state.slots.map((slot) => slot.kind)).toEqual(["turn", "turn", "turn", "turn"]);
    expect(state.turns["T0"]!.user.text).toBe("第零问");
  });

  test("partial fetch keeps the remainder refetchable and hasMore stays true", () => {
    const state = emptySession();
    applySessionBootstrap(state, tailBootstrap(3));
    // 只回填段内一个不存在的键:占位整段保留。
    refillGapSpans(state, "gap:T1", []);
    expect(state.slots).toEqual([
      { kind: "gap", key: "gap:T1", spans: [{ key: "T1", height: 0 }] },
      { kind: "turn", key: "T2" },
      { kind: "turn", key: "T3" },
    ]);
    expect(state.hasMore).toBe(true);
  });

  test("sessionTurnFromSnapshot keeps expanded content rebuildable from the wire shape", () => {
    const turn = sessionTurnFromSnapshot(snapshotFor("T9", "重建正文", "handoff"));
    expect(turn.user.text).toBe("重建正文");
    expect(turn.steps.some((step) => step.kind === "tool" && step.name === "handoff")).toBe(true);
  });
});
