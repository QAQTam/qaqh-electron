/**
 * 作曲家侧的模型/强度**读模型**（只读）。
 *
 * `config.load` 给出当前默认存档的 credential/model/effort，作为会话没有覆写时的
 * 回退值。会话内的写入走 `SessionStore` 的 `session.settings.patch`；全局配置的
 * 写口是「设置 → 服务商 / 存档」（`../settings/registry`），**不经过这里**。
 *
 * 目录与档位按 **provider 类别**参数化：同一时刻不同会话可以选到不同 Profile，
 * 拿全局活跃项那一份会把模型目录与可用档位算到别的 provider 头上。可用档位由
 * 用户登记的模型定义或在线目录给出，不按模型名字推测。
 */
import { loadConfigSnapshot } from "../lib/config-snapshot";

import { createSignal } from "solid-js";

import type { ConfigDto } from "../api/qaqh/ConfigDto";
import {
  catalogKindOf,
  fetchModelCatalog,
  modelOptions,
  type CatalogKind,
  type ModelEntry,
} from "../oauth/model-catalog";
import { reasoningTiers, type ReasoningTier } from "../models/reasoning";
import { providerKindOfCredential, type ProviderKind } from "../oauth/mode";
import { refreshRegistry, registry } from "../settings/registry";

/** 已保存事实（`config.load`）。null = 还没读到（或读失败）。 */
const [config, setConfig] = createSignal<ConfigDto | null>(null);
/** 按目录来源缓存：套餐与 DeepSeek 账号可以同时留在内存里，互不覆盖。 */
const [catalogs, setCatalogs] = createSignal<Partial<Record<CatalogKind, ModelEntry[]>>>({});
const [catalogErrors, setCatalogErrors] = createSignal<Partial<Record<CatalogKind, string>>>({});
const [error, setError] = createSignal<string | null>(null);

export { error as configError };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 全局活跃 provider 的类别；配置未到时按 BYOK（它没有账户级目录）。 */
export function currentProviderKind(): ProviderKind {
  const current = registry();
  const provider = current?.providers.find((item) => item.id === current.defaultSelection?.provider_id);
  return providerKindOfCredential(provider?.credential ?? config()?.credential);
}

export const currentModel = (): string => registry()?.defaultSelection?.model_id ?? config()?.model ?? "";
export const currentEffort = (): string => {
  const current = registry();
  const selection = current?.defaultSelection;
  if (selection == null) return config()?.reasoningEffort ?? "";
  const definition = current?.providers.find((provider) => provider.id === selection.provider_id)
    ?.models.find((model) => model.id === selection.model_id)?.definition;
  return selection.options.reasoning_effort ?? definition?.defaults.reasoning_effort ?? "";
};
/** 某 provider 类别的目录原样条目；BYOK 恒为 null（没有账户级目录）。 */
export function catalogModels(kind: ProviderKind): ModelEntry[] | null {
  const ck = catalogKindOf(kind);
  return ck == null ? null : (catalogs()[ck] ?? null);
}

/** 某 provider 类别最近一次目录拉取的错误；BYOK 恒为 null。 */
export function catalogError(kind: ProviderKind): string | null {
  const ck = catalogKindOf(kind);
  return ck == null ? null : (catalogErrors()[ck] ?? null);
}

/**
 * 选择器要列的条目：**这一家的目录** + 配置里当前那个模型。
 *
 * 当前值可能不在目录里（切过账户、上游改名、`switchFields` 的"空串 = 保持现值"
 * 留下的旧 slug）——不列出来的话，用户点开就是一屏没有选中项的列表，看起来跟
 * "这家没有模型"一模一样。
 */
export function catalogOptions(kind: ProviderKind, model: string): ModelEntry[] {
  const ck = catalogKindOf(kind);
  if (ck == null) return modelOptions([], [model]);
  // 账号类目录尚未到位时返回空，让调用方显示「目录拿不到」的可操作提示；
  // 只列当前模型会让用户误以为这家只有这一个模型。
  const entries = catalogs()[ck];
  if (entries == null) return [];
  return modelOptions(entries, [model]);
}

/** 指定 provider 类别下，某模型可用的档位（会话传会话有效模型）。 */
export function availableTiers(kind: ProviderKind, model: string): readonly ReasoningTier[] {
  return reasoningTiers(modelMetadata(kind, model)?.reasoningLevels);
}

export function modelMetadata(kind: ProviderKind, model: string): ModelEntry | undefined {
  const current = registry();
  const providers = current?.providers.filter((item) =>
    providerKindOfCredential(item.credential) === kind && item.models.some((entry) => entry.id === model)) ?? [];
  const provider = providers.find((item) => item.id === current?.defaultSelection?.provider_id)
    ?? (providers.length === 1 ? providers[0] : undefined);
  const definition = provider?.models.find((entry) => entry.id === model)?.definition;
  const online = catalogModels(kind)?.find((entry) => entry.slug === model);
  if (definition != null) return {
    slug: model, displayName: definition.display_name ?? model,
    contextWindow: definition.context_window,
    maxOutputTokens: definition.max_output_tokens,
    reasoningLevels: definition.capabilities.reasoning ? definition.reasoning_levels : kind === "byok" ? [] : undefined,
    defaultEffort: definition.defaults.reasoning_effort ?? undefined,
    ...online,
  };
  return online;
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

/** 指定 provider 类别下，某模型的默认档（重置键用）。 */
export function defaultTier(kind: ProviderKind, model: string): ReasoningTier | null {
  const metadata = modelMetadata(kind, model);
  return availableTiers(kind, model).find((tier) => tier === metadata?.defaultEffort) ?? null;
}

export async function refreshConfig(): Promise<void> {
  try {
    const [next] = await Promise.all([loadConfigSnapshot(), refreshRegistry()]);
    setConfig(next);
    setError(null);
  } catch (cause) {
    setError(messageOf(cause));
  }
}

async function loadCatalogKind(kind: CatalogKind): Promise<void> {
  try {
    // 两家的目录各有各的来源：套餐走 `siwc.models`（ChatGPT 目录），
    // DeepSeek 账号走推理 origin 自己的 `/models`（`dsaccount.models`）。
    const entries = await fetchModelCatalog(kind);
    setCatalogs((previous) => ({ ...previous, [kind]: entries }));
    setCatalogErrors((previous) => {
      if (previous[kind] == null) return previous;
      const next = { ...previous };
      delete next[kind];
      return next;
    });
  } catch (cause) {
    // 失败不清空已有目录：一次网络抖动不该让选择器变空。
    setCatalogErrors((previous) => ({ ...previous, [kind]: messageOf(cause) }));
  }
}

/**
 * 拉一次账户级模型目录。BYOK 模式下**不拉**——那个目录是账户级的，与自带端点无关。
 *
 * 不传 `providerKind` 时按全局活跃 provider 取（启动预热）。会话卡片必须传
 * **本会话有效 Profile 的类别**：同一时刻不同会话可以选到不同 provider，
 * 拿全局那一份会把模型目录与档位算到别的 provider 头上。
 *
 * 全局模式下配置还没读到时**先等它**：调用方（输入区打开卡片那一刻）是把
 * `refreshConfig()` 与 `loadCatalog()` 并排发出的。不等待就会拿着 `null`
 * 判成"没在用账号额度"，于是套餐明明连着、选择器却永远是空的。
 */
export async function loadCatalog(providerKind?: ProviderKind | null): Promise<void> {
  let kind: ProviderKind | null = providerKind ?? null;
  if (kind == null) {
    let current = config();
    if (current == null) {
      await refreshConfig();
      current = config();
    }
    kind = current == null ? null : providerKindOfCredential(current.credential);
  }
  const catalogKind = kind == null ? null : catalogKindOf(kind);
  if (catalogKind != null) await loadCatalogKind(catalogKind);
}
