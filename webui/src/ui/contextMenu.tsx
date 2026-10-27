/**
 * 应用内右键菜单:替换「全局 preventDefault,只在输入框放行原生」那套一刀切。
 *
 * 为什么要自己画:WebView2 / WKWebView 的原生右键菜单是**浏览器**菜单——重新加载、
 * 后退、查看源代码、检查元素。在桌面壳里这些既危险(Reload 会丢未发送草稿和流式
 * 回合)又对不上中文界面。但一刀切地拦掉,连「复制」这个最基本的动作也没了:选中
 * 文字之后只剩 Ctrl+C 一条暗路。所以按上下文**重画一份编辑类菜单**。
 *
 * 收口原则:只放编辑动作(复制 / 全选 / 复制代码块 / 复制路径 / 复制链接),不放
 * 任何导航类动作。粘贴、剪切、拼写检查仍交给输入框的原生菜单——那是系统能力,
 * 重画既拿不到剪贴板读权限,也会把输入法行为搞乱。
 *
 * 给新组件加右键项的最短路径:元素上挂 `data-copy-path="要复制的值"`,菜单里就会
 * 自动多一条「复制路径」。要更复杂的动作再直接调 `openContextMenu`。
 */
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { Portal } from "@solidjs/web";
import { STR } from "../lib/strings";
import { toast } from "./toast";

export type ContextMenuItem =
  | { kind: "action"; label: string; hint?: string; onSelect: () => void }
  | { kind: "separator" };

export type ContextMenuRequest = { x: number; y: number; items: ContextMenuItem[] };

/** 可编辑区:右键交给原生菜单(剪切/粘贴/全选/拼写检查)。 */
const EDITABLE = "input, textarea, [contenteditable='true']";
/** 「全选本段」认的文本块;都不匹配时退到整页。 */
const TEXT_BLOCK = "p, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6";
/** 贴边距离:菜单不贴死窗口边缘,也不越过它。 */
const EDGE = 8;

const [request, setRequest] = createSignal<ContextMenuRequest | null>(null);
/** 夹紧后的落点;null = 还没量,先隐身一帧。 */
const [position, setPosition] = createSignal<{ left: number; top: number } | null>(null);

export function openContextMenu(next: ContextMenuRequest): void {
  setPosition(null);
  setRequest(next);
}

export function closeContextMenu(): void {
  setRequest(null);
  setPosition(null);
}

/** 剪贴板写入 + 反馈。与项目里其它复制入口同一套 API(`navigator.clipboard`)。 */
export function copyText(text: string): void {
  const written = navigator.clipboard?.writeText(text);
  if (written == null) {
    toast("复制失败:剪贴板不可用", "err", { dedupeKey: "context-copy" });
    return;
  }
  void written.then(
    () => toast(STR.copied, "ok", { dedupeKey: "context-copy", durationMs: 1600 }),
    () => toast("复制失败:剪贴板不可用", "err", { dedupeKey: "context-copy" }),
  );
}

/** 菜单里的副标题:压成一行、截断,免得长选区把菜单撑成一块。 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 26 ? `${flat.slice(0, 26)}…` : flat;
}

/** 「全选本段」:选中选区锚点所在的文本块;认不出来就整页全选。 */
function selectBlockOf(node: Node | null): void {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  const block = element?.closest(TEXT_BLOCK) ?? null;
  const selection = window.getSelection();
  if (selection == null) return;
  const range = document.createRange();
  range.selectNodeContents(block ?? document.body);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * 由一次右键事件推导菜单项;返回 null = 不拦,交给原生/既有逻辑。
 *
 * 三种 null:
 * 1. 事件已被更具体的组件接走(如侧栏会话行的「移动到工作区」);
 * 2. 落点在可编辑区(输入框要原生的剪切/粘贴);
 * 3. 当前上下文没有任何可做的事——弹一个空菜单比不弹更糟。
 */
export function buildContextMenu(event: MouseEvent): ContextMenuRequest | null {
  if (event.defaultPrevented) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(EDITABLE) != null) return null;

  const selection = window.getSelection();
  const selected = selection?.toString() ?? "";
  const groups: ContextMenuItem[][] = [];

  if (selected.trim() !== "") {
    const text = selected;
    groups.push([
      { kind: "action", label: STR.copy, hint: preview(text), onSelect: () => copyText(text) },
      { kind: "action", label: "全选本段", onSelect: () => selectBlockOf(selection?.anchorNode ?? null) },
    ]);
  }

  const code = target?.closest("pre");
  if (code != null) {
    const text = code.textContent ?? "";
    if (text.trim() !== "") {
      groups.push([{ kind: "action", label: "复制代码块", hint: preview(text), onSelect: () => copyText(text) }]);
    }
  }

  const copyPath = target?.closest<HTMLElement>("[data-copy-path]")?.dataset.copyPath ?? "";
  if (copyPath !== "") {
    groups.push([{ kind: "action", label: "复制路径", hint: copyPath, onSelect: () => copyText(copyPath) }]);
  }

  const link = target?.closest<HTMLAnchorElement>("a[href]");
  if (link != null && link.href !== "") {
    groups.push([{ kind: "action", label: "复制链接地址", hint: link.href, onSelect: () => copyText(link.href) }]);
  }

  if (groups.length === 0) return null;
  const items: ContextMenuItem[] = [];
  for (const group of groups) {
    if (items.length > 0) items.push({ kind: "separator" });
    items.push(...group);
  }
  return { x: event.clientX, y: event.clientY, items };
}

/** 落点夹紧:先按光标位置排,量出尺寸后把超出的一侧推回视口内。 */
function clampToViewport(element: HTMLElement, point: { x: number; y: number }): void {
  const rect = element.getBoundingClientRect();
  const left = Math.max(EDGE, Math.min(point.x, window.innerWidth - rect.width - EDGE));
  const top = Math.max(EDGE, Math.min(point.y, window.innerHeight - rect.height - EDGE));
  setPosition({ left, top });
}

/** 宿主:App 挂一次。菜单挂在 body 上(侧栏/消息区都是滚动容器,原地挂会被裁)。 */
export const ContextMenuHost: Component = () => {
  let panel: HTMLDivElement | undefined;
  const items = (): ContextMenuItem[] => request()?.items ?? [];

  // 位置与首项焦点都放在 request 变化之后算:同一个菜单连续在别处右键时,
  // 元素是复用的,ref 不会重跑,只有这里能把它挪过去。
  createEffect(
    () => request(),
    (menu) => {
      if (menu == null || panel == null) return;
      clampToViewport(panel, menu);
      panel.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    },
  );

  createEffect(
    () => request(),
    (menu) => {
      if (menu == null) return;
      const dismiss = (): void => closeContextMenu();
      const onPointerDown = (event: PointerEvent): void => {
        if (panel != null && event.target instanceof Node && panel.contains(event.target)) return;
        dismiss();
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const buttons = panel == null ? [] : [...panel.querySelectorAll<HTMLButtonElement>("button")];
        if (buttons.length === 0) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
      };
      // 任何滚动(消息流、侧栏、设置页)都让菜单失锚,直接关掉比留在原地更不误导。
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("scroll", dismiss, true);
      window.addEventListener("resize", dismiss);
      window.addEventListener("blur", dismiss);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("scroll", dismiss, true);
        window.removeEventListener("resize", dismiss);
        window.removeEventListener("blur", dismiss);
      };
    },
  );

  // 注意:`<Show>` 的 children **不要**写成回调去读它的 accessor。Portal 在
  // 独立 root 里延迟渲染,rc.13 会对「在组件卸载后读取 Show 的 accessor」抛
  // StatusError,而且是一次性把整个响应式系统 halt 掉。这里一律读模块信号。
  return (
    <Show when={request()}>
      <Portal>
        <div
          class="context-menu"
          role="menu"
          ref={(element) => {
            panel = element;
            const menu = request();
            if (menu != null) clampToViewport(element, menu);
          }}
          style={{
            left: `${position()?.left ?? request()?.x ?? 0}px`,
            top: `${position()?.top ?? request()?.y ?? 0}px`,
            visibility: position() == null ? "hidden" : "visible",
          }}
        >
          <For each={items()}>
            {(item) =>
              item.kind === "separator" ? (
                <div class="context-menu-separator" role="separator" />
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeContextMenu();
                    item.onSelect();
                  }}
                >
                  <span class="context-menu-label">{item.label}</span>
                  <Show when={item.hint}>
                    <small class="context-menu-hint">{item.hint}</small>
                  </Show>
                </button>
              )
            }
          </For>
        </div>
      </Portal>
    </Show>
  );
};
