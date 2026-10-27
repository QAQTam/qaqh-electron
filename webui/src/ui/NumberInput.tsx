/**
 * 数字输入：本地字符串缓冲，blur / Enter 才提交。
 *
 * 旧实现每敲一个键就 toInt() 并 setField()，非法值和空串被 `null` 吞掉：
 * 框里显示空、草稿还是旧值、底部仍说"没有改动"，切走再回来又弹回去。
 * 这里让 DOM 文本和草稿解耦，只有用户确认（blur/Enter）且值合法时才写草稿。
 */
import { createEffect, createSignal, type Component } from "solid-js";

const parse = (raw: string, integer: boolean): number | null => {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return integer ? Math.trunc(value) : value;
};

export const NumberInput: Component<{
  value: number;
  onCommit: (value: number) => void;
  integer?: boolean;
  min?: number;
  max?: number;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
}> = (props) => {
  const [text, setText] = createSignal(String(props.value));
  const [invalid, setInvalid] = createSignal(false);

  // 外部值（reload / profile 切换）进来时同步；props.value 只有提交后才变，
  // 所以打字过程不会被这个 effect 覆盖。
  createEffect(
    () => props.value,
    (value) => {
      setText(String(value));
      setInvalid(false);
    },
  );

  const commit = (): void => {
    const next = parse(text(), props.integer !== false);
    if (next == null || (props.min != null && next < props.min) || (props.max != null && next > props.max)) {
      setText(String(props.value));
      setInvalid(false);
      return;
    }
    setInvalid(false);
    if (next !== props.value) props.onCommit(next);
    else setText(String(next));
  };

  return (
    <input
      id={props.id}
      class={`field-input number-input${invalid() ? " is-invalid" : ""}`}
      type="text"
      inputmode={props.integer === false ? "decimal" : "numeric"}
      autocomplete="off"
      spellcheck={false}
      value={text()}
      aria-label={props.ariaLabel}
      aria-invalid={invalid() ? "true" : undefined}
      placeholder={props.placeholder}
      onInput={(event) => setText(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setText(String(props.value));
          setInvalid(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
};
