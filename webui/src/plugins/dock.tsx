/**
 * PluginDock：仅在对话页右下角显示的纵向可收折插件坞（向上展开，不横向遮挡 Composer）。
 *
 * Solid 2 严格模式纪律：面板与坞条开合信号提升到模块级，关停失效插件用 createMemo 纯派生。
 */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconPuzzle from "~icons/lucide/puzzle";
import IconX from "~icons/lucide/x";
import { ASSET_ICON, dockPlugins, ensureDockMounted } from "./loader";
import { prefGet, prefSet } from "../lib/prefs";

const OPEN_KEY = "qaqh.plugin-dock.open";

function readOpen(): string | null {
  const v = prefGet(OPEN_KEY);
  return v == null || v === "" ? null : v;
}

const [openId, setOpenIdRaw] = createSignal<string | null>(readOpen());
const [barExpanded, setBarExpanded] = createSignal<boolean>(openId() != null);

function setOpen(id: string | null): void {
  setOpenIdRaw(id);
  prefSet(OPEN_KEY, id ?? "");
  if (id != null) setBarExpanded(true);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openId() != null) setOpen(null);
});

export function PluginDock() {
  const [bodyEl, setBodyEl] = createSignal<HTMLElement | null>(null);

  const activeId = createMemo(() => {
    const id = openId();
    const list = dockPlugins();
    if (id != null && list.length > 0 && !list.some((entry) => entry.id === id)) return null;
    return id;
  });

  createEffect(
    () => [activeId(), bodyEl(), dockPlugins()] as const,
    ([id, body]) => {
      if (id == null || body == null) return;
      void ensureDockMounted(id).then((container) => {
        if (container == null || body == null) return;
        if (container.parentElement !== body) body.replaceChildren(container);
      });
    },
  );

  const toggleBar = (): void => {
    if (barExpanded()) {
      setOpen(null);
      setBarExpanded(false);
    } else {
      setBarExpanded(true);
    }
  };

  return (
    <Show when={dockPlugins().length > 0}>
      <div class="plugin-dock">
        <Show when={activeId() != null}>
          <div class="plugin-dock-panel">
            <div class="plugin-dock-head">
              <span class="plugin-dock-title">{dockPlugins().find((entry) => entry.id === activeId())?.name ?? ""}</span>
              <button type="button" class="plugin-dock-close" aria-label="关闭插件面板" onClick={() => setOpen(null)}>
                <IconX />
              </button>
            </div>
            <div class="plugin-dock-body" ref={setBodyEl} />
          </div>
        </Show>

        <div class={{ "plugin-dock-rail": true, "is-expanded": barExpanded() }}>
          <Show when={barExpanded()}>
            <div class="plugin-dock-stack">
              <For each={dockPlugins()}>
                {(entry) => (
                  <button
                    type="button"
                    class={"plugin-dock-btn" + (activeId() === entry.id ? " active" : "")}
                    title={entry.name}
                    onClick={() => setOpen(activeId() === entry.id ? null : entry.id)}
                  >
                    <Show when={ASSET_ICON.test(entry.icon)} fallback={<span class="plugin-dock-emoji">{entry.icon}</span>}>
                      <img class="plugin-dock-img" src={`app://localhost/plugins/${entry.id}/${entry.icon}?rev=${entry.rev}`} alt={entry.name} />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <button
            type="button"
            class="plugin-dock-toggle"
            aria-expanded={barExpanded() ? "true" : "false"}
            title={barExpanded() ? "收起插件坞" : `展开插件坞 (${dockPlugins().length})`}
            onClick={toggleBar}
          >
            <Show when={barExpanded()} fallback={<IconPuzzle />}>
              <IconChevronDown />
            </Show>
          </button>
        </div>
      </div>
    </Show>
  );
}
