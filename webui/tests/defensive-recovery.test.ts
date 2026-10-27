import { afterEach, expect, test, vi } from "vitest";
import { SessionStore, CANCEL_WATCHDOG_MS } from "../src/session/store";
import { forceSealTurn, emptySession } from "../src/session/reducer";
import { transport } from "../src/lib/transport";
import type { TimelineEntryWire } from "../src/session/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("forceSealTurn: 当未密封回合遇到终态事实时，就地收口并重算 runningTurns", () => {
  const state = emptySession();
  state.turns["t1"] = {
    id: "t1",
    key: "t1",
    turnIndex: null,
    user: { text: "hello" },
    steps: [{ kind: "text", id: "b1", seq: 1, text: "final text" }],
    answer: null,
    answerStepId: null,
    status: "running",
    workStartedAt: 100,
    expanded: false,
  };
  state.slots.push({ kind: "turn", key: "t1" });
  state.runningTurns = 1;
  state.activeTurnKey = "t1";

  // 触发防御性自愈收口
  const sealed = forceSealTurn(state, "t1", "completed");
  expect(sealed).toBe(true);
  expect(state.turns["t1"]!.status).toBe("done");
  expect(state.turns["t1"]!.answer?.text).toBe("final text");
  expect(state.runningTurns).toBe(0);
  expect(state.activeTurnKey).toBeNull();
});

test("双流对齐自愈：Timeline 流漏发 turn_sealed，但收到 V2 turn_finished 时，自动就地收口并触发 resnapshot", async () => {
  const store = new SessionStore("test-dual-stream");
  const resnapshotSpy = vi.spyOn(store, "resnapshot").mockResolvedValue();

  // 模拟 Timeline 流开启了回合并吐字，但从未发 turn_sealed
  (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({
    timeline_seq: 1,
    turn_id: "t-leak",
    event: { type: "turn_opened", user_text: "test" },
  } as TimelineEntryWire);

  (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({
    timeline_seq: 2,
    turn_id: "t-leak",
    event: { type: "block_opened", block: { block_id: "blk-1", kind: "text", state: "open" } },
  } as TimelineEntryWire);

  expect(store.state[0].runningTurns).toBe(1);
  expect(store.state[0].turns["t-leak"]?.status).toBe("running");

  // V2 投影流到达 turn_finished（事实落盘）
  (store as unknown as { applyProjection(key: unknown, payload: unknown): void }).applyProjection(
    { kind: "channel", data: "conversation" },
    {
      kind: "conversation_delta",
      data: {
        kind: "turn_finished",
        data: {
          turn_id: "t-leak",
          terminal: "completed",
        },
      },
    },
  );

  // 本地立即防御性收口，无需用户 F5
  expect(store.state[0].runningTurns).toBe(0);
  expect(store.state[0].turns["t-leak"]?.status).toBe("done");
  // 且异步触发了 resnapshot 补拉快照
  expect(resnapshotSpy).toHaveBeenCalledOnce();
});

test("cancelTurn 携带当前活跃的 turn_id", async () => {
  const store = new SessionStore("test-cancel");
  const cmdSpy = vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });

  (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({
    timeline_seq: 1,
    turn_id: "active-turn-123",
    event: { type: "turn_opened", user_text: "test" },
  } as TimelineEntryWire);

  await store.cancelTurn();

  expect(cmdSpy).toHaveBeenCalledWith(
    "conversation",
    expect.objectContaining({
      type: "conversation_cancel",
      turn_id: "active-turn-123",
    }),
    "test-cancel",
  );
});

test("取消看门狗：cancel 后超过宽限期仍无终态，就地收口 running 回合并复位发送态", async () => {
  vi.useFakeTimers();
  const store = new SessionStore("test-cancel-watchdog");
  vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });
  const resnapshotSpy = vi.spyOn(store, "resnapshot").mockResolvedValue();

  (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({
    timeline_seq: 1,
    turn_id: "t-stuck",
    event: { type: "turn_opened", user_text: "test" },
  } as TimelineEntryWire);
  (store as unknown as { isSending: ReturnType<typeof store.isSending> }).isSending[1](true);

  await store.cancelTurn();

  // 宽限期内（<10s）：不动任何状态
  await vi.advanceTimersByTimeAsync(CANCEL_WATCHDOG_MS - 1);
  expect(store.isSending[0]()).toBe(true);
  expect(store.state[0].turns["t-stuck"]?.status).toBe("running");

  // 超时：本地兜底收口
  await vi.advanceTimersByTimeAsync(1);
  expect(store.isSending[0]()).toBe(false);
  expect(store.state[0].turns["t-stuck"]?.status).toBe("aborted");
  expect(store.state[0].runningTurns).toBe(0);
  expect(resnapshotSpy).toHaveBeenCalledOnce();
});

test("取消看门狗：真实终态 delta 到达即撤防，不再重复收口", async () => {
  vi.useFakeTimers();
  const store = new SessionStore("test-cancel-watchdog-disarm");
  vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });
  const resnapshotSpy = vi.spyOn(store, "resnapshot").mockResolvedValue();

  (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({
    timeline_seq: 1,
    turn_id: "t-fast",
    event: { type: "turn_opened", user_text: "test" },
  } as TimelineEntryWire);

  await store.cancelTurn();

  // 终态 delta 在宽限期内到达
  (store as unknown as { applyProjection(key: unknown, payload: unknown): void }).applyProjection(
    { kind: "channel", data: "conversation" },
    {
      kind: "conversation_delta",
      data: { kind: "turn_interrupted", data: { turn_id: "t-fast", reason: "cancel_before_seal" } },
    },
  );

  await vi.advanceTimersByTimeAsync(CANCEL_WATCHDOG_MS * 2);
  // 终态路径收口一次即止，看门狗没有二次触发（resnapshot 也只被终态路径调一次）
  expect(store.state[0].turns["t-fast"]?.status).toBe("aborted");
  expect(resnapshotSpy).toHaveBeenCalledOnce();
});
