/**
 * 工具模式卡:composer 控制条上的会话级工具面切换器(结构与 EffortCard 同构:
 * chip 触发器 + `.composer-menu` 弹卡)。
 *
 * 读写的是**会话级** `session.set_tool_mode`(daemon 落 meta.json 后通知
 * worker 换工具面);与全局 effort/profile 卡的「config 单写口」不同,这里
 * 每个 seed 一份真值,来自 `session.meta.tool_mode`。
 *
 * 档位表是 `qaqh-types/src/tool_mode.rs` 预置表的**展示镜像**(名字/数量),
 * 后端仍是唯一真相:未知模式名原样显示不冒充;ptc 在后端接入 KNOWN_MODES
 * 之前置灰。custom 展开多行输入(每行一个注册名),提交走同一命令。
 */
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconWrench from "~icons/lucide/wrench";

import type { SessionToolModeView } from "../session/store";

/** 展示镜像:与后端 `qaqh_types::tool_mode` 预置表对拍(名字必须逐字一致)。 */
const MODE_ROWS: Array<{ mode: string; label: string; hint: string; count?: number }> = [
  { mode: "standard", label: "standard", hint: "全部工具", count: 22 },
  { mode: "minimal", label: "minimal", hint: "exec · write · edit · read · glob · grep · confirm_apply", count: 7 },
  { mode: "minimal:b", label: "minimal:b", hint: "exec · edit · glob · grep · read · confirm_apply", count: 6 },
  { mode: "minimal:c", label: "minimal:c", hint: "exec · edit · glob · confirm_apply", count: 4 },
  { mode: "custom", label: "custom", hint: "自选工具白名单" },
  { mode: "ptc", label: "ptc", hint: "code mode · 只暴露 run_code", count: undefined },
];

/** 后端尚未收录的档位(置灰展示,不可选)。 */
const UNAVAILABLE = new Set(["ptc"]);

const MODE_LABEL: Record<string, string> = {
  standard: "standard",
  minimal: "minimal",
  "minimal:b": "minimal:b",
  "minimal:c": "minimal:c",
  custom: "custom",
};

export const ToolModeCard: Component<{
  open: boolean;
  onToggle: () => void;
  view?: () => SessionToolModeView;
  onMode?: (mode: string, customTools: string[]) => Promise<void> | void;
}> = (props) => {
  const [customOpen, setCustomOpen] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // 打开时把 custom 草稿对齐到当前真值;关闭时收起编辑面。
  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        setCustomOpen(props.view?.().mode === "custom");
        setDraft(props.view?.().customTools.join("\n") ?? "");
      } else {
        setCustomOpen(false);
      }
    },
  );

  const current = (): string => props.view?.().mode ?? "standard";
  /** chip 上的字:认识的中文名;不认识的原样(后端新档先于前端更新的容错)。 */
  const chipLabel = (): string => {
    const mode = current();
    if (mode === "standard") return "全部工具";
    if (mode === "custom") {
      const count = props.view?.().customTools.length ?? 0;
      return `custom · ${count}`;
    }
    return MODE_LABEL[mode] ?? mode;
  };

  const pick = async (mode: string): Promise<void> => {
    if (UNAVAILABLE.has(mode) || busy()) return;
    if (mode === "custom") {
      // 进入编辑面而不是立刻提交:白名单为空在后端是 400。
      if (current() !== "custom") setDraft(props.view?.().customTools.join("\n") ?? "");
      setCustomOpen(!customOpen());
      return;
    }
    setBusy(true);
    try {
      await props.onMode?.(mode, []);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="composer-control-wrap">
      <button
        type="button"
        class="composer-tool-button toolmode-trigger"
        aria-expanded={props.open ? "true" : "false"}
        title="工具模式(本会话生效)"
        onClick={() => props.onToggle()}
      >
        <IconWrench />
        <span>{chipLabel()}</span>
        <IconChevronDown />
      </button>

      <Show when={props.open}>
        <div class="composer-menu toolmode-card" role="dialog" aria-label="工具模式">
          <div class="toolmode-card__head">
            <strong>工具模式</strong>
            <small>本会话生效 · 切换写入会话 meta</small>
          </div>
          <For each={MODE_ROWS}>
            {(row) => (
              <Show
                when={!UNAVAILABLE.has(row.mode)}
                fallback={
                  <div class="toolmode-row is-unavailable" title="后端尚未接入该档">
                    <span class="toolmode-dot" aria-hidden="true" />
                    <span class="toolmode-name">{row.label}</span>
                    <span class="toolmode-hint">{row.hint}</span>
                    <small class="toolmode-count">未接入</small>
                  </div>
                }
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={current() === row.mode ? "true" : "false"}
                  class={{ "toolmode-row": true, selected: current() === row.mode }}
                  disabled={busy()}
                  onClick={() => void pick(row.mode)}
                >
                  <span class="toolmode-dot" aria-hidden="true" />
                  <span class="toolmode-name">{row.label}</span>
                  <span class="toolmode-hint">{row.hint}</span>
                  <Show when={row.count != null}>
                    <small class="toolmode-count">{row.count}</small>
                  </Show>
                </button>
              </Show>
            )}
          </For>
          <Show when={customOpen()}>
            <div class="toolmode-custom">
              <small>白名单工具名,每行一个(按注册名,如 read / exec / grep):</small>
              <textarea
                rows={5}
                spellcheck={false}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
              />
              <button
                type="button"
                class="toolmode-apply"
                disabled={busy() || draft().trim() === ""}
                onClick={() => void applyCustom()}
              >
                应用白名单
              </button>
            </div>
          </Show>
          <small class="composer-menu-note">切换立即生效于下一次模型请求;进行中的回合不受影响</small>
        </div>
      </Show>
    </div>
  );
};
