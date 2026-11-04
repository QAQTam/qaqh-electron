/**
 * DeepSeek 账号（账号余额）的壳命令封装。
 *
 * 与 `siwc.ts` 同一分工：**HTTP 与凭据都留在 Rust 侧**，前端只拿状态投影
 * （结构上不含 token）与一个需要交给系统浏览器打开的授权 URL。
 *
 * 命令面是 RingingV2 的 `dsaccount.*` 统一命令。
 */
import type { ServiceMethod, ServiceParams, ServiceResult } from "./transport/backend";
import { isDesktopRuntime } from "./transport/backend";
import { openExternalUrl, transport } from "./transport";
import type { DsSignInDeps, DsSignInStart } from "../dsaccount/flow";
import type { DsAccountStatus, DsFlowProjection, DsVerifyResult } from "../dsaccount/state";
import type { DsAccountModel } from "../api/qaqh/DsAccountModel";

/** 一个钱包条目。金额是**原串**（平台用 big.js 语法：`0E-16` 就是 0）。 */
export interface DsWallet {
  currency: string;
  balance: string;
  /** 额度折算（参照实现没解析这个字段，我们收下了）。 */
  tokenEstimation?: string | null;
}

export interface DsTotalCost {
  currency: string;
  amount: string;
}

/** `dsaccount.balance` 的投影。 */
export interface DsBalance {
  recharge: DsWallet[];
  bonus: DsWallet[];
  totalCost: DsTotalCost[];
  /** 充值与赠金里是否任一为正（解析不出余额时**不算**负数）。 */
  hasUsableBalance: boolean;
}

/** `dsaccount.bonuses` 的条目。 */
export interface DsBonus {
  orderId: string;
  campaign: string;
  amount: string;
  currency: string;
  grantedAt: string;
  expiresAt: string;
  /** 服务端文案（本地化由平台负责）。 */
  message: string;
}

export type { DsSignInStart };

async function query<K extends ServiceMethod>(method: K, params: ServiceParams<K>): Promise<ServiceResult<K>> {
  if (!isDesktopRuntime()) {
    throw new Error("DeepSeek 账号需要桌面壳：浏览器预览下不可用");
  }
  return transport.query(method, params);
}

export const dsaccountStatus = (): Promise<DsAccountStatus> => query("dsaccount.status", {});

export const dsaccountBalance = (): Promise<DsBalance> => query("dsaccount.balance", {});

export const dsaccountBonuses = (): Promise<DsBonus[]> => query("dsaccount.bonuses", {});

export const dsaccountSignInStart = (
  options: { locale?: string; port?: number } = {},
): Promise<DsSignInStart> =>
  query("dsaccount.sign_in.start", {
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });

export const dsaccountSignInStatus = async (): Promise<DsFlowProjection> => {
  const value = await query("dsaccount.sign_in.status", {});
  return {
    attemptId: value.attempt_id,
    state: value.state,
    authorizeUrl: value.authorize_url,
    expiresAtMs: value.expires_at_ms,
    error: value.error,
  };
};

export const dsaccountSignInCancel = (attemptId: string): Promise<null> =>
  query("dsaccount.sign_in.cancel", { attempt_id: attemptId });

export const dsaccountSignOut = (): Promise<null> => query("dsaccount.sign_out", {});

export const dsaccountAckBonus = (orderId: string): Promise<null> =>
  query("dsaccount.bonus.ack", { order_id: orderId });

/**
 * 模型目录条目。与 `SiwcModelEntry` 同形（选择器共用一套渲染），键名映射在下面。
 */
export interface DsModelEntry {
  slug: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningLevels?: string[];
  defaultEffort?: string;
}

const positiveSafeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const mapModel = (entry: DsAccountModel): DsModelEntry => {
  const effort = recordOf(entry["effort"]);
  const supported = effort?.["supported_levels"];
  const reasoningLevels = Array.isArray(supported) && supported.every((level) => typeof level === "string")
    ? supported as string[]
    : undefined;
  const defaultEffort = typeof effort?.["default_level"] === "string" ? effort["default_level"] : undefined;
  const contextWindow = positiveSafeInteger(entry["context_window"]);
  const maxOutputTokens = positiveSafeInteger(entry["max_output_tokens"]);
  return {
    slug: entry.id,
    displayName: entry.id,
    ...(contextWindow == null ? {} : { contextWindow }),
    ...(maxOutputTokens == null ? {} : { maxOutputTokens }),
    ...(reasoningLevels == null ? {} : { reasoningLevels }),
    ...(defaultEffort == null ? {} : { defaultEffort }),
  };
};

/**
 * 账号可用的模型目录。
 *
 * 后端**原样**转发平台的条目（上下文窗口、输出上限、能力位、推理档位）。这里只
 * 映射 id 和我们实际使用的数值/档位字段；字段缺失时保持缺省，不猜上下文或上限。
 */
export async function dsaccountModels(): Promise<DsModelEntry[]> {
  const entries = await query("dsaccount.models", {});
  return entries.map(mapModel);
}

/**
 * 验证凭据现在还有效吗（读一次只读远端）。
 *
 * 失效时**后端会顺手清掉本地凭据**（`cleared: true`），所以调用方拿到结果后
 * 要把状态与余额都重新读一遍，别让界面停留在"已登录"上。
 */
export const dsaccountVerify = (): Promise<DsVerifyResult> =>
  query("dsaccount.verify", {});

/** 流程驱动本体在 `../dsaccount/flow`（纯逻辑，依赖注入，可脱浏览器单测）。 */
export { runDeepSeekSignIn } from "../dsaccount/flow";
export type { DsSignInDeps, DsSignInOutcome, DsFlowSnapshot } from "../dsaccount/flow";

/** 真依赖：壳的系统浏览器打开 + 墙钟 + sleep。 */
export const defaultDsSignInDeps: DsSignInDeps = {
  start: dsaccountSignInStart,
  status: dsaccountSignInStatus,
  cancel: dsaccountSignInCancel,
  openExternal: (url) => openExternalUrl(url),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
