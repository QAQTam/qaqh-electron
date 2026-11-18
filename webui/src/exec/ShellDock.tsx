/**
 * Windows Terminal 风格的用户终端面板：标签栏 + `+` + 档位下拉 + 活动区。
 *
 * 面板挂在 App 顶层（不在 SessionView 里），所以切会话标签不会卸载它；
 * 切终端标签只换活动 shellId，ShellTerminal 的 DOM 卸载只 detach（退订），
 * 真正的 `shell.close` 只在用户点标签上的 X 时发生（shell-tabs store）。
 *
 * `+` 用上次用过的档位（持久化），箭头下拉可换 pwsh/bash/cmd；
 * Ctrl+Shift+1/2/3 直开对应档位，与下拉里标注的提示一致。
 */
import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import IconPlus from "~icons/lucide/plus";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconX from "~icons/lucide/x";
import { useDismissable } from "../ui/dismissable";
import { SHELL_PROFILES, shellTabs, type ShellKind } from "./shell-tabs";

type TerminalView = Component<{ shellId: string; class?: string }>;
let terminalPromise: Promise<TerminalView> | undefined;
function loadTerminal(): Promise<TerminalView> {
  terminalPromise ??= import("./ShellTerminal").then((module) => module.ShellTerminal);
  return terminalPromise;
}

const KIND_ICONS: Partial<Record<ShellKind, string>> = {
  pwsh: new URL("../tools/icons/powershell-glyph.svg", import.meta.url).href,
  bash: new URL("../tools/icons/bash.svg", import.meta.url).href,
};

/** cmd 没有品牌图标，用等宽 `>_` 字形；pwsh/bash 走现成的去底 SVG。 */
const ShellIcon: Component<{ kind: ShellKind }> = (props) => (
  <Show
    when={KIND_ICONS[props.kind]}
    fallback={<span class="shell-kind-glyph" aria-hidden="true">&gt;_</span>}
  >
    {(src) => <img class="shell-kind-icon" src={src()} alt="" aria-hidden="true" />}
  </Show>
);

export const ShellDock: Component = () => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [terminalView, setTerminalView] = createSignal<TerminalView>();
  let menuWrap: HTMLDivElement | undefined;

  useDismissable({
    active: menuOpen,
    onDismiss: () => setMenuOpen(false),
    inside: () => [menuWrap ?? null],
    triggerSelector: ".shell-dock-menu-trigger",
  });

  // xterm 很重：面板第一次打开才拉（Composer 旧 overlay 的惰性纪律照搬）。
  createEffect(
    () => [shellTabs.dockOpen(), terminalView()] as const,
    ([open, view]) => {
      if (open && view == null) void loadTerminal().then((loaded) => setTerminalView(() => loaded));
    },
  );

  // 组件体只跑一次，监听器注册在这里；Solid 2 没有 onMount。
  const onKey = (event: KeyboardEvent): void => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
    if (event.key !== "1" && event.key !== "2" && event.key !== "3") return;
    event.preventDefault();
    event.stopPropagation();
    const profile = SHELL_PROFILES[Number(event.key) - 1];
    if (profile != null) void shellTabs.open(profile.kind);
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <Show when={shellTabs.dockOpen()}>
      <div class="shell-dock" role="dialog" aria-label="用户终端">
        <div class="shell-dock-tabbar">
          <div class="shell-dock-tabs" role="tablist">
            <For each={shellTabs.tabs()}>
              {(tab) => (
                <div
                  class={`shell-dock-tab${shellTabs.activeId() === tab.id ? " active" : ""}`}
                  role="tab"
                  aria-selected={shellTabs.activeId() === tab.id ? "true" : "false"}
                  onClick={() => shellTabs.activate(tab.id)}
                >
                  <ShellIcon kind={tab.kind} />
                  <span class="shell-dock-tab-label">{shellTabs.labelOf(tab, shellTabs.tabs())}</span>
                  <button
                    type="button"
                    class="shell-dock-tab-close"
                    aria-label="关闭终端标签"
                    title="关闭终端标签（结束 shell）"
                    onClick={(event) => {
                      event.stopPropagation();
                      shellTabs.close(tab.id);
                    }}
                  >
                    <IconX />
                  </button>
                </div>
              )}
            </For>
          </div>

          <div class="shell-dock-new" ref={menuWrap}>
            <button
              type="button"
              class="shell-dock-add"
              title="新建终端（使用上次档位）"
              aria-label="新建终端"
              onClick={() => void shellTabs.open()}
            >
              <IconPlus />
            </button>
            <button
              type="button"
              class="shell-dock-menu-trigger"
              aria-label="选择终端类型"
              aria-expanded={menuOpen() ? "true" : "false"}
              onClick={() => setMenuOpen(!menuOpen())}
            >
              <IconChevronDown />
            </button>
            <Show when={menuOpen()}>
              <div class="shell-dock-menu" role="menu">
                <For each={SHELL_PROFILES}>
                  {(profile, index) => (
                    <button
                      type="button"
                      role="menuitem"
                      class="shell-dock-menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        void shellTabs.open(profile.kind);
                      }}
                    >
                      <ShellIcon kind={profile.kind} />
                      <span class="shell-dock-menu-label">{profile.label}</span>
                      <small class="shell-dock-menu-shortcut">Ctrl+Shift+{index() + 1}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="shell-dock-fill" />
          <button
            type="button"
            class="shell-dock-hide"
            title="收起终端（不关闭 shell）"
            aria-label="收起终端"
            onClick={() => shellTabs.hide()}
          >
            <IconChevronDown />
          </button>
        </div>

        <div class="shell-dock-body">
          <Show when={shellTabs.activeTab()} keyed fallback={<div class="shell-dock-loading">点 + 新建一个终端</div>}>
            {(tab) => (
              <Show when={terminalView()} keyed fallback={<div class="shell-dock-loading">正在加载终端…</div>}>
                {(TerminalView) => <TerminalView shellId={tab.shellId} />}
              </Show>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
};
