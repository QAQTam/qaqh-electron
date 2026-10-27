/**
 * 设置页共用小控件(Field/TextInput/Section/Switch),从 SettingsView 拆出:
 * ProfileManager / PairingSection 与主视图共用同一套字段骨架。
 */
import { Show, type Component, type ParentComponent } from "solid-js";
import { Switch as FluentSwitch } from "../ui/Switch";

export const Field: ParentComponent<{
  label: string;
  hint?: string;
  wide?: boolean;
  compact?: boolean;
  error?: string;
}> = (props) => (
  <label class={`field${props.wide ? " wide" : ""}${props.compact ? " compact" : ""}`}>
    <span class="field-label">{props.label}</span>
    {props.children}
    <Show when={props.error != null && props.error !== ""}>
      <span class="field-hint is-error">{props.error}</span>
    </Show>
    <Show when={(props.error == null || props.error === "") && props.hint != null && props.hint !== ""}>
      <span class="field-hint">{props.hint}</span>
    </Show>
  </label>
);

export const TextInput: Component<{
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  id?: string;
  disabled?: boolean;
  autocomplete?: string;
  spellcheck?: boolean;
}> = (props) => (
  <input
    id={props.id}
    type={props.type ?? "text"}
    class="field-input"
    value={props.value}
    placeholder={props.placeholder ?? ""}
    disabled={props.disabled}
    autocomplete={props.autocomplete ?? "off"}
    spellcheck={props.spellcheck ?? false}
    onInput={(event) => props.onInput(event.currentTarget.value)}
  />
);

export const Section: ParentComponent<{ title: string; desc?: string; id?: string; aside?: string }> = (
  props,
) => (
  <section class="settings-section" id={props.id}>
    {/* 未给 aside 时 DOM 与历史完全一致（只多一个 h3），免得动到既有布局。 */}
    <Show when={props.aside != null} fallback={<h3>{props.title}</h3>}>
      <div class="settings-section-head">
        <h3>{props.title}</h3>
        <span class="settings-section-aside">{props.aside}</span>
      </div>
    </Show>
    <Show when={props.desc != null && props.desc !== ""}>
      <p class="settings-section-desc">{props.desc}</p>
    </Show>
    <div class="settings-fields">{props.children}</div>
  </section>
);

export const Switch = FluentSwitch;
