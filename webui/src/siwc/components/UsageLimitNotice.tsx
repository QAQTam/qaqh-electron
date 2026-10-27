/**
 * 用量上限态（DevKit 的 usage-limit modal/compact 卡的 Solid 对应物）。
 *
 * 文档要求：**Manage usage 是主行动**；不得推断额度为空、也不得凭错误码推断重置时间。
 * 若应用自有额度，次级行动由调用方以 `onBuyCredits` 注入（本组件不假设存在）。
 */
import { Show, type Component } from "solid-js";
import IconExternalLink from "~icons/lucide/external-link";

import { siwcNeedsUsageAction, siwcUsageUrl, type SiwcSessionStatus } from "../brand";
import { SIWC_LIMIT_ACTION, SIWC_LIMIT_BODY, SIWC_LIMIT_TITLE } from "../state";

type Props = {
  status: SiwcSessionStatus | null;
  onOpenUsage?: (url: string) => void;
  /** 可选的次级行动（应用自有额度）。缺省不渲染。 */
  onBuyCredits?: () => void;
};

export const SiwcUsageLimitNotice: Component<Props> = (props) => {
  const url = () => siwcUsageUrl(props.status);
  const open = (): void => {
    if (props.onOpenUsage) props.onOpenUsage(url());
    else window.open(url(), "_blank", "noopener");
  };

  return (
    <Show when={siwcNeedsUsageAction(props.status)}>
      <div class="siwc-limit" role="alertdialog" aria-label={SIWC_LIMIT_TITLE}>
        <span class="siwc-limit__title">{SIWC_LIMIT_TITLE}</span>
        <p class="siwc-limit__body">{SIWC_LIMIT_BODY}</p>
        <div class="siwc-limit__actions">
          <button type="button" class="siwc-limit__primary" onClick={open}>
            <span>{SIWC_LIMIT_ACTION}</span>
            <IconExternalLink />
          </button>
          <Show when={props.onBuyCredits}>
            <button type="button" class="ghost-mini" onClick={() => props.onBuyCredits?.()}>
              购买应用额度
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};
