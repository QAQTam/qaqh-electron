/**
 * 作曲家侧的**全局模型/强度状态**。
 *
 * 为什么放在这里而不是 composer 组件内部：强度和模型是 **daemon 全局配置**，
 * 不属于任何一条会话（会话级的是 profile，走 `session.set_profile`）。这一层
 * 只做三件事：
 *
 * 1. 读一次 `config.load`（credential / model / reasoningEffort 都从这一份来）；
 * 2. 写的时候**只发改动的那个字段**（K3 合并补丁）——绝不整包写回，否则会把
 *    设置页里未保存的草稿一起提交；
 * 3. 写成功后把该字段记进**当前 provider 的槽位**（`../oauth/provider-state`），
 *    于是切换 provider 时能连带把强度/模型一起换过去、换回来。
 *
 * 强度卡是**全局**的：BYOK 与套餐都走它。可用档位由模型特判决定
 * （`../models/specs` 的 `efforts`，缺省 = 全阶梯，后端再按端点 compat 钳制）。
 */
import { createSignal } from "solid-js";

import type { ConfigDto } from "../api/qaqh/ConfigDto";
import {
  catalogKindOf,
  fetchModelCatalog,
  modelOptions,
  type ModelEntry,
} from "../oauth/model-catalog";
import { transport } from "../lib/transport";
import { notifyConfigChanged } from "../lib/config-events";
import { modelEfforts, modelSpec, type ReasoningTier, type SpecBucket } from "../models/specs";
import { isAccountCredential, isDeepseekAccountMode, isPlanMode } from "../oauth/mode";
import {
  activeProviderId,
  loadState,
  rememberState,
  saveState,
  type ProviderStateMap,
} from "../oauth/provider-state";
import { providerById } from "../oauth/providers";

/** 已保存事实（`config.load`）。null = 还没读到（或读失败）。 */
const [config, setConfig] = createSignal<ConfigDto | null>(null);
const [catalog, setCatalog] = createSignal<ModelEntry[] | null>(null);
const [catalogError, setCatalogError] = createSignal<string | null>(null);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export { busy as configBusy, catalogError, error as configError };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 当前凭据来源决定模型特判读哪个桶（套餐 / DeepSeek 账号 / BYOK）。 */
export function specBucket(): SpecBucket {
  const current = config();
  if (isPlanMode(current)) return "plan";
  if (isDeepseekAccountMode(current)) return "account";
  return "byok";
}

export const currentModel = (): string => config()?.model ?? "";
export const currentEffort = (): string => config()?.reasoningEffort ?? "";
/** 套餐(OAuth)是否生效:读 daemon 全局配置,与 `specBucket` 同一份事实。 */
export const planActive = (): boolean => isPlanMode(config());
/** 账号类额度（套餐或 DeepSeek 账号）：都要拉账户级模型目录，也都要走目录选择器。 */
export const accountActive = (): boolean => isAccountCredential(config());
/** 目录原样条目（调试用；渲染请用 [`catalogOptions`]，那条才带正确的展示名与兜底项）。 */
export const catalogModels = (): ModelEntry[] | null => catalog();

/**
 * 选择器要列的条目：**这一家的目录** + 配置里当前那个模型。
 *
 * 当前值可能不在目录里（切过账户、上游改名、`switchFields` 的"空串 = 保持现值"
 * 留下的旧 slug）——不列出来的话，用户点开就是一屏没有选中项的列表，看起来跟
 * "这家没有模型"一模一样。
 */
export function catalogOptions(): ModelEntry[] {
  const current = config();
  const entries = catalog();
  if (current == null || entries == null) return [];
  const provider = providerById(activeProviderId(current));
  if (provider == null) return [];
  return modelOptions(provider.kind, entries, [current.model]);
}

/** 当前模型可用的档位（缺省全阶梯）。 */
export function availableTiers(): readonly ReasoningTier[] {
  return modelEfforts(modelSpec(specBucket(), currentModel()).spec);
}

/** 后端那份配置**读到了没有**。没读到就不能对外报任何档名（见 `effortDisplayOf`）。 */
export const configLoaded = (): boolean => config() != null;

let booted = false;

/**
 * 启动时读一次配置与目录。**这一句是本次修复的正主**：
 *
 * 强度 chip 与模型行渲染的都是这里的值，而此前只有"点开强度卡"那一刻才会读
 * ——于是首帧 `currentEffort()` 是空串，界面按"第一档"画，用户看到的就是
 * 「默认轻度」，点进去才变回真值。配置是 daemon 全局态，读它不该等用户点开。
 */
export async function bootModelConfig(): Promise<void> {
  if (booted) return;
  booted = true;
  await refreshConfig();
  await loadCatalog();
}

/** 当前模型的默认档（重置键用）。 */
export function defaultTier(): ReasoningTier {
  const spec = modelSpec(specBucket(), currentModel()).spec;
  const allowed = modelEfforts(spec);
  if (spec.defaultEffort != null && allowed.includes(spec.defaultEffort)) return spec.defaultEffort;
  return allowed[Math.floor(allowed.length / 2)] ?? "medium";
}

export async function refreshConfig(): Promise<void> {
  try {
    setConfig(await transport.rpc<ConfigDto>("config.load"));
    setError(null);
  } catch (cause) {
    setError(messageOf(cause));
  }
}

/**
 * 拉一次账户级模型目录。BYOK 模式下**不拉**——那个目录是账户级的，与自带端点无关。
 * 失败不清空已有目录：一次网络抖动不该让选择器变空。
 *
 * 配置还没读到时**先等它**：这一层的全部判据都来自 `credential`，而调用方（输入区
 * 打开卡片那一刻）是把 `refreshConfig()` 与 `loadCatalog()` 并排发出的。不等待就
 * 会拿着 `null` 判成"没在用账号额度"，于是套餐明明连着、选择器却永远是空的
 * ——而且空在那儿，直到用户关掉卡片再开一次。
 */
export async function loadCatalog(): Promise<void> {
  let current = config();
  if (current == null) {
    await refreshConfig();
    current = config();
  }
  const provider = current == null ? null : providerById(activeProviderId(current));
  const kind = provider == null ? null : catalogKindOf(provider.kind);
  if (kind == null) {
    setCatalog(null);
    setCatalogError(null);
    return;
  }
  try {
    // 两家的目录各有各的来源：套餐走 `siwc.models`（ChatGPT 目录），
    // DeepSeek 账号走推理 origin 自己的 `/models`（`dsaccount.models`）。
    setCatalog(await fetchModelCatalog(kind));
    setCatalogError(null);
  } catch (cause) {
    setCatalogError(messageOf(cause));
  }
}

/** 只发一个字段的合并补丁，并把结果记进当前 provider 的槽位。 */
async function patchAndRemember(field: "model" | "effort", value: string): Promise<boolean> {
  const current = config();
  if (current == null || busy()) return false;
  setBusy(true);
  setError(null);
  try {
    const payload = field === "model" ? { model: value } : { reasoningEffort: value };
    await transport.rpc("config.save", payload);
    // 记进槽位：切换 provider 时这一份要能跟着走。
    const states: ProviderStateMap = rememberState(
      loadState(),
      activeProviderId(current),
      field === "model" ? { model: value } : { effort: value },
    );
    saveState(states);
    await refreshConfig();
    // 模型/档位也是一份全局配置:设置页与输入区之外还有别的镜像(上下文百分比),
    // 这里已经重读过自己的读模型了,顺手让其它镜像重读一次。
    notifyConfigChanged();
    return true;
  } catch (cause) {
    setError(messageOf(cause));
    return false;
  } finally {
    setBusy(false);
  }
}

export const setEffort = (tier: ReasoningTier): Promise<boolean> => patchAndRemember("effort", tier);
export const setModel = (model: string): Promise<boolean> => patchAndRemember("model", model);
