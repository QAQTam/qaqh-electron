/**
 * Sign in with ChatGPT（套餐用量）的品牌资产与合规判定 —— **前端唯一真源**。
 *
 * 三条口径（来自 `developers.openai.com/siwc/ui-ux-guidelines`，也是后端
 * `qaqh_siwc::methods` 那组方法的展示契约）：
 *
 * 1. **按钮文案固定** `Continue with ChatGPT`，不改写、不翻译成营销语。
 * 2. **「Using ChatGPT plan」只在 `sharing === true` 时显示**。`sharing` 为假
 *    表示「已登录但未授权套餐用量」——那时的正确文案是「已登录 · 套餐未启用」，
 *    显示套餐标识等于对计费事实做了错误陈述。
 * 3. **图形资产是可选的**：`public/siwc/` 默认为空（官方资产属 Noncommercial
 *    许可且不含商标授权，见该目录 README）。缺资产时回退纯文字按钮，
 *    登录与推理功能**完全不受影响**。
 *
 * 本模块刻意不引任何 UI 框架：它只回答「能不能显示、显示哪一个、深链去哪」。
 */

/** 与 `public/siwc/` 对齐的运行时目录。 */
export const SIWC_ASSET_DIR = "/siwc";

/** 官方指南指定的按钮文案。**不要改写**（含首次引导、设置页、升级横幅）。 */
export const SIWC_BUTTON_LABEL = "Continue with ChatGPT";

/**
 * 用量设置深链的兜底值。
 *
 * 首选后端 `siwc.status.usageUrl` 返回值——该端点仍处 preview，
 * 把它写死在多处会在上游变更时留下不一致的入口。
 */
export const SIWC_USAGE_URL_FALLBACK = "https://chatgpt.com/settings/usage";

/** 官方 sign-in 按钮的两种底色变体。 */
export const SIWC_BUTTON_ASSETS = {
  black: `${SIWC_ASSET_DIR}/sign-in-with-chatgpt-black.svg`,
  white: `${SIWC_ASSET_DIR}/sign-in-with-chatgpt-white.svg`,
} as const;

/**
 * `siwc.status` 的投影（后端 `qaqh_siwc::SiwcManager::status`）。
 *
 * 形状与后端保持结构对齐；**不含任何 token 字段**（后端在类型层就不下发）。
 * 待后端把它提成 ts-rs DTO 后，这里改为引用生成的类型。
 */
export type SiwcSessionStatus = {
  status: "disconnected" | "connecting" | "connected" | "reauth_required";
  sharing: boolean;
  usageUrl?: string;
  /** 官方 API 端点（后端 `status.apiBase`）：设置页打开 OAuth 模式时填进 endpoint。 */
  apiBase?: string;
  profileId?: string;
  label?: string;
  email?: string;
  name?: string;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    requiresReauth?: boolean;
  };
};

/** 上游错误码里需要「让用户去 ChatGPT 设置处理」的那一组。 */
const USAGE_ACTION_CODES = new Set([
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_user_not_eligible",
  "chatpass_v2_scope_not_authorized",
]);

/** 深链：后端值优先，缺省回退常量。 */
export function siwcUsageUrl(status?: Pick<SiwcSessionStatus, "usageUrl"> | null): string {
  const fromBackend = status?.usageUrl?.trim();
  return fromBackend && fromBackend.length > 0 ? fromBackend : SIWC_USAGE_URL_FALLBACK;
}

/**
 * 官方 API 端点。**只从后端取**（`siwc.status.apiBase`），前端不硬编码——
 * 写死在 UI 里就是第二个真相源，上游一改就静默把请求打偏。
 * 后端未连通时返回 `null`，调用方据此**不猜**一个 URL 填进去。
 */
export function siwcApiBase(
  status?: Pick<SiwcSessionStatus, "apiBase"> | null,
): string | null {
  const value = status?.apiBase?.trim();
  return value != null && value.length > 0 ? value : null;
}

/**
 * 「Using ChatGPT plan」/ 首次欢迎卡是否可显示。
 *
 * `sharing !== true` 一律不显示——包括 `connecting`（还没定论）与
 * `reauth_required`（凭据已失效）。
 */
export function siwcPlanBadgeVisible(
  status?: Pick<SiwcSessionStatus, "sharing"> | null,
): boolean {
  return status?.sharing === true;
}

/** 需要引导用户重新登录（凭据已失效或已被用户在 ChatGPT 设置里断开）。 */
export function siwcNeedsReauth(
  status?: Pick<SiwcSessionStatus, "status" | "error"> | null,
): boolean {
  if (!status) return false;
  return status.status === "reauth_required" || status.error?.requiresReauth === true;
}

/** 需要把「Manage usage」作为主行动（限流 / 不适用 / 授权上下文不成立）。 */
export function siwcNeedsUsageAction(
  status?: Pick<SiwcSessionStatus, "error"> | null,
): boolean {
  const code = status?.error?.code;
  return typeof code === "string" && USAGE_ACTION_CODES.has(code);
}

/** 暂时性故障：显式提示「稍后重试」，不要引导重登、也不要清状态。 */
export function siwcIsTransient(
  status?: Pick<SiwcSessionStatus, "error"> | null,
): boolean {
  return status?.error?.retryable === true && !siwcNeedsUsageAction(status);
}

/**
 * 探测官方资产是否就位。
 *
 * 缺省（仓库不带资产）= `false` → 用文字按钮；使用者按 BYO 方式放入
 * `public/siwc/` 后才变 `true`。探测失败（离线、协议不支持）按「没有」处理：
 * 拿不到图不该让登录入口消失。
 */
export async function probeSiwcButtonAssets(
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(SIWC_BUTTON_ASSETS.black);
    return response.ok;
  } catch {
    return false;
  }
}

/** 按钮呈现：有官方资产用 SVG，否则纯文字（文案仍是官方指定的那句）。 */
export type SiwcButtonPresentation =
  | { kind: "asset"; src: string; alt: string }
  | { kind: "text"; label: string };

export function siwcButtonPresentation(
  hasAssets: boolean,
  variant: keyof typeof SIWC_BUTTON_ASSETS = "black",
): SiwcButtonPresentation {
  return hasAssets
    ? { kind: "asset", src: SIWC_BUTTON_ASSETS[variant], alt: SIWC_BUTTON_LABEL }
    : { kind: "text", label: SIWC_BUTTON_LABEL };
}
