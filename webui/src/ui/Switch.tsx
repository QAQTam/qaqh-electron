/** Fluent ToggleSwitch：40×20 轨道 + 12px 滑块，Kobalte 负责键盘/ARIA。 */
import { Show, type Component } from "solid-js";
import { Switch as KSwitch } from "@kobalte/core/switch";

export const Switch: Component<{
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
}> = (props) => (
  <KSwitch
    class="switch-row"
    checked={props.checked}
    onChange={props.onToggle}
    disabled={props.disabled}
  >
    <KSwitch.Input class="switch-input" />
    <KSwitch.Control class="switch-control">
      <KSwitch.Thumb class="switch-thumb" />
    </KSwitch.Control>
    <span class="switch-copy">
      <KSwitch.Label class="switch-label">{props.label}</KSwitch.Label>
      <Show when={props.hint != null && props.hint !== ""}>
        <span class="switch-hint">{props.hint}</span>
      </Show>
    </span>
  </KSwitch>
);
