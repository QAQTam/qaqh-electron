/**
 * 统一「模型 + 推理强度」快捷菜单（对齐 Antigravity Model + Thinking effort 二级浮层）。
 *
 * 单一入口同时完成：
 *  1) 选择服务商与模型（按服务商轻分组）；
 *  2) 对支持推理强度的模型，悬停/聚焦在右侧滑出极简强度二级卡片一键选定。
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconSettings from "~icons/lucide/settings";
import IconSparkles from "~icons/lucide/sparkles";

import type { ReasoningTier } from "../models/reasoning";
import { providerKindOfCredential, type ProviderKind } from "../oauth/mode";
import { registry } from "../settings/registry";
import {
  availableTiers,
  currentEffort,
  currentModel,
  currentProviderKind,
  defaultTier,
} from "./model-config";

/** 直接展示官方配置术语，不做中文映射。 */
const KNOWN_TIERS: ReadonlySet<string> = new Set<ReasoningTier>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

interface ModelEntry {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  modelId: string;
  label: string;
  tiers: readonly ReasoningTier[];
}

export const EffortCard: Component<{
  open: boolean;
  onToggle: () => void;
  model?: () => string | null;
  modelOverridden?: () => boolean;
  onModel?: (model: string | null) => Promise<void> | void;
  onSelection?: (providerId: string, modelId: string) => Promise<void> | void;
  onManageProfiles?: () => void;
  providerKind?: () => ProviderKind;
  effort?: () => string | null;
  effortOverridden?: () => boolean;
  onEffort?: (effort: ReasoningTier | null) => Promise<void> | void;
  maxTokens?: () => number | null;
  onMaxTokens?: (maxTokens: number | null) => Promise<void> | void;
}> = (props) => {
  const [hoveredKey, setHoveredKey] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const activeModelId = (): string => {
    if (props.model != null) {
      const m = props.model();
      if (m != null && m !== "") return m;
    }
    const def = registry()?.defaultSelection?.model_id;
    return def ?? currentModel() ?? "";
  };

  const activeProviderKind = (): ProviderKind =>
    props.providerKind?.() ?? currentProviderKind();

  const activeEffort = (): ReasoningTier | null => {
    const raw = props.effort != null ? props.effort() : currentEffort();
    if (raw != null && KNOWN_TIERS.has(raw)) return raw as ReasoningTier;
    const mid = activeModelId();
    return mid ? defaultTier(activeProviderKind(), mid) : null;
  };

  const providerGroups = createMemo(() => {
    const reg = registry();
    if (!reg) return [];
    return reg.providers
      .map((provider) => {
        const kind = providerKindOfCredential(provider.credential);
        const models: ModelEntry[] = provider.models
          .filter((m) => m.definition.enabled)
          .map((m) => ({
            providerId: provider.id,
            providerName: provider.name,
            providerKind: kind,
            modelId: m.id,
            label: m.definition.display_name || m.id,
            tiers: availableTiers(kind, m.id),
          }));
        return { id: provider.id, name: provider.name, models };
      })
      .filter((g) => g.models.length > 0);
  });

  const activeModelDisplay = createMemo(() => {
    const mid = activeModelId();
    if (!mid) return "选择模型";
    for (const g of providerGroups()) {
      const found = g.models.find((m) => m.modelId === mid);
      if (found) return found.label;
    }
    return mid;
  });

  const activeTiers = createMemo(() => {
    const mid = activeModelId();
    return mid ? availableTiers(activeProviderKind(), mid) : [];
  });

  const hoveredEntry = createMemo<ModelEntry | null>(() => {
    const key = hoveredKey();
    if (!key) return null;
    for (const g of providerGroups()) {
      const found = g.models.find((m) => `${m.providerId}:${m.modelId}` === key);
      if (found && found.tiers.length > 0) return found;
    }
    return null;
  });

  const pickModelAndEffort = async (entry: ModelEntry, tier?: ReasoningTier): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    try {
      const changedModel = entry.modelId !== activeModelId();
      if (changedModel) {
        if (props.onSelection != null) {
          await props.onSelection(entry.providerId, entry.modelId);
        } else {
          await props.onModel?.(entry.modelId);
        }
      }
      if (tier != null) {
        await props.onEffort?.(tier);
      }
      setHoveredKey(null);
      props.onToggle();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="composer-control-wrap model-effort-wrap">
      <button
        type="button"
        class="composer-tool-button model-effort-trigger"
        aria-expanded={props.open ? "true" : "false"}
        title="切换模型与推理强度"
        onClick={() => {
          setHoveredKey(null);
          props.onToggle();
        }}
      >
        <IconSparkles />
        <span class="model-effort-name">{activeModelDisplay()}</span>
        <Show when={activeTiers().length > 0 && activeEffort() != null}>
          <span class="model-effort-tier">{activeEffort()!}</span>
        </Show>
        <IconChevronDown />
      </button>

      <Show when={props.open}>
        <div
          class="composer-menu model-effort-popover"
          role="menu"
          aria-label="选择模型与推理强度"
          onMouseLeave={() => setHoveredKey(null)}
        >
          <div class="composer-popover-title">模型</div>
          <div class="model-effort-list">
            <Show
              when={providerGroups().length > 0}
              fallback={
                <div class="composer-popover-empty">暂无可用模型，请先在设置中配置服务商。</div>
              }
            >
              <For each={providerGroups()}>
                {(group) => (
                  <div class="model-effort-group">
                    <div class="model-effort-group-label">{group.name}</div>
                    <For each={group.models}>
                      {(entry) => {
                        const rowKey = `${entry.providerId}:${entry.modelId}`;
                        const isSelected = () => entry.modelId === activeModelId();
                        const hasTiers = entry.tiers.length > 0;
                        return (
                          <button
                            type="button"
                            role="menuitem"
                            class={{
                              "model-effort-item": true,
                              selected: isSelected(),
                              "is-hovered": hoveredKey() === rowKey,
                            }}
                            disabled={busy()}
                            onMouseEnter={() => setHoveredKey(hasTiers ? rowKey : null)}
                            onFocus={() => setHoveredKey(hasTiers ? rowKey : null)}
                            onClick={() => void pickModelAndEffort(entry)}
                          >
                            <span class="model-effort-item-main">
                              <span class="model-effort-item-name">{entry.label}</span>
                              <Show when={isSelected() && hasTiers && activeEffort() != null}>
                                <span class="model-effort-item-tier">{activeEffort()!}</span>
                              </Show>
                            </span>
                            <span class="model-effort-item-end">
                              <Show when={isSelected()}>
                                <IconCheck class="model-effort-check" />
                              </Show>
                              <Show when={hasTiers}>
                                <IconChevronRight class="model-effort-arrow" />
                              </Show>
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <Show when={props.onManageProfiles != null}>
            <div class="composer-popover-foot">
              <button
                type="button"
                class="model-effort-manage"
                onClick={() => {
                  props.onToggle();
                  props.onManageProfiles?.();
                }}
              >
                <IconSettings />
                <span>管理服务商与模型…</span>
              </button>
            </div>
          </Show>

          {/* 右侧二级浮层：Thinking effort */}
          <Show when={hoveredEntry()}>
            {(entry) => (
              <div class="model-effort-sub" role="menu" aria-label="推理强度">
                <div class="composer-popover-title">推理强度</div>
                <For each={entry().tiers}>
                  {(tier) => {
                    const checked = () =>
                      entry().modelId === activeModelId() && activeEffort() === tier;
                    return (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={checked() ? "true" : "false"}
                        class={{ "model-effort-sub-item": true, selected: checked() }}
                        disabled={busy()}
                        onClick={() => void pickModelAndEffort(entry(), tier)}
                      >
                        <span>{tier}</span>
                        <Show when={checked()}>
                          <IconCheck class="model-effort-check" />
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
};
