/**
 * DeepSeek 账号卡（接入页）：账号状态 + **金额面**（充值 / 赠金 / 累计消费）+ 直链。
 *
 * 外观**复用 OpenAI 那张卡的类**（`siwc-card*` / `siwc-badge` / `ghost-mini`）：
 * 同一页里两族的卡片必须长得一样，另起一套样式只会慢慢分叉。本模块只补金额行
 * 那一小块（`dsaccount-*`，见 `styles/components/dsaccount.css`）。
 *
 * 合规与状态判定全在 `../state.ts`（本组件只呈现）：尤其
 * 「本地凭据损坏」必须与「未登录」分开说——前者要提示重新登录。
 */
import { For, Show, type Component } from "solid-js";
import IconExternalLink from "~icons/lucide/external-link";

import type { DsBalance } from "../../lib/dsaccount";
import {
  dsAccountView,
  dsRevokeNotice,
  dsVerifyNotice,
  formatAmount,
  isPositive,
  type DsAccountStatus,
  type DsVerifyResult,
} from "../state";

type Props = {
  status: DsAccountStatus | null;
  balance: DsBalance | null;
  /** 本组件发起的动作还在跑（按钮置灰）。 */
  busy?: boolean;
  /** 接入页的登录和取消入口位于服务商摘要行。 */
  hideSignInActions?: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  /** 刷新 = 验证：问一次远端"这把凭据还有效吗"。 */
  onVerify: () => void;
  verifyBusy?: boolean;
  /** 上一次验证的结果（null / 缺省 = 还没验过）。 */
  verify?: DsVerifyResult | null;
  /** 由宿主用系统浏览器打开（Tauri: `open_external`）；缺省走普通链接。 */
  onOpenLink?: (url: string) => void;
};

export const DsAccountCard: Component<Props> = (props) => {
  const view = () => dsAccountView(props.status);
  const recharge = () => props.balance?.recharge ?? [];
  const bonus = () => props.balance?.bonus ?? [];
  const totals = () => props.balance?.totalCost ?? [];

  /**
   * 余额是否**已知**为空：解析不出的金额既不算有也不算没有（`isPositive` 返回
   * `null`），所以只有"每个钱包都能解析且都不为正"才给充值提示。
   */
  const knownEmpty = (): boolean => {
    const wallets = [...recharge(), ...bonus()];
    return wallets.length > 0 && wallets.every((wallet) => isPositive(wallet.balance) === false);
  };

  const open = (url: string): void => {
    if (props.onOpenLink) props.onOpenLink(url);
    else window.open(url, "_blank", "noopener");
  };

  return (
    <div class="siwc-card">
      <div class="siwc-card__head">
        <span class="siwc-card__title">{view().title}</span>
        <Show when={view().kind === "signed-in"}>
          <span class="siwc-badge siwc-badge--plan">DeepSeek 账号</span>
        </Show>
      </div>
      <p class="siwc-card__body">{view().subtitle}</p>
      <Show when={view().error}>
        {(message) => <p class="siwc-card__error">{message()}</p>}
      </Show>
      <Show when={dsVerifyNotice(props.verify)}>
        {(text) => <p class="siwc-card__error">{text()}</p>}
      </Show>

      <Show when={view().kind === "signed-in" && props.balance}>
        <dl class="dsaccount-rows">
          <For each={recharge()}>
            {(wallet) => (
              <div class="dsaccount-row">
                <dt class="dsaccount-row__label">充值余额</dt>
                <dd class="dsaccount-row__value">
                  {formatAmount(wallet.balance)} {wallet.currency}
                </dd>
              </div>
            )}
          </For>
          <For each={bonus()}>
            {(wallet) => (
              <div class="dsaccount-row">
                <dt class="dsaccount-row__label">赠金</dt>
                <dd class="dsaccount-row__value">
                  {formatAmount(wallet.balance)} {wallet.currency}
                </dd>
              </div>
            )}
          </For>
          <For each={totals()}>
            {(cost) => (
              <div class="dsaccount-row">
                <dt class="dsaccount-row__label">累计消费</dt>
                <dd class="dsaccount-row__value">
                  {formatAmount(cost.amount)} {cost.currency}
                </dd>
              </div>
            )}
          </For>
        </dl>
        <Show when={knownEmpty()}>
          <p class="dsaccount-row__hint">账号余额为 0：充值后即可用账号额度推理。</p>
        </Show>
      </Show>

      <Show when={dsRevokeNotice(props.status?.revoke ?? null)}>
        {(notice) => <p class="field-hint">{notice()}</p>}
      </Show>
      <div class="siwc-card__actions">
        <Show when={!props.hideSignInActions && view().canSignIn}>
          <button
            type="button"
            class="siwc-signin"
            disabled={props.busy === true}
            onClick={() => props.onSignIn()}
          >
            {view().kind === "damaged" ? "重新登录 DeepSeek 账号" : "登录 DeepSeek 账号"}
          </button>
        </Show>
        <Show when={!props.hideSignInActions && view().canCancel}>
          <button type="button" class="ghost-mini" onClick={() => props.onCancel()}>
            取消登录
          </button>
        </Show>
        <Show when={view().canSignOut}>
          <button type="button" class="ghost-mini" onClick={() => props.onSignOut()}>
            断开连接
          </button>
        </Show>
        <Show when={view().kind === "signed-in"}>
          {/*
            刷新 = **验证**：本地有密文不等于凭据还有效（平台侧撤销之后本地仍是
            "已登录"的样子）。失效时后端顺手清凭据，这里只要重读一遍状态。
          */}
          <button
            type="button"
            class="ghost-mini"
            disabled={props.verifyBusy === true}
            onClick={() => props.onVerify()}
          >
            {props.verifyBusy === true ? "验证中…" : "刷新"}
          </button>
          <Show when={props.status?.usageUrl}>
            {(url) => (
              <button
                type="button"
                class="ghost-mini siwc-usage-link"
                onClick={() => open(url())}
                title={url()}
              >
                <span>用量明细</span>
                <IconExternalLink />
              </button>
            )}
          </Show>
          <Show when={props.status?.topUpUrl}>
            {(url) => (
              <button
                type="button"
                class="ghost-mini siwc-usage-link"
                onClick={() => open(url())}
                title={url()}
              >
                <span>充值</span>
                <IconExternalLink />
              </button>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
};
