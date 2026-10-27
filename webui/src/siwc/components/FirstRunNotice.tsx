/**
 * 首次成功启用套餐后的**一次性**欢迎卡。
 *
 * 文档：`You're using your ChatGPT plan` + `Got it`，**只在第一次**展示，
 * 之后不再出现。持久化「已看过」由调用方负责（本组件不做存储决策：
 * 它可能是 localStorage、Tauri store 或后端设置，属宿主选择）。
 */
import type { Component } from "solid-js";

import { SIWC_FIRST_RUN_BODY, SIWC_FIRST_RUN_DISMISS, SIWC_FIRST_RUN_TITLE } from "../state";

type Props = {
  open: boolean;
  onDismiss: () => void;
};

export const SiwcFirstRunNotice: Component<Props> = (props) => {
  if (!props.open) return null;
  return (
    <div class="siwc-firstrun" role="dialog" aria-label={SIWC_FIRST_RUN_TITLE}>
      <span class="siwc-firstrun__title">{SIWC_FIRST_RUN_TITLE}</span>
      <p class="siwc-firstrun__body">{SIWC_FIRST_RUN_BODY}</p>
      <button type="button" class="siwc-firstrun__primary" onClick={() => props.onDismiss()}>
        {SIWC_FIRST_RUN_DISMISS}
      </button>
    </div>
  );
};
