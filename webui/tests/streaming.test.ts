import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { applyEntry, buildTurn, emptySession } from "../src/session/reducer";
import { turnSegments } from "../src/turn/segments";
import { splitBlocks } from "../src/markdown/split";
import type { TimelineEntryWire } from "../src/session/types";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function harness() {
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frame = fn; return 1; });
  const store = new SessionStore("test");
  let seq = 0;
  const feed = (event: unknown) => (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({ timeline_seq: ++seq, turn_id: "t", event } as TimelineEntryWire);
  return { store, feed, frame: () => frame(0) };
}

test("3000 buffered deltas survive a same-frame seal without duplicate replay", () => {
  const { store, feed, frame } = harness();
  feed({ type: "block_opened", block: { block_id: "r", kind: "reasoning", state: "open" } });
  for (let i = 0; i < 3000; i += 1) feed({ type: "text_delta", block_id: "r", delta: "字" });
  feed({ type: "block_sealed", block_id: "r" });
  frame();
  expect(store.state[0].turns.t!.steps[0]).toMatchObject({ text: "字".repeat(3000) });
  expect(store.state[0].watermark).toBe(3002);
});

test("paused animation frames still commit buffered data within 100ms", () => {
  vi.useFakeTimers();
  const { store, feed } = harness();
  feed({ type: "block_opened", block: { block_id: "a", kind: "text", state: "open" } });
  feed({ type: "text_delta", block_id: "a", delta: "background" });
  vi.advanceTimersByTime(100);
  expect(store.state[0].turns.t!.answer?.text).toBe("background");
  store.dispose();
});

test("structural flush re-arms background fallback for the next batch", () => {
  vi.useFakeTimers();
  const { store, feed } = harness();
  feed({ type: "block_opened", block: { block_id: "a", kind: "text", state: "open" } });
  feed({ type: "text_delta", block_id: "a", delta: "first" });
  feed({ type: "block_sealed", block_id: "a" });
  feed({ type: "block_opened", block: { block_id: "b", kind: "text", state: "open" } });
  feed({ type: "text_delta", block_id: "b", delta: "second" });
  vi.advanceTimersByTime(100);
  expect(store.state[0].turns.t!.answer?.text).toBe("second");
  store.dispose();
});

test("snapshot covering part of a merged batch only drops covered fragments", () => {
  const { store, feed, frame } = harness();
  feed({ type: "block_opened", block: { block_id: "a", kind: "text", state: "open" } });
  feed({ type: "text_delta", block_id: "a", delta: "old" });
  feed({ type: "text_delta", block_id: "a", delta: "new" });
  store.state[1]((draft) => { draft.watermark = 2; (draft.turns.t!.steps[0] as any).text = "old"; });
  frame();
  expect(store.state[0].turns.t!.answer?.text).toBe("oldnew");
});

test("checkpoint overwrites preceding buffered delta, including empty checkpoints", () => {
  const { store, feed, frame } = harness();
  feed({ type: "block_opened", block: { block_id: "a", kind: "text", state: "open" } });
  feed({ type: "text_delta", block_id: "a", delta: "old" });
  feed({ type: "block_checkpoint", block_id: "a", text: "new" });
  frame();
  expect(store.state[0].turns.t!.answer?.text).toBe("new");
  feed({ type: "block_checkpoint", block_id: "a", text: "" });
  expect(store.state[0].turns.t!.answer?.text).toBe("");
});

test("tool terminal update cannot swallow progress buffered before it", () => {
  const { store, feed, frame } = harness();
  feed({ type: "block_opened", block: { block_id: "a", kind: "tool", tool: { name: "read", state: "running" } } });
  feed({ type: "tool_progress", block_id: "a", chunk: "last output" });
  feed({ type: "tool_updated", block_id: "a", tool: { name: "read", state: "succeeded" } });
  frame();
  expect(store.state[0].turns.t!.steps[0]).toMatchObject({ progressTail: "last output", status: "success" });
});

test("snapshot and live text-before-work have identical answer classification", () => {
  for (const kind of ["tool", "reasoning"]) {
    const state = emptySession();
    const blocks = [{ block_id: "a", kind: "text", state: "sealed", block_order: 0, text: "中途回复" }, { block_id: "b", kind, state: "open", block_order: 1 }];
    blocks.forEach((block, i) => applyEntry(state, { timeline_seq: i + 1, turn_id: "t", event: { type: "block_opened", block } } as TimelineEntryWire));
    const snapshot = buildTurn({ turn_id: "t", user_text: "q", state: "running", rounds: [{ round_num: 0, sealed: false, is_final: false, blocks }] } as any, 1);
    expect(snapshot.answerStepId).toBe(state.turns.t!.answerStepId);
    expect(snapshot.answer).toBeNull();
    const segments = turnSegments(state.turns.t!.steps, false);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "work"]);
  }
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
