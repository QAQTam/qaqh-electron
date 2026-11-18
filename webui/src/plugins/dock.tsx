/**
 * PluginDock：右下角插件坞——dock 槽插件的统一收口。
 *
 * 图标条常驻右下角（自 qaqh-snake/qaqh-padview 的自管按钮让位而来），点图标
 * 向上弹出该插件的渲染窗；同一时刻至多开一个面板。容器由 loader 的
 * ensureDockMounted 懒挂载，打开后常驻（切走再切回不丢插件状态）。
 *
 * Solid 2 严格模式纪律：面板开合信号提升到模块级（Esc 监听器注册一次随页面
 * 生命周期），关停失效插件用 createMemo 纯派生——组件作用域内不写信号、不挂
 * onCleanup（rc.15 的 CLEANUP/REACTIVE_WRITE 双闸门）。
 */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { ASSET_ICON, dockPlugins, ensureDockMounted } from "./loader";
import { prefGet, prefSet } from "../lib/prefs";
import { STR } from "../lib/strings";

const OPEN_KEY = "qaqh.plugin-dock.open";

function readOpen(): string | null {
  const v = prefGet(OPEN_KEY);
  return v == null || v === "" ? null : v;
}

/** 打开的插件 id；null = 收起。模块级:Esc 监听与本偏好同生命周期。 */
const [openId, setOpenIdRaw] = createSignal<string | null>(readOpen());
function setOpen(id: string | null): void {
  setOpenIdRaw(id);
  prefSet(OPEN_KEY, id ?? "");
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openId() != null) setOpen(null);
});

export function PluginDock() {
  const [bodyEl, setBodyEl] = createSignal<HTMLElement | null>(null);

  // 生效的打开项:指向的插件从图里消失(被删/禁用)时派生为收起,不回写信号。
  const activeId = createMemo(() => {
    const id = openId();
    const list = dockPlugins();
    if (id != null && list.length > 0 && !list.some((entry) => entry.id === id)) return null;
    return id;
  });

  // 面板体就绪且 activeId 有效 → 懒挂载并把容器搬进面板（切插件=搬节点，状态不丢）。
  // deps 含 dockPlugins：graph 帧到达/rev 推进时对已开面板自动重试挂载。
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

  return (
    <div class="plugin-dock">
      <Show when={activeId() != null}>
        <div class="plugin-dock-panel">
          <div class="plugin-dock-head">
            <span class="plugin-dock-title">{dockPlugins().find((entry) => entry.id === activeId())?.name ?? ""}</span>
            <button type="button" class="ghost-mini" onClick={() => setOpen(null)}>{STR.close}</button>
          </div>
          <div class="plugin-dock-body" ref={setBodyEl} />
        </div>
      </Show>
      <div class="plugin-dock-bar">
        <For each={dockPlugins()}>{(entry) => (
          <button type="button" class={"plugin-dock-btn" + (activeId() === entry.id ? " active" : "")} title={entry.name}
            onClick={() => setOpen(activeId() === entry.id ? null : entry.id)}>
            <Show when={ASSET_ICON.test(entry.icon)} fallback={<span class="plugin-dock-emoji">{entry.icon}</span>}>
              <img class="plugin-dock-img" src={`app://localhost/plugins/${entry.id}/${entry.icon}?rev=${entry.rev}`} alt={entry.name} />
            </Show>
          </button>
        )}</For>
        <Show when={dockPlugins().length === 0}>
          <span class="plugin-dock-empty">无插件</span>
        </Show>
      </div>
    </div>
  );
}
