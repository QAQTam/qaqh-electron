/**
 * 浮层统一关闭语义：外部 pointerdown + Escape。
 *
 * 这不是一个完整 menu primitive（键盘 roving 仍由各菜单自己做），只负责
 * "点了别处/按了 Esc 就应该关" 这一条所有下拉都必须遵守的规则。之前 Composer
 * 的四个菜单完全没有这层，点外面不会关、Esc 也不会关，只能再点一次触发器。
 */
import { createEffect } from "solid-js";

export function useDismissable(options: {
  active: () => boolean;
  onDismiss: () => void;
  /** 视为"内部"的区域（菜单面板、触发器容器）。 */
  inside?: () => Array<Element | null | undefined>;
  /** 视为"触发器"的选择器：点它不关闭，让触发器自己的 onClick 切换。 */
  triggerSelector?: string;
  /** 是否在关闭时阻止事件继续冒泡（默认 true，避免 Esc 连带关掉整页）。 */
  stopEscape?: boolean;
}): void {
  createEffect(
    () => options.active(),
    (active) => {
      if (!active) return;

      const onPointerDown = (event: PointerEvent): void => {
        const target = event.target;
        if (target instanceof Element) {
          if (options.triggerSelector != null && target.closest(options.triggerSelector) != null) return;
          const zones = options.inside?.() ?? [];
          if (zones.some((zone) => zone?.contains(target))) return;
        }
        options.onDismiss();
      };

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        if (options.stopEscape !== false) event.stopPropagation();
        options.onDismiss();
      };

      // capture 阶段：比组件自身的冒泡处理更早拿到事件，避免菜单内部把
      // pointerdown 吃掉（例如拖拽强度轨道）后外部点击失效。
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
      };
    },
  );
}
