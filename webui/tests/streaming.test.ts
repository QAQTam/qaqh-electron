import { afterEach, expect, test, vi } from "vitest";
import { turnSegments, workSegmentEnd } from "../src/turn/segments";
import { splitBlocks } from "../src/markdown/split";
import { emptySession, applySessionEvent } from "../src/session/reducer";
import { inline } from "./session-fixtures";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("work clock follows the slowest completion, never the last listed tool", () => {
  const steps: any[] = [
    { id: "slow", kind: "tool", status: "running", startedAt: 100 },
    { id: "fast", kind: "tool", status: "finished", startedAt: 100, endedAt: 200 },
  ];
  const group = { key: "g", kind: "work" as const, steps, closed: false };
  expect(workSegmentEnd(group)).toBeUndefined();
  steps[0].status = "finished";
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
  applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "t1", input_id: "in1", mode: "normal" });
  applySessionEvent(state, { seq: 2, type: "timeline_appended", entry: {
    kind: "tool_call", data: { turn_id: "t1", call_id: "call1" },
  } });
  applySessionEvent(state, { seq: 3, type: "tool_arguments_delta", turn_id: "t1", call_id: "call1", text: "{}" });
  applySessionEvent(state, { seq: 4, type: "tool_finished", call_id: "call1", outcome: { kind: "completed" }, output: inline("ok"), output_truncated: false, metrics: null });
  applySessionEvent(state, { seq: 5, type: "timeline_appended", entry: {
    kind: "assistant_block", data: { turn_id: "t1", block_id: "ans1", block_kind: "answer", content: inline("done"), model: "m", usage: null },
  } });

  const turn = state.turns.t1!;
  expect(turn.steps).toHaveLength(2);
  const segments = turnSegments(turn.steps, false);
  expect(segments.length).toBeGreaterThan(0);
});
