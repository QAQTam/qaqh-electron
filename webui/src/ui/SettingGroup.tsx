import { Show, type ParentComponent } from "solid-js";
import type { JSX } from "@solidjs/web";

export const SettingGroup: ParentComponent<{
  title?: string;
  desc?: string;
  aside?: JSX.Element;
  id?: string;
}> = (props) => (
  <section class="ui-setting-group" id={props.id}>
    <Show when={props.title != null || props.aside != null}>
      <div class="ui-setting-group-head">
        <Show when={props.title != null}>
          <h3 class="ui-setting-group-title">{props.title}</h3>
        </Show>
        <Show when={props.aside != null}>{props.aside}</Show>
      </div>
    </Show>
    <Show when={props.desc != null && props.desc !== ""}>
      <p class="ui-setting-group-desc">{props.desc}</p>
    </Show>
    <div class="ui-setting-group-card">{props.children}</div>
  </section>
);

export const SettingRow: ParentComponent<{
  label: string;
  desc?: string;
  class?: string;
}> = (props) => (
  <div class={`ui-setting-row${props.class ? ` ${props.class}` : ""}`}>
    <div class="ui-setting-row-copy">
      <span class="ui-setting-row-label">{props.label}</span>
      <Show when={props.desc != null && props.desc !== ""}>
        <span class="ui-setting-row-desc">{props.desc}</span>
      </Show>
    </div>
    <div class="ui-setting-row-control">{props.children}</div>
  </div>
);
