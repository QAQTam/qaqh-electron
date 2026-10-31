import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";

afterEach(() => vi.restoreAllMocks());

const mockBootstrap = {
  schema: "qaqh.Ringing",
  version: 2,
  session_id: "unload-session",
  snapshot_cursor: "cursor-1",
  conversation: {
    channel: "conversation",
    state: {
      session_id: "unload-session",
      turns: [{ turn_id: "t9", input_id: "in1", mode: "normal", outcome: { kind: "finished", data: { terminal: "completed", usage: null, error: null } } }],
      context: [{
        source_fact_seq: 1,
        kind: {
          kind: "assistant_block",
          data: {
            turn_id: "t9",
            block_id: "b1",
            block_kind: "answer",
            content: { kind: "inline", data: { text: "答" } },
            model: "model-1",
            usage: null,
          },
        },
      }],
      compaction: null,
      current_turn_id: null,
      revision: 1,
      last_fact_seq: 1,
    },
  },
};

function mockHost(seed: string) {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  vi.spyOn(host, "subscribe").mockImplementation(async (value) => { handlers = value; return vi.fn(); });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "rpc").mockImplementation(async () => ({ items: [] }) as never);
  const bootstrapSpy = vi.spyOn(transport, "sessionBootstrap").mockResolvedValue(mockBootstrap);
  return {
    getHandlers: () => handlers,
    bootstrapSpy,
  };
}

test("deactivate unloads transcript immediately; re-activate hydrates via authoritative snapshot", async () => {
  const { bootstrapSpy } = mockHost("unload-session");
  const store = new SessionStore("unload-session");
  await store.activate();
  expect(store.hydrated[0]()).toBe(true);
  expect(store.state[0].slots.length).toBe(1);
  expect(store.state[0].totalTurns).toBe(1);

  store.deactivate();
  // 卸载:转录/派生状态清零,轻量生命周期保留。
  expect(store.hydrated[0]()).toBe(false);
  expect(Object.keys(store.state[0].turns).length).toBe(0);
  expect(store.state[0].slots.length).toBe(0);
  expect(store.state[0].totalTurns).toBe(0);
  expect(store.pending[0]()).toEqual([]);
  expect(store.todos[0]()).toEqual([]);

  // 再激活:attach 重建流，权威快照装配完成
  await store.activate();
  expect(store.hydrated[0]()).toBe(true);
  expect(store.state[0].slots.length).toBe(1);
  expect(store.state[0].totalTurns).toBe(1);
  expect(bootstrapSpy).toHaveBeenCalledTimes(2);
  store.dispose();
});

test("projection://status live triggers loadBootstrap when not hydrated", async () => {
  const { getHandlers, bootstrapSpy } = mockHost("fallback");
  const store = new SessionStore("fallback");
  store.hydrated[1](false);
  await store.activate();
  expect(bootstrapSpy).toHaveBeenCalledTimes(1);

  store.hydrated[1](false);
  getHandlers().onProjectionStatus?.({ status: "live", session_id: "fallback" });
  await vi.waitFor(() => expect(store.hydrated[0]()).toBe(true));
  expect(bootstrapSpy).toHaveBeenCalledTimes(2);

  // 已 hydrate 后不再重复拉取
  getHandlers().onProjectionStatus?.({ status: "live", session_id: "fallback" });
  expect(bootstrapSpy).toHaveBeenCalledTimes(2);

  store.dispose();
});
