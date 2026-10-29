import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";

afterEach(() => vi.restoreAllMocks());

const page = {
  server_epoch: "e1",
  snapshot: {
    watermark: 7,
    turns: [{ turn_id: "t9", turn_index: 3, user_text: "hi", state: "completed", rounds: [{ round_num: 0, blocks: [{ block_id: "b1", kind: "text", state: "sealed", text: "答" }] }] }],
  },
  has_more: true,
  total_turns: 10,
  truncated_before: false,
};

function mockHost(seed: string) {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  vi.spyOn(host, "subscribe").mockImplementation(async (value) => { handlers = value; return vi.fn(); });
  vi.spyOn(host, "timelineStatus").mockResolvedValue({ status: "reconnecting", session_id: seed });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "rpc").mockImplementation(async () => ({ items: [] }) as never);
  return { pushSnapshot: () => handlers.onTimelineSnapshot({ session_id: seed, ...page } as never) };
}

/**
 * BUG-2026-10-29 第二则:后台标签立即卸载转录,重激活走「消息同步中」→ 权威快照。
 * 宿主只给单一 active seed 建流,内存过载的来源是非活动 store 的全量 turns 常驻。
 */
test("deactivate unloads transcript immediately; re-activate hydrates via authoritative snapshot", async () => {
  const { pushSnapshot } = mockHost("unload-session");
  const store = new SessionStore("unload-session");
  await store.activate();
  expect(store.hydrated[0]()).toBe(false);
  pushSnapshot();
  expect(store.hydrated[0]()).toBe(true);
  expect(Object.keys(store.state[0].turns).length).toBe(1);

  store.deactivate();
  // 卸载:转录/派生状态清零,轻量生命周期保留。
  expect(store.hydrated[0]()).toBe(false);
  expect(Object.keys(store.state[0].turns).length).toBe(0);
  expect(store.state[0].slots.length).toBe(0);
  expect(store.state[0].watermark).toBe(0);
  expect(store.state[0].totalTurns).toBe(0);
  expect(store.pending[0]()).toEqual([]);
  expect(store.todos[0]()).toEqual([]);

  // 再激活:attach 重建流,快照到达前保持未 hydrate(SessionView 渲染「消息同步中」)。
  await store.activate();
  expect(store.hydrated[0]()).toBe(false);
  pushSnapshot();
  expect(store.hydrated[0]()).toBe(true);
  expect(store.state[0].turns["#3"] != null || Object.keys(store.state[0].turns).length === 1).toBe(true);
  store.dispose();
});

test("status open before the snapshot event falls back to one authoritative pull", async () => {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  vi.spyOn(host, "subscribe").mockImplementation(async (value) => { handlers = value; return vi.fn(); });
  vi.spyOn(host, "timelineStatus").mockResolvedValue({ status: "reconnecting", session_id: "fallback" });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "rpc").mockImplementation(async () => ({ items: [] }) as never);
  const timelinePage = vi.spyOn(transport, "timelinePage").mockResolvedValue({
    session_id: "fallback",
    ...page,
  } as never);

  const store = new SessionStore("fallback");
  await store.activate();
  // 快照推送事件丢失,但状态已 open:applyTimelineStatus 兜底按分页口径补拉一次。
  handlers.onTimelineStatus({ status: "open", session_id: "fallback" });
  await vi.waitFor(() => expect(store.hydrated[0]()).toBe(true));
  expect(timelinePage).toHaveBeenCalledTimes(1);
  // 已 hydrate 后,后续 open 不再重复补拉。
  handlers.onTimelineStatus({ status: "open", session_id: "fallback" });
  await Promise.resolve();
  expect(timelinePage).toHaveBeenCalledTimes(1);
  store.dispose();
});
