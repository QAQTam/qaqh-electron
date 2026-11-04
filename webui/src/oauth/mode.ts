/**
 * 账号额度的判定——接入页、设置页与输入区共用。
 *
 * 凭据来源本身就是配置契约里的 `credential`：`chatgpt_plan` = 本机 ChatGPT 套餐，
 * `deepseek_account` = 本机 DeepSeek 账号余额，`api_key` = BYOK。这里只做归类，
 * 不碰 DOM、store 或写路径。
 */
import type { ConfigDto } from "../api/qaqh/ConfigDto";

/** provider 类别：模型目录与档位特判按它归口。 */
export type ProviderKind = "byok" | "plan" | "account";

/**
 * 凭据来源的三个取值（与 `qaqh_types::CredentialSource` 的 serde 表示同源）：
 * `api_key` = BYOK；`chatgpt_plan` = 本机 ChatGPT 套餐；`deepseek_account` =
 * 本机 DeepSeek 账号余额。
 */
export type CredentialSource = "api_key" | "chatgpt_plan" | "deepseek_account";

/**
 * 凭据来源字符串 → 前端 provider 类别。
 *
 * Profile 摘要（`ProfileSummaryDto.credential`）与会话 meta 只带凭据来源，
 * 而模型目录/档位特判按 provider 类别归口（`./model-catalog`）。会话选了
 * 别的 Profile 时，用户看到的能力必须按**那个 Profile 的 provider** 算，
 * 不能拿全局活跃项的凭据冒充。
 */
export function providerKindOfCredential(
  credential: string | null | undefined,
): ProviderKind {
  if (credential === "chatgpt_plan") return "plan";
  if (credential === "deepseek_account") return "account";
  return "byok";
}

/** 是否是**套餐**模式（本函数的老名字叫 `isOauthMode`：它只回答"是不是套餐"）。 */
export function isPlanMode(
  config: Pick<ConfigDto, "credential"> | null | undefined,
): boolean {
  return config?.credential === "chatgpt_plan";
}

/** 是否是 **DeepSeek 账号**模式。 */
export function isDeepseekAccountMode(
  config: Pick<ConfigDto, "credential"> | null | undefined,
): boolean {
  return config?.credential === "deepseek_account";
}

/**
 * 是否用的是**账号类**额度（套餐或 DeepSeek 账号）：两者都不用 API key，
 * 但**各有各的 wire 与官方端点**——调用方别拿这一个判断去套另一家的规则。
 */
export function isAccountCredential(
  config: Pick<ConfigDto, "credential"> | null | undefined,
): boolean {
  return isPlanMode(config) || isDeepseekAccountMode(config);
}
