import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { transport, desktopHostSurface } from "../src/lib/transport";

afterEach(() => vi.restoreAllMocks());

/**
 * BUG-2026-10-29:connection 只由宿主推的 `timeline://status` 事件驱动,daemon
 * 重启窗口期的 open 事件被错过(或宿主一条流 paused 后 combined 永不回 open)时,
 * 「网络波动,正在重连」横幅无限期滞留,直到用户发出首个请求才间接翻转。
 * 看门狗在非 connected 期间周期性向宿主核对缓存状态(纯 IPC),这里验证两条自愈路。
 */

function mockHostBasics(seed: string, status: () => { status: string; session_id: string } | null) {
  const host = desktopHostSurface(transport)!;
  vi.spyOn(host, "subscribe").mockImplementation(async () => vi.fn());
  const statusQuery = vi.spyOn(host, "timelineStatus").mockImplementation(async () => status() as never);
  vi.spyOn(transport, "attach").mockResolvedValue();
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "rpc").mockImplementation(async () => ({ items: [] }) as never);
  return { statusQuery, streamsRetry: vi.spyOn(host, "streamsRetry").mockResolvedValue() };
}

test("status watchdog re-syncs a missed open event after daemon restart and then stops", async () => {
  vi.useFakeTimers();
  try {
    let status: { status: string; session_id: string } | null = { status: "reconnecting", session_id: "wd-session" };
    const { statusQuery } = mockHostBasics("wd-session", () => status);
    const store = new SessionStore("wd-session");
    await store.activate();
    expect(store.connection[0]()).toBe("reconnecting");

    // daemon 已恢复,宿主缓存状态转 open;渲染层错过的事件由看门狗补上。
    status = { status: "open", session_id: "wd-session" };
    await vi.advanceTimersByTimeAsync(2_600);
    expect(store.connection[0]()).toBe("connected");
    expect(store.reconnect[0]()).toBeNull();

    // connected 后看门狗自停:再走 10s 也不该有新的状态查询。
    const calls = statusQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusQuery.mock.calls.length).toBe(calls);
    store.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("watchdog auto-rebuilds wedged host streams (combined closed) at a limited rate", async () => {
  vi.useFakeTimers();
  try {
    const { streamsRetry } = mockHostBasics("wd2", () => ({ status: "closed", session_id: "wd2" }));
    const store = new SessionStore("wd2");
    await store.activate();

    // paused 流的 combined=closed 事件驱动永不自愈:看门狗限频(≥10s 间隔)自动重建。
    // fake clock 从当前真实时刻起算:2.5s 首个 tick 即满足限频 → 第 1 次;
    // 5/7.5/10s 被拦;12.5s 第 2 次;15/17.5/20s 被拦;22.5s 第 3 次。
    await vi.advanceTimersByTimeAsync(12_000);
    expect(streamsRetry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(streamsRetry).toHaveBeenCalledTimes(3);
    store.dispose();
  } finally {
    vi.useRealTimers();
  }
});
