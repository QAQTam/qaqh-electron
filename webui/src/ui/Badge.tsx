import type { ParentComponent } from "solid-js";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "err";

export const Badge: ParentComponent<{
  tone?: BadgeTone;
  class?: string;
}> = (props) => (
  <span
    class={`ui-badge${props.class ? ` ${props.class}` : ""}`}
    data-tone={props.tone ?? "neutral"}
  >
    {props.children}
  </span>
);
