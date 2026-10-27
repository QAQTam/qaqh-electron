/** 展开收起容器(spec §13.2):grid-template-rows 0fr↔1fr + opacity。
 *  折叠时不挂载内容——一个会话的时间线/工具详情有数百 KB 文本与 diff,
 *  启动即全量挂载是首屏卡顿与常驻内存的主因;收起动画播完后再卸载。
 *  事件驱动生命周期:由 transitionend 触发卸载,减少硬编码定时器等待。 */
import { createEffect, createSignal, onCleanup, Show, untrack, type ParentComponent } from "solid-js";

/** 兜底超时(略高于 CSS --dur-out: 140ms),确保异常断帧时子树仍能安全释放。 */
const SAFETY_FALLBACK_MS = 180;

export const Collapse: ParentComponent<{ open: boolean; instant?: boolean }> = (props) => {
  const [mounted, setMounted] = createSignal(untrack(() => props.open));
  let root: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onTransitionEnd: ((e: TransitionEvent) => void) | null = null;

  const cleanupListeners = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (onTransitionEnd != null && root != null) {
      root.removeEventListener("transitionend", onTransitionEnd);
      onTransitionEnd = null;
    }
  };

  createEffect(
    () => [props.open, props.instant ?? false] as const,
    ([open, instant]) => {
      cleanupListeners();

      if (open) {
        setMounted(true);
        return;
      }

      if (!untrack(mounted)) return;

      if (instant) {
        setMounted(false);
        return;
      }

      // 优先依赖原生 transitionend 事件,动画播完立刻卸载(reduced-motion 下 0.01ms 瞬时响应)
      const finish = (): void => {
        cleanupListeners();
        setMounted(false);
      };

      onTransitionEnd = (e: TransitionEvent): void => {
        if (e.target === root && (e.propertyName === "grid-template-rows" || e.propertyName === "opacity")) {
          finish();
        }
      };

      if (root != null) {
        root.addEventListener("transitionend", onTransitionEnd);
        timer = setTimeout(finish, SAFETY_FALLBACK_MS);
      } else {
        setMounted(false);
      }
    },
  );

  onCleanup(() => {
    cleanupListeners();
  });

  return (
    <div
      ref={root}
      class={`collapse${props.open ? " open" : ""}${props.instant ? " instant" : ""}`}
      data-open={props.open}
    >
      <div class="collapse-inner">
        <Show when={mounted()}>{props.children}</Show>
      </div>
    </div>
  );
};
