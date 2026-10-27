/**
 * 字符级流光文本(opencode `TextShimmer` 同款机制,按本仓 token 适配):
 * 双层同文叠加 —— 基线层正常着色,流光层用 `background-clip: text` 让高光
 * 渐变贴着字形扫过,而不是外联一块背景横条(::after overlay)。
 *
 * 相比旧 `.tool-summary.is-shimmer::after` 方案:
 *  - 高光落在字形上而不是文本块上,观感是「字符在亮」;
 *  - 不再给每行都挂 `will-change: transform`(每行一层合成层,工具行多时
 *    直接吃掉帧预算——旧实现卡顿的主因);动画只改 background-position,
 *    作用域限于这一小段文字的绘制层;
 *  - linear 匀速扫描,没有 ease 的起停顿挫;
 *  - `data-run=false`(非最新/已结束)时动画完全停止,零常驻成本。
 */
import { createMemo, type Component } from "solid-js";

export const TextShimmer: Component<{ text: string; active?: boolean; class?: string }> = (props) => {
  const active = createMemo(() => props.active ?? false);
  return (
    <span class={["text-shimmer", props.class]} data-active={active() ? "true" : "false"} aria-label={props.text}>
      <span class="text-shimmer-base">{props.text}</span>
      <span class="text-shimmer-glow" data-run={active() ? "true" : "false"} aria-hidden="true">{props.text}</span>
    </span>
  );
};
