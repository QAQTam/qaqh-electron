/**
 * DeepSeek 账号（账号余额）的壳命令封装。
 *
 * 与 `siwc.ts` 同一分工：**HTTP 与凭据都留在 Rust 侧**，前端只拿状态投影
 * （结构上不含 token）与一个需要交给系统浏览器打开的授权 URL。
 *
 * 八个方法的清单是 daemon 服务面（`qaqh_dsaccount::methods::ALL`）的镜像；
 * 壳侧白名单（`src-tauri/src/commands.rs::SERVICE_METHODS`）也要同步加。
 */
import { serviceRpc } from "./service-rpc";
import { openExternalUrl } from "./transport";
import type { DsSignInDeps, DsSignInStart } from "../dsaccount/flow";
import type { DsAccountStatus, DsFlowProjection, DsVerifyResult } from "../dsaccount/state";

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

export const dsaccountStatus = (): Promise<DsAccountStatus> => serviceRpc("DeepSeek 账号", "dsaccount.status");

export const dsaccountBalance = (): Promise<DsBalance> => serviceRpc("DeepSeek 账号", "dsaccount.balance");

export const dsaccountBonuses = (): Promise<DsBonus[]> => serviceRpc("DeepSeek 账号", "dsaccount.bonuses");

export const dsaccountSignInStart = (
  options: { locale?: string; port?: number } = {},
): Promise<DsSignInStart> =>
  serviceRpc("DeepSeek 账号", "dsaccount.sign_in.start", {
    ...(options.locale == null ? {} : { locale: options.locale }),
    ...(options.port == null ? {} : { port: options.port }),
  });

export const dsaccountSignInStatus = (): Promise<DsFlowProjection> =>
  serviceRpc("DeepSeek 账号", "dsaccount.sign_in.status");

export const dsaccountSignInCancel = (attemptId: string): Promise<null> =>
  serviceRpc("DeepSeek 账号", "dsaccount.sign_in.cancel", { attempt_id: attemptId });

export const dsaccountSignOut = (): Promise<null> => serviceRpc("DeepSeek 账号", "dsaccount.sign_out");

export const dsaccountAckBonus = (orderId: string): Promise<null> =>
  serviceRpc("DeepSeek 账号", "dsaccount.bonus.ack", { order_id: orderId });

/**
 * 模型目录条目。与 `SiwcModelEntry` 同形（选择器共用一套渲染），键名映射在下面。
 */
export interface DsModelEntry {
  slug: string;
  displayName: string;
}

/**
 * 账号可用的模型目录。
 *
 * 后端**原样**转发平台的条目（比 OpenAI 标准形态多几个字段：上下文窗口、输出
 * 上限、能力位、`effort.supported_levels`），这里只取能确认的两个键——`id` 是
 * 标准形态，展示名按几个常见写法兜底；取不到展示名就用 slug（**不猜**）。
 */
export async function dsaccountModels(): Promise<DsModelEntry[]> {
  const entries = await serviceRpc<Record<string, unknown>[]>("DeepSeek 账号", "dsaccount.models");
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  return entries.flatMap((entry) => {
    const slug = text(entry.id);
    if (slug == null) return [];
    const displayName =
      text(entry.display_name) ?? text(entry.displayName) ?? text(entry.name) ?? slug;
    return [{ slug, displayName }];
  });
}

/**
 * 验证凭据现在还有效吗（读一次只读远端）。
 *
 * 失效时**后端会顺手清掉本地凭据**（`cleared: true`），所以调用方拿到结果后
 * 要把状态与余额都重新读一遍，别让界面停留在"已登录"上。
 */
export const dsaccountVerify = (): Promise<DsVerifyResult> =>
  serviceRpc("DeepSeek 账号", "dsaccount.verify");

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
