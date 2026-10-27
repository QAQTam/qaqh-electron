/**
 * 开发者控制台:设置页之上的第二层浮层,四个面板各自独立挂载。
 *
 * 面板用 `Show` 按 tab 定界而不是全部常驻,这条是有实际后果的:内存面板卸载时
 * `onCleanup` 会向 daemon 发 `diagnostics.memory.stop`。四个面板一起挂着,就等于
 * 关掉内存 tab 之后它还在每秒采样。
 */
import { For, Show, createSignal, type Component } from "solid-js";
import IconX from "~icons/lucide/x";
import { closeDevConsole, disableDevMode } from "../../lib/devmode";
import { MemoryPanel } from "./MemoryPanel";
import { MachinePanel } from "./MachinePanel";
import { ActivityPanel } from "./ActivityPanel";
import { EventLogPanel } from "./EventLogPanel";
import { HostPanel } from "./HostPanel";

type TabId = "memory" | "machine" | "activity" | "events" | "host";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "memory", label: "内存" },
  { id: "machine", label: "本机" },
  { id: "activity", label: "活动状态" },
  { id: "events", label: "事件流" },
  { id: "host", label: "宿主" },
];

export const DevConsole: Component = () => {
  const [tab, setTab] = createSignal<TabId>("memory");
  return (
    <div class="dev-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closeDevConsole(); }}>
      <section class="dev-console" role="dialog" aria-modal="true" aria-labelledby="dev-console-title">
        <header class="dev-console-head">
          <strong id="dev-console-title">开发者控制台</strong>
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
          <button type="button" class="ghost-mini" onClick={disableDevMode}>收回开发者模式</button>
          <button type="button" class="icon-btn" aria-label="关闭调试控制台" onClick={closeDevConsole}>
            <IconX />
          </button>
        </header>
        <div class="dev-console-body">
          <Show when={tab() === "memory"}><MemoryPanel /></Show>
          <Show when={tab() === "machine"}><MachinePanel /></Show>
          <Show when={tab() === "activity"}><ActivityPanel /></Show>
          <Show when={tab() === "events"}><EventLogPanel /></Show>
          <Show when={tab() === "host"}><HostPanel /></Show>
        </div>
      </section>
    </div>
  );
};
