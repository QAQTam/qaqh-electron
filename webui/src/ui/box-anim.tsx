/**
 * 封箱 / 开箱动画盒（Lucide 描线风手写 SVG，CSS keyframes 驱动）。
 *
 * 几何：盒体 24×24 视野；两侧盖板是绕盒顶角铰接的线段——
 *   闭合姿态 左(4,9)→(11,5) / 右(20,9)→(13,5)，
 *   敞开姿态 = 各自绕铰链外旋 75°（rotate(∓75deg)，transform-box: view-box）。
 * 姿态哲学：**基态 = 终态**。封箱不播动画就静置"闭盒+对勾"，开箱静置"掀盖+升签"；
 * 入场动画用 fill-mode: both 把首帧拉回起点播一遍。
 * reduced-motion / lite / zen-console 把 animation 关掉即自然得到正确静态画，不需要第二套姿态。
 */
import type { Component } from "solid-js";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

const cls = (base: string, extra?: string): string => (extra ? `${base} ${extra}` : base);

/** 封箱：盖板从敞开合拢 → 对勾描出（交接工具成功 = handed_off:true 的画形）。 */
export const BoxSeal: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" class={cls("qaqh-box-icon qaqh-box-seal", props.class)} aria-hidden="true" {...stroke}>
    <path d="M4 9h16v12H4z" />
    <path class="bx-lid bx-lid-l" d="M4 9 11 5" />
    <path class="bx-lid bx-lid-r" d="M20 9 13 5" />
    <path class="bx-check" d="m8.5 15.5 2.5 2.5 4.5-5" />
  </svg>
);

/** 开箱：盖板从闭合掀起 → 交接内容自盒中升起（B 侧首输入的画形）。 */
export const BoxOpen: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 24 24" class={cls("qaqh-box-icon qaqh-box-open", props.class)} aria-hidden="true" {...stroke}>
    <path d="M4 9h16v12H4z" />
    <path class="bx-lid bx-lid-l" d="M4 9 11 5" />
    <path class="bx-lid bx-lid-r" d="M20 9 13 5" />
    <g class="bx-spark">
      <path d="M12 7V2" />
      <path d="m9 4.5 3-3 3 3" />
    </g>
  </svg>
);
