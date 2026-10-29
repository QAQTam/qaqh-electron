/**
 * 壳断点(spec §4.6):以 #app 的实际宽度为准,不能只看 window.innerWidth——
 * 窗口 chrome、缩放、devtools 停靠都会让内容宽度偏离视口。#app 无法查询自身,
 * 所以用 ResizeObserver 观察 #app,把 3/2/1 列态写成 #app 的 class(cols-3/2/1),
 * CSS 只按 class 分列,不再有媒体查询里的列定义。
 */
import { onSettled } from "solid-js";

export type ShellCols = 1 | 2 | 3;

/** ≥1280 三列;800–1279 两列;<800 单列(spec §4.6 断点表)。 */
export function shellColsFor(width: number): ShellCols {
  if (width >= 1280) return 3;
  if (width >= 800) return 2;
  return 1;
}

/**
 * 观察 #app 宽度。默认把 3/2/1 列态写成 #app 的 cols-N class(非响应式消费方,
 * 如 stress 夹具);Solid 组件传 withClasses:false 只拿回调,列态进信号。
 * 返回清理函数(组件卸载时断开观察,spec §10:只观察 App,不留泄漏)。
 */
export function observeShellCols(
  el: HTMLElement,
  opts: { onChange?: (cols: ShellCols) => void; withClasses?: boolean } = {},
): () => void {
  const { onChange, withClasses = true } = opts;
  const apply = (): void => {
    const cols = shellColsFor(el.clientWidth);
    if (withClasses) {
      el.classList.toggle("cols-3", cols === 3);
      el.classList.toggle("cols-2", cols === 2);
      el.classList.toggle("cols-1", cols === 1);
    }
    onChange?.(cols);
  };
  apply();
  const observer = new ResizeObserver(apply);
  observer.observe(el);
  return () => observer.disconnect();
}

/** Solid 侧便捷封装:在 onSettled 里挂观察(与仓内其它 DOM 测量同规矩)。 */
export function useShellCols(el: () => HTMLElement | null, onChange?: (cols: ShellCols) => void): void {
  onSettled(() => {
    const node = el();
    if (node == null) return;
    return observeShellCols(node, { onChange });
  });
}
