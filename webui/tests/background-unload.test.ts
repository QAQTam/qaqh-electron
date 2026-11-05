import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";
import { inline, sessionBootstrap } from "./session-fixtures";

afterEach(() => vi.restoreAllMocks());

const bootstrap = sessionBootstrap("unload-session", {
  seq: 1,
  turns: [{ turn_id: "t9", input_id: "in1", mode: "normal", outcome: { kind: "finished", data: { terminal: "completed", usage: null, error: null } } }],
  timeline: [{ kind: "assistant_block", data: {
    turn_id: "t9", block_id: "b1", block_kind: "answer", content: inline("答"), model: "model-1", usage: null,
  } }],
});

function mockHost(deliverBootstrap = true) {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  vi.spyOn(host, "subscribe").mockImplementation(async (value) => { handlers = value; return vi.fn(); });
  const attach = vi.spyOn(transport, "attach").mockImplementation(async () => {
    if (deliverBootstrap) handlers.onProjectionBootstrap?.("unload-session", bootstrap);
  });
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(host, "sessionBootstrap").mockResolvedValue(bootstrap);
  vi.spyOn(transport, "query").mockImplementation(async (method) =>
    (method === "todo.list" ? { items: [] } : {}) as never);
  return { handlers: () => handlers, attach };
}

test("deactivation drops transient lists and reactivation installs a fresh flat bootstrap", async () => {
  const { attach } = mockHost();
  const store = new SessionStore("unload-session");
  await store.activate();
  expect(store.hydrated[0]()).toBe(true);
  expect(store.state[0].slots.length).toBe(1);
  expect(store.state[0].totalTurns).toBe(1);

  store.pending[1]([{ challenge_id: "temporary" } as never]);
  store.todos[1]([{ id: "todo" } as never]);
  store.deactivate();
  expect(store.hydrated[0]()).toBe(true);
  expect(store.state[0].slots.length).toBe(1);
  expect(store.state[0].totalTurns).toBe(1);
  expect(store.pending[0]()).toEqual([]);
  expect(store.todos[0]()).toEqual([]);

  await store.activate();
  expect(attach).toHaveBeenCalledTimes(2);
  expect(store.state[0].turns.t9?.answer?.text).toBe("答");
  store.dispose();
});

test("explicit bootstrap fallback installs the canonical state while live status drives connection", async () => {
  const { handlers } = mockHost(false);
  const store = new SessionStore("unload-session");
  await store.activate();
  expect(store.hydrated[0]()).toBe(false);
  await store.loadBootstrap();
  expect(store.hydrated[0]()).toBe(true);
  expect(store.state[0].turns.t9?.answer?.text).toBe("答");
  handlers().onProjectionStatus?.({ status: "live", session_id: "unload-session" });
  expect(store.connection[0]()).toBe("connected");
  store.dispose();
});

test("连接恢复时通知标签刷新全局读模型，初次连接不重复刷新", async () => {
  const { handlers } = mockHost();
  const store = new SessionStore("unload-session");
  const restored = vi.fn();
  store.onConnectionRestored = restored;
  await store.activate();
  handlers().onProjectionStatus?.({ status: "live", session_id: "unload-session" });
  expect(restored).not.toHaveBeenCalled();
  handlers().onProjectionStatus?.({ status: "connecting", session_id: "unload-session" });
  handlers().onProjectionStatus?.({ status: "live", session_id: "unload-session" });
  expect(restored).toHaveBeenCalledTimes(1);
  store.dispose();
});
