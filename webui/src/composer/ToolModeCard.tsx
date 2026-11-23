/**
 * 极简工具模式菜单（对齐 Antigravity Local Permissions 卡片风格）。
 *
 * 严格控制弹窗高度，移除未接入占位与常驻大文本框：
 *  - 默认态：5 条紧凑行（左 16px 图标 + 标题 + 1 行短说明 + 右侧对勾）；
 *  - 自定义白名单：点「自定义」后在菜单内切换为紧凑编辑子视图，绝不顶穿视口。
 */
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconLayers from "~icons/lucide/layers";
import IconMinimize2 from "~icons/lucide/minimize-2";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconWrench from "~icons/lucide/wrench";

import type { SessionToolModeView } from "../session/store";
import { Button } from "../ui/Button";

const MODE_ROWS: Array<{ mode: string; label: string; desc: string; icon: "full" | "mini" | "custom" }> = [
  { mode: "standard", label: "标准", desc: "完整开发工具集", icon: "full" },
  { mode: "minimal", label: "精简", desc: "核心读写、搜索与终端", icon: "mini" },
  { mode: "minimal:b", label: "精简 B", desc: "编辑、搜索与终端（无整文件写）", icon: "mini" },
  { mode: "minimal:c", label: "精简 C", desc: "极简编辑、检索与终端", icon: "mini" },
  { mode: "custom", label: "自定义", desc: "按白名单启用指定工具", icon: "custom" },
];

const MODE_SHORT: Record<string, string> = {
  standard: "标准",
  minimal: "精简",
  "minimal:b": "精简 B",
  "minimal:c": "精简 C",
  custom: "自定义",
};

export const ToolModeCard: Component<{
  open: boolean;
  onToggle: () => void;
  view?: () => SessionToolModeView;
  onMode?: (mode: string, customTools: string[]) => Promise<void> | void;
}> = (props) => {
  const [editingCustom, setEditingCustom] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        setEditingCustom(false);
        setDraft(props.view?.().customTools.join("\n") ?? "");
      } else {
        setEditingCustom(false);
      }
    },
  );

  const current = (): string => props.view?.().mode ?? "standard";

  const chipLabel = (): string => {
    const mode = current();
    if (mode === "custom") {
      const count = props.view?.().customTools.length ?? 0;
      return `自定义 · ${count}`;
    }
    return MODE_SHORT[mode] ?? mode;
  };

  const pick = async (mode: string): Promise<void> => {
    if (busy()) return;
    if (mode === "custom") {
      setDraft(props.view?.().customTools.join("\n") ?? "");
      setEditingCustom(true);
      return;
    }
    setBusy(true);
    try {
      await props.onMode?.(mode, []);
      props.onToggle();
    } finally {
      setBusy(false);
    }
  };

  const applyCustom = async (): Promise<void> => {
    const tools = draft()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (tools.length === 0 || busy()) return;
    setBusy(true);
    try {
      await props.onMode?.("custom", tools);
      setEditingCustom(false);
      props.onToggle();
    } finally {
      setBusy(false);
    }
  };

  const renderIcon = (kind: "full" | "mini" | "custom") => {
    if (kind === "full") return <IconLayers />;
    if (kind === "custom") return <IconSlidersHorizontal />;
    return <IconMinimize2 />;
  };

  return (
    <div class="composer-control-wrap">
      <button
        type="button"
        class="composer-tool-button toolmode-trigger"
        aria-expanded={props.open ? "true" : "false"}
        title="切换本会话工具模式"
        onClick={() => props.onToggle()}
      >
        <IconWrench />
        <span>{chipLabel()}</span>
        <IconChevronDown />
      </button>

      <Show when={props.open}>
        <div class="composer-menu composer-menu-right toolmode-popover" role="dialog" aria-label="工具模式">
          <Show
            when={!editingCustom()}
            fallback={
              <div class="toolmode-custom-view">
                <div class="toolmode-custom-head">
                  <button
                    type="button"
                    class="toolmode-back"
                    onClick={() => setEditingCustom(false)}
                  >
                    <IconArrowLeft />
                    <span>返回</span>
                  </button>
                  <span class="composer-popover-title" style={{ padding: 0 }}>自定义白名单</span>
                </div>
                <textarea
                  class="toolmode-textarea"
                  rows={5}
                  spellcheck={false}
                  placeholder="每行一个工具名，如 read / exec_command"
                  value={draft()}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                />
                <div class="toolmode-custom-foot">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy() || draft().trim() === ""}
                    onClick={() => void applyCustom()}
                  >
                    应用白名单
                  </Button>
                </div>
              </div>
            }
          >
            <div class="composer-popover-title">工具模式</div>
            <div class="toolmode-list">
              <For each={MODE_ROWS}>
                {(row) => {
                  const selected = () => current() === row.mode;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected() ? "true" : "false"}
                      class={{ "toolmode-option": true, selected: selected() }}
                      disabled={busy()}
                      onClick={() => void pick(row.mode)}
                    >
                      <span class="toolmode-option-icon" aria-hidden="true">
                        {renderIcon(row.icon)}
                      </span>
                      <span class="toolmode-option-copy">
                        <span class="toolmode-option-title">{row.label}</span>
                        <span class="toolmode-option-desc">{row.desc}</span>
                      </span>
                      <Show when={selected()}>
                        <IconCheck class="toolmode-option-check" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
