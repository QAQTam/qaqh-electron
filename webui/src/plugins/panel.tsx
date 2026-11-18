/**
 * PluginPanelCards:右栏工作区的 panel 槽卡片——panel 槽插件的统一收口。
 *
 * 契约与 dock 同构:插件只渲染内容进宿主卡体,不自管定位/开合;卡片与待办卡
 * 并列,开合跟随右栏本身(容器归属宿主)。容器由 loader 的 ensurePanelMounted
 * 懒挂载:右栏打开才 mount,之后常驻(切走再切回、切 section 都不丢插件状态
 * ——卡片被 Show 卸下时容器只是孤儿化,loaded 表仍持有)。rev 失配 teardown,
 * 下次可见重挂。
 *
 * Solid 2 严格模式纪律:与 dock.tsx 相同——无模块级开合信号(Esc 不归卡管),
 * 卡片挂载用 createEffect 纯 DOM 搬运,组件作用域内不写外部信号、不挂 onCleanup。
 */
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { ASSET_ICON, ensurePanelMounted, panelPlugins, type PanelPluginInfo } from "./loader";

const PanelCard: Component<{ entry: PanelPluginInfo }> = (props) => {
  const [bodyEl, setBodyEl] = createSignal<HTMLElement | null>(null);

  // 卡体就绪 → 懒挂载并把容器搬进卡体(搬节点,状态不丢)。
  // deps 含 rev:graph 帧推进时对已挂卡片自动重试(rev 失配在 loader 内 teardown 重挂)。
  createEffect(
    () => [bodyEl(), props.entry.rev] as const,
    ([body]) => {
      if (body == null) return;
      void ensurePanelMounted(props.entry.id).then((container) => {
        if (container == null || body == null) return;
        if (container.parentElement !== body) body.replaceChildren(container);
      });
    },
  );

  return (
    <section class="plugin-panel-card">
      <div class="plugin-panel-card-head">
        <Show when={ASSET_ICON.test(props.entry.icon)} fallback={<span class="plugin-panel-emoji" aria-hidden="true">{props.entry.icon}</span>}>
          <img class="plugin-panel-icon" src={`app://localhost/plugins/${props.entry.id}/${props.entry.icon}?rev=${props.entry.rev}`} alt="" />
        </Show>
        <span>{props.entry.name}</span>
      </div>
      <div class="plugin-panel-card-body" ref={setBodyEl} />
    </section>
  );
};

/** 挂进右栏工作区(body-inner 尾部);外层用 <Show when={右栏开}> 门控渲染。 */
export function PluginPanelCards() {
  return (
    <For each={panelPlugins()}>{(entry) => <PanelCard entry={entry} />}</For>
  );
}
