import type { ParentComponent } from "solid-js";
import type { JSX } from "@solidjs/web";

export type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export const Button: ParentComponent<{
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  class?: string;
  title?: string;
  onClick?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}> = (props) => (
  <button
    type={props.type ?? "button"}
    class={`ui-btn${props.class ? ` ${props.class}` : ""}`}
    data-variant={props.variant ?? "secondary"}
    data-size={props.size ?? "md"}
    disabled={props.disabled}
    title={props.title}
    onClick={props.onClick}
  >
    {props.children}
  </button>
);
