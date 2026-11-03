import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";
import { createRoot } from "solid-js";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("real host projection dispatch refreshes todos after tool completion without legacy dashboard events", async () => {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  const unlisten = vi.fn();
  vi.spyOn(host, "subscribe").mockImplementation(async (value) => { handlers = value; return unlisten; });
  vi.spyOn(host, "sessionBootstrap").mockResolvedValue({ control: { state: { activity: "idle" } } });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  let items = [{ id: "T1", title: "live task", status: "pending" }];
  const rpc = vi.spyOn(transport, "query").mockImplementation(async () => ({ items }) as never);
  let store!: SessionStore;
  createRoot((dispose) => { store = new SessionStore("todo-session"); void dispose; });
  await store.activate();
  await vi.waitFor(() => expect(store.todos[0]()[0]?.status).toBe("pending"));
  const event = { stream_key: { kind: "channel", data: "control" }, payload: { kind: "control_delta", data: { kind: "tool_finished", data: { call_id: "call-1", terminal_status: "succeeded" } } } };
  rpc.mockClear();
  handlers.onProjectionEvent("another-session", event);
  expect(rpc).not.toHaveBeenCalled();
  items = [{ id: "T1", title: "live task", status: "completed" }];
  handlers.onProjectionEvent("todo-session", event);
  await vi.waitFor(() => expect(store.todos[0]()[0]?.status).toBe("completed"));
  expect(rpc).toHaveBeenCalledWith({ type: "todo.list" }, { kind: "session", session_id: "todo-session" });
  items = [];
  handlers.onProjectionEvent("todo-session", { stream_key: { kind: "channel", data: "conversation" }, payload: { kind: "conversation_delta", data: { kind: "turn_finished", data: {} } } });
  await vi.waitFor(() => expect(store.todos[0]()).toEqual([]));
  store.dispose();
  expect(unlisten).toHaveBeenCalledOnce();
});

test("invalidations during a request retain one trailing read and never commit the old response", async () => {
  const old = deferred<unknown>();
  const newest = deferred<unknown>();
  const rpc = vi.spyOn(transport, "query").mockImplementationOnce(() => old.promise as never).mockImplementationOnce(() => newest.promise as never);
  let store!: SessionStore;
  createRoot((dispose) => { store = new SessionStore("todo-session"); void dispose; });
  const read = store.refreshTodos();
  for (let index = 0; index < 20; index++) void store.refreshTodos();
  expect(rpc).toHaveBeenCalledTimes(1);
  old.resolve({ items: [{ id: "T1", status: "pending" }] });
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(store.todos[0]()).toEqual([]);
  newest.resolve({ items: [{ id: "T1", status: "completed" }] });
  await read;
  expect(store.todos[0]()[0]?.status).toBe("completed");
  expect(rpc).toHaveBeenCalledTimes(2);
  store.dispose();
});

test("RPC failures preserve the last successful list and the next signal recovers", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const items = [{ id: "T1", status: "pending" }];
  const rpc = vi.spyOn(transport, "query").mockResolvedValue({ items } as never);
  let store!: SessionStore;
  createRoot((dispose) => { store = new SessionStore("todo-session"); void dispose; });
  await store.refreshTodos();
  rpc.mockRejectedValueOnce(new Error("offline"));
  await store.refreshTodos();
  expect(store.todos[0]()).toEqual(items);
  rpc.mockResolvedValueOnce({ status: "unexpected" } as never);
  await store.refreshTodos();
  expect(store.todos[0]()).toEqual(items);
  rpc.mockResolvedValueOnce({ items: [] } as never);
  await store.refreshTodos();
  expect(store.todos[0]()).toEqual([]);
  store.dispose();
});

test("RPC failures expose pending sync and retry automatically without a new event", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = desktopHostSurface(transport)!;
  vi.spyOn(host, "subscribe").mockImplementation(async () => vi.fn());
  vi.spyOn(host, "sessionBootstrap").mockResolvedValue({ control: { state: { activity: "idle" } } });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  let todoCalls = 0;
  vi.spyOn(transport, "query").mockImplementation(async (command) => {
    if (command.type !== "todo.list") return {} as never;
    todoCalls++;
    if (todoCalls === 1) throw new Error("offline");
    return { items: [{ id: "T2", status: "pending" }] } as never;
  });
  let store!: SessionStore;
  createRoot((dispose) => { store = new SessionStore("todo-session"); void dispose; });
  await store.activate();
  await Promise.resolve();
  expect(todoCalls).toBe(1);
  expect(store.todosSyncPending[0]()).toBe(true);
  expect(store.todos[0]()).toEqual([]);
  await vi.advanceTimersByTimeAsync(500);
  expect(todoCalls).toBe(2);
  expect(store.todosSyncPending[0]()).toBe(false);
  expect(store.todos[0]()[0]?.id).toBe("T2");
  store.dispose();
  vi.useRealTimers();
});

test("disposed stores do not commit pending todo responses or start more requests", async () => {
  const response = deferred<unknown>();
  const rpc = vi.spyOn(transport, "query").mockImplementation(() => response.promise as never);
  let store!: SessionStore;
  createRoot((dispose) => { store = new SessionStore("todo-session"); void dispose; });
  const read = store.refreshTodos();
  store.dispose();
  response.resolve({ items: [{ id: "T1" }] });
  await read;
  await store.refreshTodos();
  expect(store.todos[0]()).toEqual([]);
  expect(rpc).toHaveBeenCalledOnce();
});
