import { For } from "solid-js";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>(props: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <div class="ui-segmented" role="group" aria-label={props["aria-label"]}>
      <For each={props.options}>
        {(opt) => (
          <button
            type="button"
            class="ui-segmented-item"
            aria-pressed={props.value === opt.value ? "true" : "false"}
            disabled={props.disabled || opt.disabled}
            title={opt.title}
            onClick={() => props.onChange(opt.value)}
          >
            {opt.label}
          </button>
        )}
      </For>
    </div>
  );
}
