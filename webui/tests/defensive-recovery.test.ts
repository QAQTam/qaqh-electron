import { afterEach, expect, test, vi } from "vitest";
import { SessionStore, CANCEL_WATCHDOG_MS } from "../src/session/store";
import { forceSealTurn, emptySession } from "../src/session/reducer";
import { transport } from "../src/lib/transport";

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

test("cancelTurn 默认不带 turn_id（只有「取消当前回合」保留后端入队即抢占）", async () => {
  const store = new SessionStore("test-cancel");
  const cmdSpy = vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });

  (store as any).applyProjection(
    { kind: "channel", data: "conversation" },
    {
      kind: "conversation_delta",
      data: {
        kind: "turn_started",
        data: { turn_id: "active-turn-123", input_id: "in1", mode: "normal", revision: 1 },
      },
    },
  );

  await store.cancelTurn();

  expect(cmdSpy).toHaveBeenCalledWith(
    "conversation",
    expect.objectContaining({
      type: "conversation_cancel",
      turn_id: null,
    }),
    "test-cancel",
  );
});

test("cancelTurn({ turnId }) 仍可定向取消（多客户端/历史视图）", async () => {
  const store = new SessionStore("test-cancel-targeted");
  const cmdSpy = vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });

  await store.cancelTurn({ turnId: "turn-explicit" });

  expect(cmdSpy).toHaveBeenCalledWith(
    "conversation",
    expect.objectContaining({ type: "conversation_cancel", turn_id: "turn-explicit" }),
    "test-cancel-targeted",
  );
});

test("取消看门狗：cancel 后超过宽限期仍无终态，就地收口 running 回合并复位发送态", async () => {
  vi.useFakeTimers();
  const store = new SessionStore("test-cancel-watchdog");
  vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });
  const loadBootstrapSpy = vi.spyOn(store, "loadBootstrap").mockResolvedValue();

  (store as any).applyProjection(
    { kind: "channel", data: "conversation" },
    {
      kind: "conversation_delta",
      data: {
        kind: "turn_started",
        data: { turn_id: "t-stuck", input_id: "in1", mode: "normal", revision: 1 },
      },
    },
  );
  store.isSending[1](true);

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
  expect(loadBootstrapSpy).toHaveBeenCalledOnce();
});

test("取消看门狗：真实终态 delta 到达即撤防，不再重复收口", async () => {
  vi.useFakeTimers();
  const store = new SessionStore("test-cancel-watchdog-disarm");
  vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });
  const loadBootstrapSpy = vi.spyOn(store, "loadBootstrap").mockResolvedValue();

  (store as any).applyProjection(
    { kind: "channel", data: "conversation" },
    {
      kind: "conversation_delta",
      data: {
        kind: "turn_started",
        data: { turn_id: "t-fast", input_id: "in1", mode: "normal", revision: 1 },
      },
    },
  );

  await store.cancelTurn();

  // 终态 delta 在宽限期内到达
  (store as any).applyProjection(
    { kind: "channel", data: "conversation" },
    {
      kind: "conversation_delta",
      data: { kind: "turn_interrupted", data: { turn_id: "t-fast", reason: "cancel_before_seal" } },
    },
  );

  await vi.advanceTimersByTimeAsync(CANCEL_WATCHDOG_MS * 2);
  // 终态路径收口一次即止，看门狗没有二次触发
  expect(store.state[0].turns["t-fast"]?.status).toBe("aborted");
  expect(loadBootstrapSpy).not.toHaveBeenCalled();
});
