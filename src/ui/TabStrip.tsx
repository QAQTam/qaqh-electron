// TabStrip（spec §9）：36px、拖拽区、活动 tab 顶部 2px 强调线、
// 右键菜单、+ 新建、Ctrl+Tab 轮转、窗口控制钮。key 一律 seed。
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Component } from "solid-js";
import { tabsStore, type TabItem } from "../state/tabs";
import { bridge } from "../lib/bridge";

function statusDot(t: TabItem): string {
  if (t.streaming) return "streaming";
  if (t.activity) return t.activity;
  return "idle";
}

const WinButtonMin = () => (
  <svg width="10" height="10" viewBox="0 0 10 10">
    <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1" />
  </svg>
);
const WinButtonMax = () => (
  <svg width="10" height="10" viewBox="0 0 10 10">
    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
  </svg>
);
const WinButtonClose = () => (
  <svg width="10" height="10" viewBox="0 0 10 10">
    <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1" />
    <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1" />
  </svg>
);

interface TabMenu {
  seed: string;
  x: number;
  y: number;
}

export const TabStrip: Component = () => {
  const [menu, setMenu] = createSignal<TabMenu | null>(null);

  const closeMenu = () => setMenu(null);

  const doArchive = (seed: string) => {
    closeMenu();
    tabsStore.remove(seed);
    // 真实命令在 client 接线后由 actions 层发出（mock 模式下直接移除）
    window.dispatchEvent(new CustomEvent("qaqh:archiveSession", { detail: seed }));
  };

  const doClose = (seed: string) => {
    closeMenu();
    window.dispatchEvent(new CustomEvent("qaqh:closeSession", { detail: seed }));
  };

  const copySeed = (seed: string) => {
    closeMenu();
    void navigator.clipboard?.writeText(seed);
    window.dispatchEvent(new CustomEvent("qaqh:toast", { detail: "seed 已复制" }));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu();
  };

  return (
    <div class="tabstrip" onMouseLeave={() => setMenu(null)}>
      <div class="tabstrip-tabs">
        <For each={tabsStore.order()}>
          {(seed) => {
            const Tab = () => {
              const t = createMemo(() => tabsStore.tab(seed)!);
              return (
                <div
                  class={["tab", { active: tabsStore.activeSeed() === seed }]}
                  onClick={() => window.dispatchEvent(new CustomEvent("qaqh:activateTab", { detail: seed }))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ seed, x: e.clientX, y: e.clientY });
                  }}
                  title={t().title}
                >
                  <span class={["tab-dot", statusDot(t())]} />
                  <span class="tab-title">{t().title}</span>
                  <Show when={t().pendingCount > 0 && t().activity === "waiting_user"}>
                    <span class="tab-badge">{t().pendingCount}</span>
                  </Show>
                  <button
                    class="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      doClose(seed);
                    }}
                    title="关闭"
                  >
                    ×
                  </button>
                </div>
              );
            };
            return <Tab />;
          }}
        </For>
        <button
          class="tab-add"
          title="新建会话 (Ctrl+T)"
          onClick={() => window.dispatchEvent(new CustomEvent("qaqh:newSession"))}
        >
          +
        </button>
      </div>
      <div class="tab-spacer" />
      <Show when={bridge()}>
        <div class="win-controls">
          <button class="win-btn" title="最小化" onClick={() => void bridge()!.win("min")}>
            <WinButtonMin />
          </button>
          <button class="win-btn" title="最大化" onClick={() => void bridge()!.win("max")}>
            <WinButtonMax />
          </button>
          <button class="win-btn close" title="关闭" onClick={() => void bridge()!.win("close")}>
            <WinButtonClose />
          </button>
        </div>
      </Show>
      <Show when={menu()}>
        {(m) => (
          <div
            class="palette-overlay"
            style={{ "z-index": 300, background: "transparent" }}
            onClick={closeMenu}
            onKeyDown={onKeyDown}
          >
            <div
              style={{
                position: "fixed",
                left: `${m().x}px`,
                top: `${m().y}px`,
                background: "var(--bg)",
                border: "1px solid var(--border-strong)",
                "border-radius": "var(--radius-card)",
                "min-width": "140px",
                padding: "4px 0",
                "box-shadow": "0 4px 16px rgba(44,44,42,0.12)",
              }}
            >
              <button
                class="palette-item"
                onClick={() => doArchive(m().seed)}
              >
                归档会话
              </button>
              <button class="palette-item" onClick={() => copySeed(m().seed)}>
                复制 seed
              </button>
              <button class="palette-item" onClick={() => doClose(m().seed)}>
                关闭标签
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};
