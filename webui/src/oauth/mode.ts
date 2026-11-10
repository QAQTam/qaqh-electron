/**
 * 账号额度的判定——接入页、设置页与输入区共用。
 *
 * 凭据来源是 provider 目录（providers.toml）里的 `credential`：`chatgpt_plan` =
 * 本机 ChatGPT 套餐，`deepseek_account` = 本机 DeepSeek 账号余额，`api_key` = BYOK。
 * ConfigDto 已不再携带端点族字段（ringing-commands-7 起真源是 provider.* 命令面），
 * 这里只做归类，不碰 DOM、store 或写路径。
 */

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
 * 会话 meta / provider 目录只带凭据来源，而模型目录/档位特判按 provider 类别
 * 归口（`./model-catalog`）。会话选了别的 provider 时，用户看到的能力必须按
 * **那个 provider** 算，不能拿全局默认项的凭据冒充。
 */
export function providerKindOfCredential(
  credential: string | null | undefined,
): ProviderKind {
  if (credential === "chatgpt_plan") return "plan";
  if (credential === "deepseek_account") return "account";
  return "byok";
}

/** 凭据判定入参：任何携带 `credential` 的读模型（provider 目录行等）都满足。 */
export type CredentialCarrier = { credential?: string | null };

/** 是否是**套餐**模式（本函数的老名字叫 `isOauthMode`：它只回答"是不是套餐"）。 */
export function isPlanMode(
  config: CredentialCarrier | null | undefined,
): boolean {
  return config?.credential === "chatgpt_plan";
}

/** 是否是 **DeepSeek 账号**模式。 */
export function isDeepseekAccountMode(
  config: CredentialCarrier | null | undefined,
): boolean {
  return config?.credential === "deepseek_account";
}

/**
 * 是否用的是**账号类**额度（套餐或 DeepSeek 账号）：两者都不用 API key，
 * 但**各有各的 wire 与官方端点**——调用方别拿这一个判断去套另一家的规则。
 */
export function isAccountCredential(
  config: CredentialCarrier | null | undefined,
): boolean {
  return isPlanMode(config) || isDeepseekAccountMode(config);
}
