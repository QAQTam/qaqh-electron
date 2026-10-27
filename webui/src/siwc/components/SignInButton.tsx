/**
 * 「Continue with ChatGPT」按钮（DevKit `@siwc/react` 的 Solid 对应物）。
 *
 * 两条口径：
 * - 文案只用官方指定的 `Continue with ChatGPT`（来自 `brand.ts`，不在组件里另写）；
 * - 官方资产缺失时（**默认**）渲染纯文字按钮——功能不依赖资产，
 *   见 `public/siwc/README.md`。
 */
import { Show, type Component } from "solid-js";

import { siwcButtonPresentation, type SiwcButtonPresentation } from "../brand";

type Props = {
  /** 由 `probeSiwcButtonAssets()` 决定；缺省 = 文字按钮。 */
  presentation?: SiwcButtonPresentation;
  disabled?: boolean;
  fullWidth?: boolean;
  onPress: () => void;
};

export const SiwcSignInButton: Component<Props> = (props) => {
  const view = (): SiwcButtonPresentation =>
    props.presentation ?? siwcButtonPresentation(false);
  const label = (): string => {
    const v = view();
    return v.kind === "asset" ? v.alt : v.label;
  };
  const assetSrc = (): string | null => {
    const v = view();
    return v.kind === "asset" ? v.src : null;
  };

  return (
    <button
      type="button"
      class={props.fullWidth === true ? "siwc-signin siwc-signin--block" : "siwc-signin"}
      disabled={props.disabled === true}
      onClick={() => props.onPress()}
    >
      <Show when={assetSrc()}>
        {(src) => <img class="siwc-signin__mark" src={src()} alt="" />}
      </Show>
      <span class="siwc-signin__label">{label()}</span>
    </button>
  );
};
