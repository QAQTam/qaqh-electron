import { describe, expect, it } from "vitest";

import { siwcAccountView, SIWC_FIRST_RUN_TITLE, SIWC_LIMIT_ACTION } from "../src/siwc/state";
import { SIWC_BUTTON_LABEL, type SiwcSessionStatus } from "../src/siwc/brand";

const connected = (over: Partial<SiwcSessionStatus> = {}): SiwcSessionStatus => ({
  status: "connected",
  sharing: true,
  label: "我的 Plus",
  email: "user@example.com",
  name: "QAQ 用户",
  usageUrl: "https://chatgpt.com/settings/usage",
  ...over,
});

describe("ChatGPT 账户视图模型", () => {
  it("未连接时给出登录入口", () => {
    const view = siwcAccountView(null);
    expect(view.kind).toBe("disconnected");
    expect(view.action).toBe(SIWC_BUTTON_LABEL);
    expect(view.showPlanBadge).toBe(false);
    expect(view.usageUrl).toBeNull();
  });

  it("进行中不得显示套餐标识", () => {
    const view = siwcAccountView({ status: "connecting", sharing: false });
    expect(view.kind).toBe("connecting");
    expect(view.showPlanBadge).toBe(false);
    expect(view.action).toBe("取消登录");
  });

  it("已登录但未授权套餐 → identity-only，且**不得**声称套餐已启用", () => {
    const view = siwcAccountView(connected({ sharing: false }));
    expect(view.kind).toBe("identity-only");
    expect(view.showPlanBadge).toBe(false);
    expect(view.subtitle).toContain("套餐用量未启用");
    expect(view.subtitle).not.toContain("已启用");
    expect(view.action).toBe("启用套餐用量");
  });

  it("套餐已启用 → 显示账户身份与套餐标识", () => {
    const view = siwcAccountView(connected());
    expect(view.kind).toBe("plan");
    expect(view.showPlanBadge).toBe(true);
    expect(view.title).toBe("QAQ 用户");
    expect(view.usageUrl).toBe("https://chatgpt.com/settings/usage");
  });

  it("展示名缺失时回退邮箱，再回退通用占位（不暴露 profile id）", () => {
    expect(siwcAccountView(connected({ name: undefined })).title).toBe("user@example.com");
    expect(
      siwcAccountView(connected({ name: undefined, email: undefined })).title,
    ).toBe("ChatGPT 账户");
  });

  it("凭据失效 → 引导重新登录，且不显示套餐标识", () => {
    const stale = siwcAccountView(connected({ status: "reauth_required", sharing: false }));
    expect(stale.kind).toBe("reauth-required");
    expect(stale.action).toBe(SIWC_BUTTON_LABEL);
    expect(stale.showPlanBadge).toBe(false);

    // 后端 error 里带 requiresReauth 时同样判定（例如请求期才发现被断开）。
    const viaError = siwcAccountView(
      connected({ error: { code: "subscription_sharing_invalid_user", requiresReauth: true } }),
    );
    expect(viaError.kind).toBe("reauth-required");
  });

  it("限流态把 Manage usage 提为主行动", () => {
    const view = siwcAccountView(
      connected({
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          message: "limit reached",
        },
      }),
    );
    expect(view.kind).toBe("plan");
    expect(view.usageActionPrimary).toBe(true);
    expect(view.action).toBe(SIWC_LIMIT_ACTION);
    expect(view.showPlanBadge).toBe(true);
  });

  it("暂时性故障不改变账户判定（仍按套餐展示，不引导重登）", () => {
    const view = siwcAccountView(
      connected({ error: { code: "transport_error", message: "network", retryable: true } }),
    );
    expect(view.kind).toBe("plan");
    expect(view.usageActionPrimary).toBe(false);
    expect(view.showPlanBadge).toBe(true);
    expect(view.error).toBe("network");
  });

  it("一次性欢迎卡的文案与指南一致", () => {
    expect(SIWC_FIRST_RUN_TITLE).toBe("你正在使用 ChatGPT 套餐");
  });
});
