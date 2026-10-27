/**
 * Fluent ToolTip：500ms 延迟、无箭头、4px 圆角、12px 文本。
 *
 * 只替换"只有图标、需要文字解释"的按钮；正文里的 title 暂不动，避免把
 * 一个纯展示属性升级成每个节点都挂一层 popper。
 */
import { type Component } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Tooltip as KTooltip } from "@kobalte/core/tooltip";

export const TooltipButton: Component<{
  label: string;
  placement?: "top" | "bottom" | "left" | "right";
  class?: string;
  children: JSX.Element;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  "aria-label"?: string;
  "aria-current"?: "page";
  type?: "button";
}> = (props) => (
  <KTooltip openDelay={500} closeDelay={80} placement={props.placement ?? "top"}>
    <KTooltip.Trigger
      as="button"
      type={props.type ?? "button"}
      class={props.class}
      aria-label={props["aria-label"]}
      aria-current={props["aria-current"]}
      onClick={props.onClick}
    >
      {props.children}
    </KTooltip.Trigger>
    <KTooltip.Portal>
      <KTooltip.Content class="fluent-tooltip">{props.label}</KTooltip.Content>
    </KTooltip.Portal>
  </KTooltip>
);
