import { describe, expect, it } from "vitest";

import {
  SIWC_BUTTON_ASSETS,
  SIWC_BUTTON_LABEL,
  SIWC_USAGE_URL_FALLBACK,
  probeSiwcButtonAssets,
  siwcButtonPresentation,
  siwcIsTransient,
  siwcNeedsReauth,
  siwcNeedsUsageAction,
  siwcPlanBadgeVisible,
  siwcUsageUrl,
  type SiwcSessionStatus,
} from "../src/siwc/brand";

const base: SiwcSessionStatus = { status: "disconnected", sharing: false };

describe("siwc 品牌口径", () => {
  it("按钮文案只用官方指定的那一句", () => {
    expect(SIWC_BUTTON_LABEL).toBe("Continue with ChatGPT");
  });

  it("套餐标识只在 sharing 为真时显示", () => {
    expect(siwcPlanBadgeVisible({ sharing: false })).toBe(false);
    expect(siwcPlanBadgeVisible({ sharing: true })).toBe(true);
    // 未定论 / 需重登 / 无状态 都不显示。
    expect(siwcPlanBadgeVisible(null)).toBe(false);
    expect(siwcPlanBadgeVisible(undefined)).toBe(false);
    expect(
      siwcPlanBadgeVisible({ ...base, status: "connecting", sharing: false }),
    ).toBe(false);
    expect(
      siwcPlanBadgeVisible({ ...base, status: "reauth_required", sharing: false }),
    ).toBe(false);
  });

  it("深链优先用后端给的值，缺省回退常量", () => {
    expect(siwcUsageUrl({ usageUrl: "https://example.test/usage" })).toBe(
      "https://example.test/usage",
    );
    expect(siwcUsageUrl({ usageUrl: "  " })).toBe(SIWC_USAGE_URL_FALLBACK);
    expect(siwcUsageUrl(undefined)).toBe(SIWC_USAGE_URL_FALLBACK);
    expect(SIWC_USAGE_URL_FALLBACK).toBe("https://chatgpt.com/settings/usage");
  });

  it("区分「要重登」「要去设置处理」「暂时故障」三种恢复路径", () => {
    expect(siwcNeedsReauth({ status: "reauth_required" })).toBe(true);
    expect(siwcNeedsReauth({ status: "connected", error: { code: "x", requiresReauth: true } })).toBe(true);
    expect(siwcNeedsReauth({ status: "connected" })).toBe(false);

    expect(
      siwcNeedsUsageAction({
        error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" },
      }),
    ).toBe(true);
    expect(
      siwcNeedsUsageAction({
        error: { code: "subscription_sharing_user_not_eligible", message: "nope" },
      }),
    ).toBe(true);
    // 传输故障不是「去设置处理」。
    expect(
      siwcNeedsUsageAction({ error: { code: "transport_error", retryable: true } }),
    ).toBe(false);

    expect(siwcIsTransient({ error: { code: "transport_error", retryable: true } })).toBe(true);
    expect(
      siwcIsTransient({
        error: { code: "subscription_sharing_usage_limit_exceeded", retryable: false },
      }),
    ).toBe(false);
  });

  it("资产缺失时回退文字按钮，且不影响功能入口", () => {
    expect(siwcButtonPresentation(false)).toEqual({
      kind: "text",
      label: "Continue with ChatGPT",
    });
    expect(siwcButtonPresentation(true)).toEqual({
      kind: "asset",
      src: SIWC_BUTTON_ASSETS.black,
      alt: "Continue with ChatGPT",
    });
    expect(siwcButtonPresentation(true, "white").kind).toBe("asset");
  });

  it("探测失败一律按「没有资产」处理", async () => {
    const ok = () =>
      Promise.resolve({ ok: true } as Response);
    const notFound = () =>
      Promise.resolve({ ok: false } as Response);
    const boom = () => Promise.reject(new Error("offline"));

    await expect(probeSiwcButtonAssets(ok as unknown as typeof fetch)).resolves.toBe(true);
    await expect(probeSiwcButtonAssets(notFound as unknown as typeof fetch)).resolves.toBe(false);
    await expect(probeSiwcButtonAssets(boom as unknown as typeof fetch)).resolves.toBe(false);
  });
});
