/**
 * ChatGPT 账户 / 套餐用量 的**视图模型**（纯函数，无 DOM、无框架）。
 *
 * 为什么把语义单独抽出来：DevKit 的 React 组件里，真正值钱的不是布局而是
 * 「什么时候能显示什么」。这块以纯函数表达后，可以脱离 UI 被单测钉住——
 * 而它恰好是**合规面**（`sharing` 未启用时不得显示套餐标识）。
 *
 * 移植自 DevKit `@siwc/react` 的账户/用量交互（React → 本模块的语义层），
 * 表现层由 `./components/*` 以 Solid 实现；**不复制其样式与资产**。
 */

import {
  SIWC_BUTTON_LABEL,
  siwcNeedsReauth,
  siwcNeedsUsageAction,
  siwcPlanBadgeVisible,
  siwcUsageUrl,
  type SiwcSessionStatus,
} from "./brand";

export type SiwcAccountKind =
  | "disconnected"
  | "connecting"
  | "plan"
  | "identity-only"
  | "reauth-required";

export type SiwcAccountView = {
  kind: SiwcAccountKind;
  /** 账户行主文案（登录后优先展示名，其次邮箱）。 */
  title: string;
  /** 状态副标题。**必须**区分「套餐已启用」与「已登录但套餐未启用」。 */
  subtitle: string;
  /** 是否显示「Using ChatGPT plan」标识（唯一判据是 `sharing`）。 */
  showPlanBadge: boolean;
  /** 主行动文案；`null` = 当前状态无需行动。 */
  action: string | null;
  /** 「Manage usage」深链；`null` = 此时不该出现用量入口。 */
  usageUrl: string | null;
  /** 是否需要把「Manage usage」作为**主**行动（限流/不适用/授权上下文）。 */
  usageActionPrimary: boolean;
  /** 可展示的错误行（已由后端投影，无 token 字段）。 */
  error: string | null;
};

const PLAN_SUBTITLE = "套餐用量已启用：符合条件的请求会计入你的 ChatGPT 套餐";
const IDENTITY_ONLY_SUBTITLE = "已登录 · 套餐用量未启用（需要授权后才能使用套餐额度）";

/** 账户展示名：展示名 → 邮箱 → 通用占位。**不用** profile id（对用户无意义）。 */
function accountTitle(status: SiwcSessionStatus | null | undefined): string {
  const name = status?.name?.trim();
  if (name) return name;
  const email = status?.email?.trim();
  if (email) return email;
  return "ChatGPT 账户";
}

/**
 * 由后端 `siwc.status` 投影推导账户视图。
 *
 * 分支顺序即优先级：进行中 > 需重登 > 限流等用户动作 > 套餐 > 仅身份 > 未连接。
 */
export function siwcAccountView(
  status: SiwcSessionStatus | null | undefined,
): SiwcAccountView {
  const base: SiwcAccountView = {
    kind: "disconnected",
    title: "未连接 ChatGPT",
    subtitle: "用你自己的 ChatGPT 套餐在这台机器上完成推理，无需配置 API key",
    showPlanBadge: false,
    action: SIWC_BUTTON_LABEL,
    usageUrl: null,
    usageActionPrimary: false,
    error: null,
  };
  if (!status) return base;

  const error = status.error?.message ?? null;

  if (status.status === "connecting") {
    return {
      ...base,
      kind: "connecting",
      title: "正在完成授权",
      subtitle: "请在弹出的浏览器窗口中登录并确认权限；完成后这个窗口会自动更新",
      action: "取消登录",
    };
  }

  if (siwcNeedsReauth(status)) {
    return {
      ...base,
      kind: "reauth-required",
      title: "ChatGPT 连接需要重新登录",
      subtitle: "凭据已失效或已在 ChatGPT 设置中被断开",
      action: SIWC_BUTTON_LABEL,
      showPlanBadge: false,
      error,
    };
  }

  if (!siwcPlanBadgeVisible(status)) {
    // 已登录但未授权套餐：这是**一个真实状态**，不能被显示成「已连接」。
    if (status.status === "connected") {
      return {
        ...base,
        kind: "identity-only",
        title: accountTitle(status),
        subtitle: IDENTITY_ONLY_SUBTITLE,
        action: "启用套餐用量",
        usageUrl: siwcUsageUrl(status),
      };
    }
    return { ...base, error };
  }

  // 套餐已启用。限流等状态把 Manage usage 提为主行动。
  const usageActionPrimary = siwcNeedsUsageAction(status);
  return {
    ...base,
    kind: "plan",
    title: accountTitle(status),
    subtitle: PLAN_SUBTITLE,
    showPlanBadge: true,
    action: usageActionPrimary ? "Manage usage" : "切换账户",
    usageUrl: siwcUsageUrl(status),
    usageActionPrimary,
    error,
  };
}

/** 设置页「使用你的 ChatGPT 套餐」卡片文案（devkit settings card 的对应物）。 */
export const SIWC_SETTINGS_CARD_TITLE = "使用你的 ChatGPT 套餐";
export const SIWC_SETTINGS_CARD_BODY =
  "在本应用中完成符合条件的 AI 请求，用量计入你的 ChatGPT 套餐或 credits 余额。";

/** 首次成功启用套餐后的**一次性**欢迎卡文案（此后不得再出现）。 */
export const SIWC_FIRST_RUN_TITLE = "你正在使用 ChatGPT 套餐";
export const SIWC_FIRST_RUN_BODY =
  "本应用符合条件的请求会计入你的 ChatGPT 套餐；你可以随时在 ChatGPT 设置中管理用量与授权。";
export const SIWC_FIRST_RUN_DISMISS = "知道了";

/** 限流态文案：主行动是 Manage usage，不推断额度为空或重置时间。 */
export const SIWC_LIMIT_TITLE = "已达到用量上限";
export const SIWC_LIMIT_BODY =
  "可能是套餐限额，也可能是本应用的限额。打开 ChatGPT 设置查看并调整。";
export const SIWC_LIMIT_ACTION = "Manage usage";
