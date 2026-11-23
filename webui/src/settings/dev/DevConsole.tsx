/**
 * 开发者控制台:居中浮层,五个面板按 tab 独立挂载(卸载即停采集)。
 */
import { For, Show, createSignal, onCleanup, type Component } from "solid-js";
import IconTerminal from "~icons/lucide/terminal";
import IconX from "~icons/lucide/x";
import { desktopHost } from "../../lib/desktop-host";
import { closeDevConsole, disableDevMode } from "../../lib/devmode";
import { MemoryPanel } from "./MemoryPanel";
import { MachinePanel } from "./MachinePanel";
import { ActivityPanel } from "./ActivityPanel";
import { EventLogPanel } from "./EventLogPanel";
import { HostPanel } from "./HostPanel";

type TabId = "machine" | "memory" | "activity" | "events" | "host";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "machine", label: "本机" },
  { id: "memory", label: "内存" },
  { id: "activity", label: "活动状态" },
  { id: "events", label: "事件流" },
  { id: "host", label: "宿主" },
];

export const DevConsole: Component = () => {
  const [tab, setTab] = createSignal<TabId>("machine");
  const hasDevTools = () => Boolean(desktopHost()?.devtools?.toggle);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeDevConsole();
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <div
      class="dev-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDevConsole();
      }}
    >
      <section class="dev-console" role="dialog" aria-modal="true" aria-labelledby="dev-console-title">
        <header class="dev-console-head">
          <span id="dev-console-title" class="dev-console-title">开发者控制台</span>
          <nav class="dev-tabs" aria-label="调试面板">
            <For each={TABS}>{(item) => (
              <button
                type="button"
                class={tab() === item.id ? "dev-tab is-active" : "dev-tab"}
                aria-current={tab() === item.id ? "true" : undefined}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            )}</For>
          </nav>
          <div class="dev-head-actions">
            <Show when={hasDevTools()}>
              <button
                type="button"
                class="dev-btn"
                title="开关 Chromium DevTools"
                onClick={() => { void desktopHost()?.devtools?.toggle(); }}
              >
                <IconTerminal />
                <span>DevTools</span>
              </button>
            </Show>
            <button type="button" class="dev-btn dev-btn-danger" onClick={disableDevMode}>
              收回开发者模式
            </button>
            <button type="button" class="icon-btn" aria-label="关闭调试控制台" onClick={closeDevConsole}>
              <IconX />
            </button>
          </div>
        </header>
        <div class="dev-console-body">
          <Show when={tab() === "machine"}><MachinePanel /></Show>
          <Show when={tab() === "memory"}><MemoryPanel /></Show>
          <Show when={tab() === "activity"}><ActivityPanel /></Show>
          <Show when={tab() === "events"}><EventLogPanel /></Show>
          <Show when={tab() === "host"}><HostPanel /></Show>
        </div>
      </section>
    </div>
  );
};
