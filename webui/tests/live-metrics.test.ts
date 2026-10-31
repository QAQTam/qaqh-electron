import { afterEach, expect, test, vi } from "vitest";
import { SessionStore, estimateTokens } from "../src/session/store";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("estimateTokens 针对 CJK 与拉丁字符的粗估", () => {
  expect(estimateTokens("")).toBe(0);
  const cjkTokens = estimateTokens("你好世界，这是一个测试！");
  expect(cjkTokens).toBeGreaterThanOrEqual(8);
  expect(cjkTokens).toBeLessThanOrEqual(15);

  const englishTokens = estimateTokens("hello world test function");
  expect(englishTokens).toBeGreaterThanOrEqual(5);
  expect(englishTokens).toBeLessThanOrEqual(10);
});

function createMetricsHarness() {
  const store = new SessionStore("test-metrics");
  const feedProjection = (delta: unknown) =>
    (store as unknown as { applyProjection(key: unknown, payload: unknown): void }).applyProjection(
      { kind: "channel", data: "conversation" },
      { kind: "conversation_delta", data: delta },
    );
  return { store, feedProjection };
}

test("常驻：配置加载后即便尚未生成，contextPercent 也发布为 0% 基础占位（非 null）", () => {
  const { store } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;
  (store as unknown as { publishContextPercent(): void }).publishContextPercent();

  const metrics = store.composerMetrics[0]();
  expect(metrics.contextPercent).toBe(0);
  expect(metrics.contextWindow).toBe(100_000);
  expect(metrics.isStreaming).toBe(false);
});

test("回合封顶：assistant_block_sealed 结算官方 usage 并定格均值，切换 isStreaming: false", () => {
  const { store, feedProjection } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  // 服务端下发 assistant_block_sealed 携带 usage
  feedProjection({
    kind: "assistant_block_sealed",
    data: {
      revision: 1,
      turn_id: "t1",
      block_id: "ans_1",
      block_kind: "answer",
      content: { kind: "inline", data: { text: "回答完毕" } },
      model: "test-model",
      usage: {
        prompt_tokens: 12_000,
        completion_tokens: 80,
        total_tokens: 12_080,
        prompt_cache_hit_tokens: 6_000,
        prompt_cache_miss_tokens: 6_000,
        reasoning_tokens: 0,
        cache_usage_reported: true,
      },
    },
  });

  const settled = store.composerMetrics[0]();
  expect(settled.isStreaming).toBe(false);
  expect(settled.contextPercent).toBeCloseTo(12, 1);
  expect(settled.cacheHitPercent).toBeCloseTo(50, 1);
});

test("turn_started 复位 isStreaming 状态", () => {
  const { store, feedProjection } = createMetricsHarness();
  store.composerMetrics[1]((current) => ({ ...current, isStreaming: true }));

  feedProjection({
    kind: "turn_started",
    data: {
      revision: 2,
      turn_id: "t2",
      input_id: "in2",
      mode: "normal",
    },
  });

  expect(store.composerMetrics[0]().isStreaming).toBe(false);
});
