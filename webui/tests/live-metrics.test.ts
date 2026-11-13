import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import { applyFrame } from "./session-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createMetricsHarness() {
  const store = new SessionStore("test-metrics");
  const feedProjection = (event: Parameters<typeof applyFrame>[1]) => applyFrame(store, event);
  return { store, feedProjection };
}

// tok/s 预测链已退役:composer 指标只剩占用(context/cache),不再测产出速率。
test("composerMetrics 只发布占用类指标,不含 tokensPerSecond/isStreaming", () => {
  const { store } = createMetricsHarness();
  const metrics = store.composerMetrics[0]() as Record<string, unknown>;
  expect(metrics.tokensPerSecond).toBeUndefined();
  expect(metrics.isStreaming).toBeUndefined();
});

test("常驻：配置加载后即便尚未生成，contextPercent 也发布为 0% 基础占位（非 null）", () => {
  const { store } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;
  (store as unknown as { publishContextPercent(): void }).publishContextPercent();

  const metrics = store.composerMetrics[0]();
  expect(metrics.contextPercent).toBe(0);
  expect(metrics.contextWindow).toBe(100_000);
});

test("turn_ended settles official usage and updates context and cache metrics", () => {
  const { store, feedProjection } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedProjection({ seq: 1, type: "turn_ended", turn_id: "t1", outcome: {
    kind: "finished",
    data: {
      terminal: "completed",
      usage: {
        prompt_tokens: 12_000,
        completion_tokens: 80,
        total_tokens: 12_080,
        prompt_cache_hit_tokens: 6_000,
        prompt_cache_miss_tokens: 6_000,
        reasoning_tokens: 0,
        cache_usage_reported: true,
      },
      error: null,
    },
  } });

  const settled = store.composerMetrics[0]();
  expect(settled.contextPercent).toBeCloseTo(12, 1);
  expect(settled.cacheHitPercent).toBeCloseTo(50, 1);
});
