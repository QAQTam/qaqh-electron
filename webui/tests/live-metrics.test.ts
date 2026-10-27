import { afterEach, expect, test, vi } from "vitest";
import { SessionStore, estimateTokens } from "../src/session/store";
import type { TimelineEntryWire } from "../src/session/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("estimateTokens 针对 CJK 与拉丁字符的粗估", () => {
  expect(estimateTokens("")).toBe(0);
  // 中文字符：10 个汉字约为 8 tokens
  const cjkTokens = estimateTokens("你好世界，这是一个测试！");
  expect(cjkTokens).toBeGreaterThanOrEqual(8);
  expect(cjkTokens).toBeLessThanOrEqual(15);

  // 英文/代码：约 4 字符 1 token
  const englishTokens = estimateTokens("hello world test function");
  expect(englishTokens).toBeGreaterThanOrEqual(5);
  expect(englishTokens).toBeLessThanOrEqual(10);
});

function createMetricsHarness() {
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frame = fn;
    return 1;
  });
  const store = new SessionStore("test-metrics");
  let seq = 0;
  const feedTimeline = (event: unknown) =>
    (store as unknown as { onTimelineEntry(entry: TimelineEntryWire): void }).onTimelineEntry({
      timeline_seq: ++seq,
      turn_id: "t1",
      event,
    } as TimelineEntryWire);

  const feedProjection = (delta: unknown) =>
    (store as unknown as { applyProjection(key: unknown, payload: unknown): void }).applyProjection(
      { kind: "channel", data: "conversation" },
      { kind: "conversation_delta", data: delta },
    );

  return { store, feedTimeline, feedProjection, frame: () => frame(0) };
}

test("常驻：配置加载后即便尚未生成，contextPercent 也发布为 0% 基础占位（非 null）", () => {
  const { store } = createMetricsHarness();
  // 注入 contextLength
  (store as unknown as { contextLength: number }).contextLength = 100_000;
  (store as unknown as { publishContextPercent(): void }).publishContextPercent();

  const metrics = store.composerMetrics[0]();
  expect(metrics.contextPercent).toBe(0);
  // 分母必须一起发布：否则「怎么才 1%」没法自查（配置里可能就写着 1,000,000）。
  expect(metrics.contextWindow).toBe(100_000);
  expect(metrics.tokensPerSecond).toBeNull();
  expect(metrics.isStreaming).toBe(false);
});

test("流式期间：text_delta 驱动实时瞬时 tok/s 与 isStreaming: true", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { store, feedTimeline, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  // 开启文本块
  feedTimeline({ type: "block_opened", block: { block_id: "ans_1", kind: "text", state: "open" } });

  // 持续输出分片:真实流式是分帧到达的,时钟必须跟着走——否则窗口首尾跨度为 0,
  // 算不出瞬时速率(这正是旧实现用「累计 ÷ 总时长」兜底蒙过去的场景)。
  for (let i = 0; i < 20; i += 1) {
    vi.advanceTimersByTime(40);
    feedTimeline({ type: "text_delta", block_id: "ans_1", delta: "正在流式生成回答的一段文本测试内容。" });
    frame();
  }

  const live = store.composerMetrics[0]();
  expect(live.isStreaming).toBe(true);
  expect(live.tokensPerSecond).toBeGreaterThan(0);
  expect(live.contextPercent).toBeGreaterThan(0);
});

test("流中 usage 采样：官方分子即时同步，且不打断吐字脉冲（温和路径）", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { store, feedTimeline, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedTimeline({ type: "block_opened", block: { block_id: "ans_1", kind: "text", state: "open" } });
  vi.advanceTimersByTime(100);
  feedTimeline({ type: "text_delta", block_id: "ans_1", delta: "正在流式生成回答的一段文本测试内容。" });
  frame();
  const streamingBefore = store.composerMetrics[0]();
  expect(streamingBefore.isStreaming).toBe(true);
  const tpsBefore = streamingBefore.tokensPerSecond;

  // 端点在流中报 usage（message_start 一类）：prompt=5000 → 5%，脉冲与 tok/s 不动。
  feedTimeline({
    type: "usage_sampled",
    usage: {
      prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010,
      prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 1000,
      reasoning_tokens: 0, cache_usage_reported: true,
    },
  });
  const sampled = store.composerMetrics[0]();
  expect(sampled.contextPercent).toBeCloseTo(5, 5);
  expect(sampled.cacheHitPercent).toBeCloseTo(80, 1);
  expect(sampled.isStreaming).toBe(true);
  expect(sampled.tokensPerSecond).toBe(streamingBefore.tokensPerSecond);

  // 只报 output 的端点（Anthropic message_delta）：没有 prompt 就不得清零分子。
  feedTimeline({
    type: "usage_sampled",
    usage: {
      prompt_tokens: 0, completion_tokens: 20, total_tokens: 20,
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0,
      reasoning_tokens: 0, cache_usage_reported: false,
    },
  });
  const outputOnly = store.composerMetrics[0]();
  expect(outputOnly.contextPercent).toBeCloseTo(5, 5);
  expect(outputOnly.isStreaming).toBe(true);
  expect(outputOnly.tokensPerSecond).toBe(tpsBefore);
});

test("思考(reasoning)期间同样要出速率：reasoning 块也是模型产出", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { store, feedTimeline, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedTimeline({ type: "block_opened", block: { block_id: "rsn_1", kind: "reasoning", state: "open" } });
  for (let i = 0; i < 12; i += 1) {
    vi.advanceTimersByTime(40);
    feedTimeline({ type: "text_delta", block_id: "rsn_1", delta: "先想清楚这一步要改哪几个模块再说。" });
    frame();
  }

  const thinking = store.composerMetrics[0]();
  expect(thinking.isStreaming).toBe(true);
  expect(thinking.tokensPerSecond).toBeGreaterThan(0);
});

test("工具块一开就停表：无进度流的工具期间脉冲点不许继续亮着", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { store, feedTimeline, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedTimeline({ type: "block_opened", block: { block_id: "ans_1", kind: "text", state: "open" } });
  for (let i = 0; i < 8; i += 1) {
    vi.advanceTimersByTime(40);
    feedTimeline({ type: "text_delta", block_id: "ans_1", delta: "好，我先写这个文件。" });
    frame();
  }
  expect(store.composerMetrics[0]().isStreaming).toBe(true);
  const rateBeforeTool = store.composerMetrics[0]().tokensPerSecond;

  // read/write/grep 这类工具不推 tool_progress → 不会有 flush → 旧实现里数字与
  // 脉冲点会一直冻结在「正在吐字」。block_opened(tool) 本身就是产出暂停的权威信号。
  feedTimeline({ type: "block_opened", block: { block_id: "tl_1", kind: "tool", state: "open" } });

  const duringTool = store.composerMetrics[0]();
  expect(duringTool.isStreaming).toBe(false);
  // 停表不等于把速率抹成 0:保留上一个实测值,与「上下文 12%」那颗芯片同语义。
  expect(duringTool.tokensPerSecond).toBe(rateBeforeTool);
});

test("工具停顿后不许拿总时长凑速率：数字冻结而非单调衰减", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { store, feedTimeline, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedTimeline({ type: "block_opened", block: { block_id: "ans_1", kind: "text", state: "open" } });
  for (let i = 0; i < 10; i += 1) {
    vi.advanceTimersByTime(40);
    feedTimeline({ type: "text_delta", block_id: "ans_1", delta: "这一段是模型真在吐的字。" });
    frame();
  }
  const rateBefore = store.composerMetrics[0]().tokensPerSecond!;
  expect(rateBefore).toBeGreaterThan(0);

  //  exec 在跑:只有 tool_progress 会排 flush。旧实现此时窗口已被 1200ms 裁空,
  // 落到「累计 token ÷ 从首个增量算起的总时长」,于是速率随工具时长一路跌。
  vi.advanceTimersByTime(3000);
  feedTimeline({ type: "tool_progress", block_id: "tl_1", chunk: "still running\n" });
  frame();

  const stalled = store.composerMetrics[0]();
  expect(stalled.isStreaming).toBe(false);
  expect(stalled.tokensPerSecond).toBe(rateBefore);
});

test("官方速率分母只算模型产出区间，工具墙钟不得摊进去", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { store, feedTimeline, feedProjection, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedTimeline({ type: "block_opened", block: { block_id: "ans_1", kind: "text", state: "open" } });
  for (let i = 0; i < 6; i += 1) {
    vi.advanceTimersByTime(100);
    feedTimeline({ type: "text_delta", block_id: "ans_1", delta: "前半段产出。" });
    frame();
  }
  feedTimeline({ type: "block_opened", block: { block_id: "tl_1", kind: "tool", state: "open" } });
  vi.advanceTimersByTime(30_000); // 一个 30 秒的 exec
  feedTimeline({ type: "block_opened", block: { block_id: "ans_2", kind: "text", state: "open" } });
  for (let i = 0; i < 5; i += 1) {
    vi.advanceTimersByTime(100);
    feedTimeline({ type: "text_delta", block_id: "ans_2", delta: "后半段产出。" });
    frame();
  }

  feedProjection({
    kind: "assistant_block_sealed",
    data: {
      revision: 9, turn_id: "t1", block_id: "ans_2", block_kind: "text",
      content: { kind: "inline", data: { text: "done" } }, model: "test-model",
      usage: {
        prompt_tokens: 1500, completion_tokens: 110, total_tokens: 1610,
        prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1500,
        reasoning_tokens: 0, cache_usage_reported: true,
      },
    },
  });

  // 产出区间 ≈ 5×100 + 4×100 = 900ms(30 秒工具不计)。旧实现取首末差 = 31 秒,
  // 110/31 ≈ 3.5 tok/s,把模型说慢了 28 倍。
  const settled = store.composerMetrics[0]().tokensPerSecond!;
  expect(settled).toBeGreaterThan(100);
  expect(settled).toBeLessThan(130);
});

test("回合封顶：assistant_block_sealed 结算官方 usage 并定格均值，切换 isStreaming: false", () => {
  const { store, feedTimeline, feedProjection, frame } = createMetricsHarness();
  (store as unknown as { contextLength: number }).contextLength = 100_000;

  feedTimeline({ type: "block_opened", block: { block_id: "ans_1", kind: "text", state: "open" } });
  feedTimeline({ type: "text_delta", block_id: "ans_1", delta: "第一句话" });
  frame();

  expect(store.composerMetrics[0]().isStreaming).toBe(true);

  // 服务端下发 usage 封顶事件
  feedProjection({
    kind: "assistant_block_sealed",
    data: {
      revision: 1,
      turn_id: "t1",
      block_id: "ans_1",
      block_kind: "text",
      content: { kind: "inline", data: { text: "第一句话" } },
      model: "test-model",
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 100,
        total_tokens: 1600,
        prompt_cache_hit_tokens: 1000,
        prompt_cache_miss_tokens: 500,
        reasoning_tokens: 0,
        cache_usage_reported: true,
      },
    },
  });

  const settled = store.composerMetrics[0]();
  expect(settled.isStreaming).toBe(false);
  // prompt_tokens 1500 / contextLength 100000 = 1.5%
  expect(settled.contextPercent).toBeCloseTo(1.5, 1);
  expect(settled.cacheHitPercent).toBeCloseTo(66.67, 1);
  expect(settled.tokensPerSecond).toBeGreaterThan(0);
});
