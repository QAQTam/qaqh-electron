import { For, type Component } from "solid-js";
import IconKeyRound from "~icons/lucide/key-round";
import IconMessageSquare from "~icons/lucide/message-square";
import IconSettings from "~icons/lucide/settings";
import IconWrench from "~icons/lucide/wrench";
import { TooltipButton } from "../ui/Tooltip";

export type GlobalSection = "messages" | "tools" | "oauth" | "settings";

/** 标签用中文与其它项对齐；「接入」涵盖后续友商（不都是 OAuth），改词只改这里。 */
const ITEMS = [
  { id: "messages", label: "消息", Icon: IconMessageSquare },
  { id: "tools", label: "工具", Icon: IconWrench },
  { id: "oauth", label: "接入", Icon: IconKeyRound },
  { id: "settings", label: "设置", Icon: IconSettings },
] as const;

export const GlobalNav: Component<{
  active: GlobalSection;
  onNavigate: (section: GlobalSection) => void;
}> = (props) => (
  <nav class="global-nav" aria-label="主导航">
    <For each={ITEMS}>
      {(item) => (
        <TooltipButton
          type="button"
          class={`global-nav-item${props.active === item.id ? " active" : ""}`}
          aria-current={props.active === item.id ? "page" : undefined}
          aria-label={item.label}
          label={item.label}
          placement="right"
          onClick={() => props.onNavigate(item.id)}
        >
          <item.Icon />
          <span>{item.label}</span>
        </TooltipButton>
      )}
    </For>
  </nav>
);
