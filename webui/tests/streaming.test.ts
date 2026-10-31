import { afterEach, expect, test, vi } from "vitest";
import { turnSegments, workSegmentEnd } from "../src/turn/segments";
import { splitBlocks } from "../src/markdown/split";
import { emptySession, applyConversationDelta } from "../src/session/reducer";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("work clock follows the slowest completion, never the last listed tool", () => {
  const steps: any[] = [
    { id: "slow", kind: "tool", status: "running", startedAt: 100 },
    { id: "fast", kind: "tool", status: "success", startedAt: 100, endedAt: 200 },
  ];
  const group = { key: "g", kind: "work" as const, steps, closed: false };
  expect(workSegmentEnd(group)).toBeUndefined();
  steps[0].status = "success";
  steps[0].endedAt = 900;
  expect(workSegmentEnd(group)).toBe(900);
});

test("new work leaves older work closed with stable segment keys", () => {
  const steps: any[] = [{ id: "tool1", kind: "tool" }, { id: "chat", kind: "text", text: "hi" }];
  const before = turnSegments(steps, false);
  steps.push({ id: "tool2", kind: "tool" });
  const after = turnSegments(steps, false);
  expect(after[0]).toMatchObject({ key: before[0]!.key, closed: true });
  expect(after[1]!.key).toBe(before[1]!.key);
  expect(after[2]).toMatchObject({ closed: false });
});

test("shorter fence inside longer fence remains code", () => {
  const blocks = splitBlocks("````js\n```\nconst x = 1;\n````\nend");
  expect(blocks[0]!.content).toBe("````js\n```\nconst x = 1;\n````");
});

test("single stream turn segments: tool followed by answer", () => {
  const state = emptySession();
  applyConversationDelta(state, {
    kind: "turn_started",
    data: { revision: 1, turn_id: "t1", input_id: "in1", mode: "normal" },
  });
  applyConversationDelta(state, {
    kind: "tool_call_declared",
    data: { revision: 2, turn_id: "t1", call_id: "call1", tool_name: "read", args: { kind: "inline", data: { text: "{}" } }, args_hash: "h" },
  });
  applyConversationDelta(state, {
    kind: "assistant_block_sealed",
    data: { revision: 3, turn_id: "t1", block_id: "ans1", block_kind: "answer", content: { kind: "inline", data: { text: "done" } }, model: "m", usage: null },
  });

  const turn = state.turns.t1!;
  expect(turn.steps).toHaveLength(2);
  const segments = turnSegments(turn.steps, false);
  expect(segments.length).toBeGreaterThan(0);
});
