import { createRoot } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { desktopHostSurface, transport, type StreamHandlers } from "../src/lib/transport";
import { SessionStore } from "../src/session/store";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const host = desktopHostSurface(transport)!;
  let handlers!: StreamHandlers;
  vi.spyOn(host, "subscribe").mockImplementation(async (next) => { handlers = next; return vi.fn(); });
  vi.spyOn(host, "sessionBootstrap").mockResolvedValue({ control: { state: { activity: "running" } } });
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "query").mockResolvedValue({ items: [] } as never);
  vi.spyOn(transport, "invalidateApprovals").mockResolvedValue();
  let store!: SessionStore;
  createRoot((dispose) => { store = new SessionStore("approval-session"); void dispose; });
  return { store, handlers: () => handlers };
}

const approval = (challengeId: string): any => ({
  challenge_id: challengeId,
  kind: "tool_permission",
  expires_in: 300,
  details: { tool_name: "exec", details_unavailable: false },
  verified: true,
});

test("approval read failure retries automatically and surfaces the pending card", async () => {
  vi.useFakeTimers();
  const { store } = setup();
  const read = vi.spyOn(transport, "approvals")
    .mockRejectedValueOnce(new Error("temporary network error"))
    .mockResolvedValueOnce([approval("challenge-recovered")] as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await store.activate();
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.pending[0]()[0]?.challenge_id).toBe("challenge-recovered");
  expect(store.pending[0]()[0]?.verified).toBe(true);
  store.dispose();
});

test("a control invalidation defeats an older approvals response and commits the trailing read", async () => {
  const old = deferred<any[]>();
  const latest = deferred<any[]>();
  const { store, handlers } = setup();
  const read = vi.spyOn(transport, "approvals").mockResolvedValue([] as never);
  await store.activate();
  read.mockReset();
  read.mockImplementationOnce(() => old.promise as never).mockImplementationOnce(() => latest.promise as never);
  const refresh = store.refreshApprovals();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  handlers().onProjectionEvent("approval-session", {
    stream_key: { kind: "channel", data: "control" },
    payload: { kind: "control_delta", data: { kind: "interaction_requested", data: { interaction_id: "i1" } } },
  });
  old.resolve([approval("stale")] as never);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(store.pending[0]()).toEqual([]);
  latest.resolve([approval("current")] as never);
  await refresh;
  expect(store.pending[0]()[0]?.challenge_id).toBe("current");
  store.dispose();
});

test("reconnect-live rechecks approval state", async () => {
  const { store, handlers } = setup();
  const read = vi.spyOn(transport, "approvals").mockResolvedValue([] as never);
  await store.activate();
  const initial = read.mock.calls.length;
  handlers().onProjectionStatus?.({ status: "closed", session_id: "approval-session" });
  handlers().onProjectionStatus?.({ status: "live", session_id: "approval-session" });
  await vi.waitFor(() => expect(read.mock.calls.length).toBe(initial + 1));
  store.dispose();
});
