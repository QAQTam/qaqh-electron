/**
 * ChatGPT 账户卡（设置页/账户菜单）：账户身份 + 连接状态 + 用量入口。
 *
 * **合规要点**（由 `state.ts` 判定，本组件只呈现）：
 * 「已登录但未授权套餐用量」必须显示成「已登录 · 套餐用量未启用」，
 * 而不是「已连接」——后者会让用户以为请求会计入套餐。
 */
import { Show, type Component } from "solid-js";
import IconExternalLink from "~icons/lucide/external-link";

import type { SiwcSessionStatus } from "../brand";
import { siwcAccountView } from "../state";
import { SiwcSignInButton } from "./SignInButton";

type Props = {
  status: SiwcSessionStatus | null;
  busy?: boolean;
  /** 接入页由服务商摘要行提供登录与取消入口，详情不重复呈现。 */
  hideSignInActions?: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut?: () => void;
  /** 由宿主用系统浏览器打开（Tauri: `open_external`）；缺省走普通链接。 */
  onOpenUsage?: (url: string) => void;
};

export const SiwcConnectionCard: Component<Props> = (props) => {
  const view = () => siwcAccountView(props.status);

  return (
    <div class="siwc-card">
      <div class="siwc-card__head">
        <span class="siwc-card__title">{view().title}</span>
        <Show when={view().showPlanBadge}>
          <span class="siwc-badge siwc-badge--plan">Using ChatGPT plan</span>
        </Show>
      </div>
      <p class="siwc-card__body">{view().subtitle}</p>
      <Show when={view().error}>
        {(message) => <p class="siwc-card__error">{message()}</p>}
      </Show>

      <div class="siwc-card__actions">
        <Show when={!props.hideSignInActions && (view().kind === "disconnected" || view().kind === "reauth-required")}>
          <SiwcSignInButton disabled={props.busy === true} onPress={() => props.onSignIn()} />
        </Show>
        <Show when={!props.hideSignInActions && view().kind === "connecting"}>
          <button type="button" class="ghost-mini" onClick={() => props.onCancel()}>
            {view().action}
          </button>
        </Show>
        <Show when={!props.hideSignInActions && view().kind === "identity-only"}>
          <SiwcSignInButton disabled={props.busy === true} onPress={() => props.onSignIn()} />
        </Show>
        <Show when={view().kind === "plan" && !view().usageActionPrimary}>
          <Show when={props.onSignOut}>
            <button type="button" class="ghost-mini" onClick={() => props.onSignOut?.()}>
              断开连接
            </button>
          </Show>
        </Show>
        <Show when={view().usageUrl}>
          {(url) => {
            const open = (): void => {
              if (props.onOpenUsage) props.onOpenUsage(url());
              else window.open(url(), "_blank", "noopener");
            };
            return (
              <button
                type="button"
                class="ghost-mini siwc-usage-link"
                onClick={open}
                title={url()}
              >
                <Show when={view().usageActionPrimary}>
                  <span>Manage usage</span>
                </Show>
                <Show when={!view().usageActionPrimary}>
                  <span>管理用量</span>
                </Show>
                <IconExternalLink />
              </button>
            );
          }}
        </Show>
      </div>
    </div>
  );
};
