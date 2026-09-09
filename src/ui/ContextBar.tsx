// ContextBar（spec §9）：cwd 基名 ▸ 子路径 · mode · model · 上下文%。
// 仅渲染 activeSeed 的数据；mode 点击即发 set_mode（非本地态）。
import { Show, createMemo } from "solid-js";
import type { Component } from "solid-js";
import { tabsStore } from "../state/tabs";

export const ContextBar: Component = () => {
  const tab = createMemo(() => tabsStore.activeTab());

  const cwdParts = createMemo(() => {
    const cwd = tab()?.meta.cwd ?? "";
    if (!cwd) return null;
    const norm = cwd.replace(/[\\/]+$/, "");
    const parts = norm.split(/[\\/]/);
    const base = parts.pop() ?? "";
    const sub = parts.slice(-1)[0] ?? "";
    return { base, sub };
  });

  const ctxPct = createMemo(() => {
    const t = tab();
    if (!t || !t.meta.contextLimit) return null;
    return Math.min(100, Math.round((t.meta.contextUsed / t.meta.contextLimit) * 100));
  });

  return (
    <div class="contextbar">
      <Show when={cwdParts()} fallback={<span class="ctx-path">（未关联目录）</span>}>
        {(p) => (
          <span class="ctx-path" title={tab()?.meta.cwd}>
            {p().base}
            <Show when={p().sub}>
              <span class="sep">▸</span>
              <span style={{ color: "var(--text-3)" }}>{p().sub}</span>
            </Show>
          </span>
        )}
      </Show>
      <div class="ctx-mode" role="group" aria-label="会话模式">
        <button
          class={{ on: tab()?.meta.mode === "plan" }}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("qaqh:setMode", { detail: { seed: tabsStore.activeSeed(), mode: "plan" } }),
            )
          }
        >
          PLAN
        </button>
        <button
          class={{ on: tab()?.meta.mode === "code" }}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("qaqh:setMode", { detail: { seed: tabsStore.activeSeed(), mode: "code" } }),
            )
          }
        >
          CODE
        </button>
      </div>
      <Show when={tab()?.meta.model}>
        <span class="ctx-model">{tab()!.meta.model}</span>
      </Show>
      <Show when={ctxPct() !== null}>
        <span class="ctx-usage">ctx {ctxPct()}%</span>
      </Show>
    </div>
  );
};
