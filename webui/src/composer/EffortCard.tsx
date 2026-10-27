/**
 * 强度卡（对齐 Codex 桌面端那张）：档位名 + 档位图标 + `模型 ›` 行 + 可拖的分段
 * 轨道 + 重置，触发器是控制条上的一个 chip。
 *
 * **全局可用**：它读写的是 daemon 全局配置里的 `reasoningEffort` / `model`，与
 * 凭据来源无关；可用档位由模型特判（`../models/specs`）决定，缺省是全阶梯
 * （low→medium→high→xhigh→ultra），后端再按端点 compat 钳制。
 *
 * 复刻上的三处取舍，都写在明处：
 * - **档位图标**按 Codex 的"几档共用图标"来分（低档闪电 / 高档脑 / Ultra 星），
 *   但用的是我们自己图标集里语义最近的，不是抄它的 SVG；
 * - **配色只分两级**（普通 = 绿，Ultra = 紫），与截图一致；颜色不承担具体档位，
 *   档位名已经说清了；
 * - **轨道**是自定义可拖的（pointer + 键盘 ←/→），不是原生 range：截图里那根
 *   带刻度点的轨道原生控件做不出来。
 */
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch, type Component } from "solid-js";
import IconBrain from "~icons/lucide/brain";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconRotateCcw from "~icons/lucide/rotate-ccw";
import IconSparkles from "~icons/lucide/sparkles";
import IconZap from "~icons/lucide/zap";

import { modelSpec, type ReasoningTier } from "../models/specs";
import { STR } from "../lib/strings";
import {
  effortDisplayOf,
  effortFillPercent,
  stepTier,
  tierIndexForPointer,
  tierTone,
  type EffortDisplay,
} from "./effort-track";
import {
  accountActive,
  availableTiers,
  catalogError,
  catalogOptions,
  configBusy,
  configError,
  configLoaded,
  currentEffort,
  currentModel,
  defaultTier,
  loadCatalog,
  refreshConfig,
  setEffort,
  setModel,
  specBucket,
} from "./model-config";

/** 档位中文名：与 Codex 的中文词条一致（轻度 / 中 / 高 / 极高 / Ultra）。 */
const TIER_LABEL: Record<ReasoningTier, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "Ultra",
};

export const EffortCard: Component<{
  open: boolean;
  onToggle: () => void;
}> = (props) => {
  const [pickingModel, setPickingModel] = createSignal(false);
  const [customModel, setCustomModel] = createSignal("");
  const [dragging, setDragging] = createSignal(false);
  /** 拖动中的**本地预览值**：不落盘，松手才写一次。 */
  const [pending, setPending] = createSignal<ReasoningTier | null>(null);
  let track: HTMLDivElement | undefined;

  // 打开时读一次配置；账号额度模式（套餐或 DeepSeek 账号）再拉一次该家的模型目录。
  // 顺序不必操心：`loadCatalog` 自己会等配置到位（否则第一次打开永远是空列表）。
  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setPickingModel(false);
      setCustomModel(currentModel());
      void refreshConfig();
      void loadCatalog();
    },
  );

  onCleanup(() => setDragging(false));

  const tiers = (): readonly ReasoningTier[] => availableTiers();

  /**
   * 后端真值的三态判定（`effortDisplayOf`）。
   *
   * 关键在**没读到时不许报档名**：以前这里写的是
   * `allowed.find((t) => t === currentEffort()) ?? allowed[0]`，配置还没 load 回来的
   * 首帧就把 `low`（"轻度"）画成事实——而 `impl Default for Config` 的
   * `reasoning_effort` 是 `high`。
   */
  const display = (): EffortDisplay => effortDisplayOf(currentEffort(), tiers(), configLoaded());

  /** chip 上的字：预览值 > 后端真值 > 三态里那句老实话（不认识的值原样显示，不冒充第一档）。 */
  const chipLabel = (): string => {
    const preview = pending();
    if (preview != null) return TIER_LABEL[preview];
    const state = display();
    if (state.kind === "tier") return TIER_LABEL[state.tier];
    if (state.kind === "offLadder") return state.raw;
    return state.kind === "unset" ? STR.effortUnset : STR.effortPending;
  };

  /**
   * 轨道指向的档。轨道是**控件**，总得有个位置：没读到/越表时停到首档，
   * 拖动或按方向键都会写出一个真实合法值。显示用 `chipLabel`，两者刻意不同。
   */
  const trackTier = (): ReasoningTier => {
    const preview = pending();
    if (preview != null) return preview;
    const state = display();
    if (state.kind === "tier") return state.tier;
    return tiers()[0] ?? "medium";
  };

  const index = (): number => Math.max(0, tiers().indexOf(trackTier()));
  const fill = (): number => effortFillPercent(index(), tiers().length);

  const modelLabel = (): string => {
    const model = currentModel();
    if (model === "") return "未设置模型";
    const { spec, known } = modelSpec(specBucket(), model);
    const name = spec.displayName ?? model;
    const base = name === model ? name : `${name}（${model}）`;
    return known ? base : `${base} · 未收录`;
  };

  /**
   * 指针位置 → 档位。拖动期间**只改本地预览**：一次拖拽可能跨好几档，每跨一档
   * 就发一次 `config.save` 会连发多次落盘 + 热载广播（而且中途的档位用户根本没
   * 打算用）。松手时 `commitPending` 写一次。
   */
  const applyPointer = (clientX: number): void => {
    const node = track;
    if (node == null) return;
    const rect = node.getBoundingClientRect();
    const next = tiers()[tierIndexForPointer(clientX, rect, tiers().length)];
    if (next != null) setPending(next);
  };

  /** 松手落盘。写成功（`setEffort` 内含重新读配置）之后再清预览，避免闪回旧值。 */
  const commitPending = async (): Promise<void> => {
    const next = pending();
    if (next == null) return;
    await setEffort(next);
    setPending(null);
  };

  return (
    <div class="composer-control-wrap">
      <button
        type="button"
        class="composer-tool-button effort-trigger"
        aria-expanded={props.open ? "true" : "false"}
        title="推理强度与模型"
        onClick={() => props.onToggle()}
      >
        <span class={`effort-tone-${tierTone(trackTier())}`}>{chipLabel()}</span>
        <IconChevronDown />
      </button>

      <Show when={props.open}>
        <div class="composer-menu effort-card" role="dialog" aria-label="推理强度与模型">
          <div class="effort-card__head">
            <span class="effort-card__tier-icon" aria-hidden="true">
              <Switch>
                <Match when={trackTier() === "ultra"}>
                  <IconSparkles />
                </Match>
                <Match when={trackTier() === "low" || trackTier() === "medium"}>
                  <IconZap />
                </Match>
                <Match when={true}>
                  <IconBrain />
                </Match>
              </Switch>
            </span>
            <strong class={`effort-card__tier effort-tone-${tierTone(trackTier())}`}>
              {chipLabel()}
            </strong>
            <button
              type="button"
              class="icon-btn effort-card__reset"
              title="重置为该模型的默认档"
              disabled={configBusy()}
              onClick={() => void setEffort(defaultTier())}
            >
              <IconRotateCcw />
            </button>
          </div>

          <button
            type="button"
            class="effort-card__model"
            aria-expanded={pickingModel() ? "true" : "false"}
            onClick={() => setPickingModel(!pickingModel())}
          >
            <span>{modelLabel()}</span>
            <IconChevronDown />
          </button>

          <Show when={pickingModel()}>
            <div class="effort-card__models" role="menu">
              <Show
                when={accountActive() && catalogOptions().length > 0}
                fallback={
                  <>
                    {/*
                      账号额度（套餐 / DeepSeek 账号）下目录没到位：说**真原因**
                      （catalogError 才是这次拉取为什么失败的权威），并且仍然留一条
                      手填的路 —— 只能看着的空列表等于把推理堵死。BYOK 本来就没有
                      账户级目录，直接进手填。
                    */}
                    <Show when={accountActive()}>
                      <small class="effort-card__note">
                        {catalogError() ??
                          configError() ??
                          "模型目录为空：完成登录或到接入页「刷新目录」后重试；也可以直接填模型 id。"}
                      </small>
                    </Show>
                    <div class="effort-card__custom">
                      <input
                        class="field-input"
                        value={customModel()}
                        placeholder="模型 id（目录拿不到时自己填）"
                        onInput={(event) => setCustomModel(event.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="ghost-mini"
                        disabled={configBusy() || customModel().trim() === ""}
                        onClick={() => {
                          const next = customModel().trim();
                          if (next !== "") void setModel(next).then(() => setPickingModel(false));
                        }}
                      >
                        使用
                      </button>
                    </div>
                  </>
                }
              >
                <For each={catalogOptions()}>
                  {(entry) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={entry.slug === currentModel() ? "true" : "false"}
                      class={entry.slug === currentModel() ? "selected" : undefined}
                      onClick={() => {
                        void setModel(entry.slug).then(() => setPickingModel(false));
                      }}
                    >
                      <span>{entry.displayName}</span>
                      <small>{entry.slug}</small>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>

          <div
            ref={(node) => {
              track = node;
            }}
            class={`effort-track effort-tone-${tierTone(trackTier())}${dragging() ? " is-dragging" : ""}`}
            role="slider"
            tabindex="0"
            aria-valuemin={0}
            aria-valuemax={tiers().length - 1}
            aria-valuenow={index()}
            aria-valuetext={chipLabel()}
            onPointerDown={(event) => {
              setDragging(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              applyPointer(event.clientX);
            }}
            onPointerMove={(event) => {
              if (dragging()) applyPointer(event.clientX);
            }}
            onPointerUp={(event) => {
              setDragging(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              void commitPending();
            }}
            onPointerCancel={() => {
              setDragging(false);
              setPending(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              void setEffort(stepTier(tiers(), trackTier(), delta));
            }}
          >
            <span class="effort-track__fill" style={{ width: `${fill()}%` }} />
            <For each={tiers()}>
              {(_, at) => (
                <span
                  class="effort-track__dot"
                  style={{ left: `${effortFillPercent(at(), tiers().length)}%` }}
                  aria-hidden="true"
                />
              )}
            </For>
            <span class="effort-track__thumb" style={{ left: `${fill()}%` }} />
          </div>

          {/*
            三态里那两种"不是后端真值"的状态必须在卡面上交代：chip 的字已经诚实了，
            但轨道停在首档会让人觉得"后端就是轻度"——那正是这次要修的错觉。
          */}
          <Show when={display().kind === "offLadder"}>
            <p class="effort-card__note is-error">{STR.effortOffLadder(currentEffort())}</p>
          </Show>
          <Show when={display().kind === "pending" || display().kind === "unset"}>
            <p class="effort-card__note">
              {display().kind === "pending" ? STR.effortPendingHint : STR.effortUnsetHint}
            </p>
          </Show>

          <p class="effort-card__note">
            拖动或按 ←/→ 选择；拖动时预览，松手写入（只写这一个字段）。
          </p>
          <Show when={configError() != null}>
            {(message) => <p class="effort-card__note is-error">{message()}</p>}
          </Show>
        </div>
      </Show>
    </div>
  );
};
