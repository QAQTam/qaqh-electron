/**
 * 封箱 / 开箱**仪式**（大盒版，ui/box-anim 的放大演出）。
 *
 * SealRitual —— 交接正文化作一张纸丢进大盒 → 合盖 → 勾描出 → 大盒飞回卡头
 * 真槽位（WAAPI 读 `.handoff-icon` 实测矩形，跨主题不猜坐标）→ 遮罩淡出即卡现。
 * OpenRitual —— 静置封好的大盒：勾淡 → 掀盖 → 纸升起展开 → 遮罩淡出。
 *
 * 闸门与 box-anim 同纪律：timeline.css 对 theme-lite / zen-console /
 * reduced-motion 把 `.handoff-ritual` 整层 `display:none`；JS 侧探测到
 * display:none 就跳过落位 WAAPI 并立刻 onDone 卸载，零残留。
 */
import { onCleanup, type Component } from "solid-js";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

const SEAL_MS = 2_450; // 覆盖 CSS 2.3s 时间线 + 淡出尾
const OPEN_MS = 1_800;

const gateOff = (el: HTMLDivElement): boolean => getComputedStyle(el).display === "none";

/** 封箱仪式：纸入盒 → 封 → 落位 → 卸。onDone 由父组件收掉信号、卸载遮罩。 */
export const SealRitual: Component<{ onDone?: () => void }> = (props) => {
  let root!: HTMLDivElement;
  let box!: HTMLDivElement;
  // rc.13 起 onMount 不再是 solid-js 导出;组件体即挂载钩子(同 settings/dev/MemoryPanel
  // 惯例)。返回的 JSX 在同一个渲染批次里同步插进文档,所以微任务时读矩形是安全的。
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { disposed = true; if (timer != null) clearTimeout(timer); });
  queueMicrotask(() => {
    if (disposed) return;
    if (gateOff(root)) { props.onDone?.(); return; }
    // 落位段：大盒挪到卡头真槽位。槽位矩形是运行时事实，几何变化不脱靶。
    const slot = root.closest(".handoff-card")?.querySelector<HTMLElement>(".handoff-icon");
    if (slot != null) {
      const from = box.getBoundingClientRect();
      const to = slot.getBoundingClientRect();
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const scale = Math.max(to.width / from.width, 0.18);
      box.animate(
        [
          { transform: "translateX(-50%) scale(1) rotate(0deg)", offset: 0 },
          { transform: `translateX(-50%) translate(${dx * 0.5}px, ${dy * 0.5 - 22}px) scale(${(1 + scale) / 2}) rotate(-6deg)`, offset: 0.5 },
          { transform: `translateX(-50%) translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)`, offset: 1 },
        ],
        { duration: 620, delay: 1_560, easing: "cubic-bezier(.2,0,0,1)", fill: "forwards" },
      );
    }
    timer = setTimeout(() => props.onDone?.(), SEAL_MS);
  });
  return (
    <div class="handoff-ritual bxr-seal" ref={root} aria-hidden="true">
      <div class="bxr-stage">
        <div class="bxr-paper"><i /><i /><i /><i /></div>
        <div class="bxr-box" ref={box}>
          <svg viewBox="0 0 24 24" {...stroke}>
            <path d="M4 9h16v12H4z" />
            <path class="bx-lid bx-lid-l" d="M4 9 11 5" />
            <path class="bx-lid bx-lid-r" d="M20 9 13 5" />
            <path class="bx-check" d="m8.5 15.5 2.5 2.5 4.5-5" />
          </svg>
        </div>
      </div>
    </div>
  );
};

/** 开箱仪式：封盒 → 勾淡 → 掀盖 → 纸升 → 卸。 */
export const OpenRitual: Component<{ onDone?: () => void }> = (props) => {
  let root!: HTMLDivElement;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { disposed = true; if (timer != null) clearTimeout(timer); });
  queueMicrotask(() => {
    if (disposed) return;
    if (gateOff(root)) { props.onDone?.(); return; }
    timer = setTimeout(() => props.onDone?.(), OPEN_MS);
  });
  return (
    <div class="handoff-ritual bxr-open" ref={root} aria-hidden="true">
      <div class="bxr-stage">
        <div class="bxr-box">
          <svg viewBox="0 0 24 24" {...stroke}>
            <path d="M4 9h16v12H4z" />
            <path class="bx-lid bx-lid-l" d="M4 9 11 5" />
            <path class="bx-lid bx-lid-r" d="M20 9 13 5" />
            <path class="bx-check" d="m8.5 15.5 2.5 2.5 4.5-5" />
          </svg>
        </div>
        <div class="bxr-paper"><i /><i /><i /><i /></div>
      </div>
    </div>
  );
};
