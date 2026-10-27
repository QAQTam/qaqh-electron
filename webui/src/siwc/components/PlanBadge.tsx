/**
 * composer 旁的套餐标识行（DevKit 的 "Using ChatGPT plan" + "Manage usage"）。
 *
 * **唯一的显示判据是 `sharing === true`**：只登录未授权套餐时不渲染任何东西——
 * 那是计费事实陈述，不能靠「差不多」蒙过去。判定在 `brand.ts`，这里只做呈现。
 */
import { Show, type Component } from "solid-js";
import IconExternalLink from "~icons/lucide/external-link";

import { siwcPlanBadgeVisible, siwcUsageUrl, type SiwcSessionStatus } from "../brand";

type Props = {
  status: SiwcSessionStatus | null;
  /** 由宿主用系统浏览器打开；缺省走普通新窗口。 */
  onOpenUsage?: (url: string) => void;
};

export const SiwcPlanBadge: Component<Props> = (props) => {
  const url = () => siwcUsageUrl(props.status);
  const open = (): void => {
    if (props.onOpenUsage) props.onOpenUsage(url());
    else window.open(url(), "_blank", "noopener");
  };

  return (
    <Show when={siwcPlanBadgeVisible(props.status)}>
      <div class="siwc-plan-row" role="status">
        <span class="siwc-plan-row__label">Using ChatGPT plan</span>
        <button type="button" class="ghost-mini" onClick={open} title={url()}>
          <span>Manage usage</span>
          <IconExternalLink />
        </button>
      </div>
    </Show>
  );
};
