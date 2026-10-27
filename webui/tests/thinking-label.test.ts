/**
 * 思考标签:套餐摘要 vs 模型原文必须分开(见 src/turn/thinking-label.ts)。
 * 后端 `reasoning_kind` 缺席时不许猜成摘要——那是把"没标注"说成"是摘要"。
 */
import { describe, expect, test } from "vitest";
import { STR } from "../src/lib/strings";
import { thinkingLabel, thinkingRichSummary, thinkingTitle } from "../src/turn/thinking-label";

describe("thinkingLabel", () => {
  test("summary 走「思考摘要」,并带上解释", () => {
    expect(thinkingLabel("summary")).toBe(STR.thinkingSummary);
    expect(thinkingLabel("summary")).toBe("思考摘要");
    expect(thinkingTitle("summary")).toBe(STR.thinkingSummaryTitle);
  });

  test("text / encrypted / redacted / 缺失 都按「思考」显示,且不挂空 title", () => {
    expect(thinkingLabel("text")).toBe(STR.thinking);
    expect(thinkingLabel("encrypted")).toBe(STR.thinking);
    expect(thinkingLabel("redacted")).toBe(STR.thinking);
    expect(thinkingLabel(undefined)).toBe(STR.thinking);
    expect(thinkingLabel(null)).toBe(STR.thinking);
    for (const kind of ["text", "encrypted", "redacted", undefined, null] as const) {
      expect(thinkingTitle(kind)).toBeUndefined();
    }
  });
});

describe("thinkingRichSummary", () => {
  test("套餐(OAuth) + GPT 家族 → 富呈现(大小写与首尾空白不敏感)", () => {
    expect(thinkingRichSummary(true, "gpt-6.1-sol")).toBe(true);
    expect(thinkingRichSummary(true, " GPT-5.6-Luna ")).toBe(true);
  });

  test("非套餐一律不富呈现:BYOK 上的 gpt-* 也不算", () => {
    expect(thinkingRichSummary(false, "gpt-6-sol")).toBe(false);
  });

  test("账号额度但非 GPT 家族(DeepSeek 账号目录)不富呈现", () => {
    expect(thinkingRichSummary(true, "deepseek-v4-pro")).toBe(false);
    expect(thinkingRichSummary(true, "deepseek-flash")).toBe(false);
    expect(thinkingRichSummary(true, "")).toBe(false);
  });
});
