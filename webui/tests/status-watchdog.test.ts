import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";

afterEach(() => vi.restoreAllMocks());

function mockHostStream(seed: string) {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  vi.spyOn(host, "subscribe").mockImplementation(async (h) => {
    handlers = h;
    return vi.fn();
  });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "rpc").mockImplementation(async () => ({ items: [] }) as never);
  vi.spyOn(transport, "sessionBootstrap").mockResolvedValue({
    schema: "qaqh.Ringing",
    version: 2,
    session_id: seed,
    conversation: {
      channel: "conversation",
      state: {
        session_id: seed,
        turns: [],
        context: [],
        compaction: null,
        current_turn_id: null,
        revision: 0,
        last_fact_seq: 0,
      },
    },
  });
  return {
    getHandlers: () => handlers,
    streamsRetry: vi.spyOn(host, "streamsRetry").mockResolvedValue(),
  };
}

test("projection://status 直接驱动 connection 状态（live -> connected）", async () => {
  const { getHandlers } = mockHostStream("wd-session");
  const store = new SessionStore("wd-session");
  await store.activate();
  expect(store.connection[0]()).toBe("reconnecting");

  // 收到 single stream 的 live 状态
  getHandlers().onProjectionStatus?.({ status: "live", session_id: "wd-session" });
  expect(store.connection[0]()).toBe("connected");
  expect(store.reconnect[0]()).toBeNull();

  store.dispose();
});

test("projection://status 处理 paused/closed 转化为 offline，reconnecting 保持 reconnecting", async () => {
  const { getHandlers } = mockHostStream("wd2");
  const store = new SessionStore("wd2");
  await store.activate();

  getHandlers().onProjectionStatus?.({ status: "live", session_id: "wd2" });
  expect(store.connection[0]()).toBe("connected");

  // 断网/暂停：转为 offline
  getHandlers().onProjectionStatus?.({ status: "paused", session_id: "wd2" });
  expect(store.connection[0]()).toBe("offline");

  getHandlers().onProjectionStatus?.({ status: "reconnecting", session_id: "wd2" });
  expect(store.connection[0]()).toBe("reconnecting");

  getHandlers().onProjectionStatus?.({ status: "closed", session_id: "wd2" });
  expect(store.connection[0]()).toBe("offline");

  store.dispose();
});
