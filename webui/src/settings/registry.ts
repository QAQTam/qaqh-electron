/**
 * Provider/model catalog 的唯一读模型。
 *
 * `provider.list` 返回 `providers.toml` 目录（ringing-commands-7）：providers、
 * 各 provider 的 models、全局 `default_model_selection` 与目录 `revision`。
 * legacy profile 目录已退役——会话/子代理的模型选择只走
 * `model_selection`（`session.settings.patch` / `model.selection.set_default`）。
 */
import { createSignal } from "solid-js";

import type { CredentialSource } from "../api/qaqh/CredentialSource";
import type { ModelDef } from "../api/qaqh/ModelDef";
import type { ModelSelection } from "../api/qaqh/ModelSelection";
import type { ProviderUpsertDto } from "../api/qaqh/ProviderUpsertDto";
import type { Wire } from "../api/qaqh/Wire";
import { notifyConfigChanged, onConfigChanged } from "../lib/config-events";
import { transport } from "../lib/transport";
import type { ModelEntry } from "../oauth/model-catalog";
import { mergeModelMetadata } from "../oauth/model-metadata";

type ProviderWire = {
  name: string;
  base_url: string;
  wire: string;
  credential: string;
  api_key?: string | null;
  headers?: Record<string, string>;
  compat?: unknown;
  models?: Record<string, ModelDef>;
};
type ProviderCatalog = {
  revision: number;
  default_model_selection?: ModelSelection | null;
  providers: Record<string, ProviderWire>;
};

export type RegistryModel = { id: string; definition: ModelDef };
export type RegistryProvider = {
  id: string;
  name: string;
  baseUrl: string;
  wire: string;
  credential: string;
  apiKeySet: boolean;
  headers: Record<string, string>;
  compat: unknown;
  models: RegistryModel[];
  /** 引用方：目前只有全局默认选择（default_model_selection）。 */
  referencedBy: string[];
};
export type Registry = {
  /** Revision of providers.toml only. */
  revision: number;
  defaultSelection: ModelSelection | null;
  providers: RegistryProvider[];
};
export type ProviderRow = { provider: RegistryProvider };

const CREDENTIAL_LABELS: Record<string, string> = {
  api_key: "API key",
  chatgpt_plan: "ChatGPT 套餐",
  deepseek_account: "DeepSeek 账号",
};
export const credentialLabel = (credential: string): string => CREDENTIAL_LABELS[credential] ?? credential;

const [registry, setRegistry] = createSignal<Registry | null>(null);
const [loading, setLoading] = createSignal(false);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
export { registry, loading as registryLoading, busy as registryBusy, error as registryError };

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function readProviderCatalog(value: unknown): ProviderCatalog {
  const object = record(value);
  const providers = record(object?.providers);
  if (object == null || providers == null || typeof object.revision !== "number" || !Number.isSafeInteger(object.revision) || object.revision < 0) {
    throw new Error("provider.list returned an invalid provider catalog");
  }
  return {
    revision: object.revision,
    default_model_selection: (object.default_model_selection ?? null) as ModelSelection | null,
    providers: providers as Record<string, ProviderWire>,
  };
}

function mapRegistry(catalog: ProviderCatalog): Registry {
  const providers: RegistryProvider[] = Object.entries(catalog.providers).map(([id, provider]) => ({
    id,
    name: provider.name,
    baseUrl: provider.base_url,
    wire: provider.wire,
    credential: provider.credential,
    apiKeySet: provider.api_key === "set" || (typeof provider.api_key === "string" && provider.api_key !== ""),
    headers: provider.headers ?? {},
    compat: provider.compat ?? null,
    models: Object.entries(provider.models ?? {}).map(([modelId, definition]) => ({ id: modelId, definition })),
    referencedBy: [],
  }));
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultSelection = catalog.default_model_selection ?? null;
  if (defaultSelection != null) {
    const provider = byId.get(defaultSelection.provider_id);
    if (provider && !provider.referencedBy.includes("default_model_selection")) provider.referencedBy.push("default_model_selection");
  }
  return { revision: catalog.revision, defaultSelection, providers };
}

export function providerRows(value: Registry): ProviderRow[] {
  return value.providers.map((provider) => ({ provider }));
}

let registryFlight: Promise<Registry> | null = null;
let registryGeneration = 0;
function invalidateRegistry(): void {
  registryGeneration += 1;
  registryFlight = null;
}
onConfigChanged(invalidateRegistry);

function readRegistry(): Promise<Registry> {
  if (registryFlight != null) return registryFlight;
  const generation = registryGeneration;
  const request = fetchRegistry().then(
    (value) => {
      if (generation !== registryGeneration) return readRegistry();
      setRegistry(value);
      return value;
    },
    (error: unknown) => { if (generation !== registryGeneration) return readRegistry(); throw error; },
  );
  registryFlight = request;
  void request.finally(() => { if (registryFlight === request) registryFlight = null; }).catch(() => {});
  return request;
}

async function fetchRegistry(): Promise<Registry> {
  const ack = await transport.command({ type: "provider.list" });
  if (ack.status !== "accepted") throw new Error(ack.message ?? ack.code ?? "provider.list was rejected");
  const catalog = readProviderCatalog(ack.result);
  return mapRegistry(catalog);
}

export async function refreshRegistry(): Promise<void> {
  setLoading(true);
  setError(null);
  try { await readRegistry(); }
  catch (cause) { setError(messageOf(cause)); }
  finally { setLoading(false); }
}

let writeQueue: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;
async function perform<T>(action: () => Promise<T>): Promise<T | null> {
  pendingWrites += 1;
  setBusy(true);
  const task = writeQueue.then(async () => {
    setError(null);
    try {
      const value = await action();
      notifyConfigChanged();
      await readRegistry();
      return value;
    } catch (cause) {
      setError(messageOf(cause));
      return null;
    } finally { pendingWrites -= 1; setBusy(pendingWrites > 0); }
  });
  writeQueue = task;
  return task;
}

async function currentConfigRevision(): Promise<number> {
  let value = registry();
  if (value == null) value = await readRegistry();
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("无法读取 provider catalog revision");
  return value.revision;
}

function revisionFromAck(ack: Awaited<ReturnType<typeof transport.command>>): number | null {
  if (typeof ack.revision === "number" && Number.isSafeInteger(ack.revision) && ack.revision >= 0) return ack.revision;
  const result = record(ack.result);
  return typeof result?.revision === "number" && Number.isSafeInteger(result.revision) && result.revision >= 0
    ? result.revision : null;
}

async function configCommand(command: Parameters<typeof transport.command>[0], current?: number): Promise<void> {
  const revision = current ?? await currentConfigRevision();
  const ack = await transport.command(command, undefined, [{ kind: "config_revision", revision }]);
  if (ack.status !== "accepted") throw new Error(ack.message ?? ack.code ?? "配置更新被拒绝");
  const nextRevision = revisionFromAck(ack);
  if (nextRevision != null && registry() != null) setRegistry((value) => value == null ? value : { ...value, revision: nextRevision });
  else await readRegistry();
}

export type ProviderInput = {
  name: string;
  baseUrl: string;
  wire: string;
  credential: string;
  /** undefined = keep; empty string = clear; otherwise set. */
  apiKey?: string;
};

export function modelSelectionIssue(model: ModelDef | undefined, effort: string | null, maxTokens: number | null): string | null {
  if (model == null || !model.enabled) return "引用的模型不在服务商目录中或已停用";
  if (effort != null && (!model.capabilities.reasoning || !model.reasoning_levels.includes(effort))) {
    return `模型未声明支持推理强度「${effort}」`;
  }
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > model.max_output_tokens)) {
    return `最大输出必须在 1 到 ${model.max_output_tokens.toLocaleString()} 之间`;
  }
  return null;
}

export async function saveProvider(id: string, input: ProviderInput): Promise<boolean> {
  const result = await perform(async () => {
    const existing = registry()?.providers.find((provider) => provider.id === id);
    const apiKey: ProviderUpsertDto["api_key"] = input.apiKey === undefined
      ? { operation: "keep" }
      : input.apiKey === "" ? { operation: "clear" } : { operation: "set", value: input.apiKey };
    const provider: ProviderUpsertDto = {
      name: input.name.trim(),
      base_url: input.baseUrl.trim(),
      wire: input.wire as Wire,
      credential: input.credential as CredentialSource,
      headers: existing?.headers ?? {},
      compat: (existing?.compat ?? null) as ProviderUpsertDto["compat"],
      api_key: apiKey,
    };
    await configCommand({ type: "provider.upsert", id, provider });
    return true;
  });
  return result === true;
}

export async function saveModel(providerId: string, modelId: string, model: ModelDef): Promise<boolean> {
  const result = await perform(async () => {
    if (modelId.trim() === "") throw new Error("model id must be non-empty");
    await configCommand({ type: "provider.model.upsert", provider_id: providerId, model_id: modelId, model });
    return true;
  });
  return result === true;
}

export async function deleteModel(providerId: string, modelId: string): Promise<boolean> {
  const current = registry();
  if (current?.defaultSelection?.provider_id === providerId && current.defaultSelection.model_id === modelId) {
    setError("不能删除当前默认模型；请先选择其他默认模型");
    return false;
  }
  const result = await perform(async () => {
    await configCommand({ type: "provider.model.delete", provider_id: providerId, model_id: modelId });
    return true;
  });
  return result === true;
}

async function setDefaultSelection(selection: ModelSelection): Promise<void> {
  await configCommand({ type: "model.selection.set_default", selection });
}

/** 把服务商目录里的某个模型设为全局默认；BYOK 与账号模型共用这一条写口。 */
export async function setDefaultModel(providerId: string, modelId: string): Promise<boolean> {
  const model = registry()?.providers.find((provider) => provider.id === providerId)
    ?.models.find((entry) => entry.id === modelId)?.definition;
  const issue = modelSelectionIssue(model, null, null);
  if (issue != null) { setError(`模型「${modelId}」${issue}`); return false; }
  const result = await perform(async () => {
    await setDefaultSelection({ provider_id: providerId, model_id: modelId, options: {} });
    return true;
  });
  return result === true;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const result = await perform(async () => {
    await configCommand({ type: "provider.delete", id });
    return true;
  });
  return result === true;
}

const MAX_ID = 64;
export function slugifyId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, MAX_ID);
}
export function newId(name: string, existing: readonly string[], fallbackPrefix = "provider"): string {
  const taken = new Set(existing);
  const base = slugifyId(name) || `${fallbackPrefix}-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type AccountKind = "plan" | "account";
const ACCOUNT_IDENTITY = {
  plan: { credential: "chatgpt_plan", providerId: "openai", providerName: "ChatGPT 套餐" },
  account: { credential: "deepseek_account", providerId: "deepseek-account", providerName: "DeepSeek 账号" },
} as const;

/** Discover/import models without changing the global default or saved profiles. */
export async function syncAccountCatalog(input: {
  kind: AccountKind;
  baseUrl: string;
  models: readonly ModelEntry[];
  isCurrent?: () => boolean;
}): Promise<string | null> {
  return perform(async () => {
    const current = await readRegistry();
    if (input.isCurrent?.() === false) return null;
    const identity = ACCOUNT_IDENTITY[input.kind];
    const existing = current.providers.find((provider) => provider.credential === identity.credential);
    const providerId = existing?.id ?? identity.providerId;
    if (existing == null || existing.baseUrl !== input.baseUrl) {
      await configCommand({ type: "provider.upsert", id: providerId, provider: {
        name: existing?.name ?? identity.providerName,
        base_url: input.baseUrl,
        wire: (existing?.wire ?? "responses") as Wire,
        credential: identity.credential,
        headers: existing?.headers ?? {},
        compat: (existing?.compat ?? null) as ProviderUpsertDto["compat"],
        api_key: { operation: "keep" },
      } });
    }
    for (const entry of input.models) {
      if (input.isCurrent?.() === false) return null;
      const previous = existing?.models.find((model) => model.id === entry.slug)?.definition;
      const model = mergeModelMetadata(entry, previous);
      // A partial listing is still useful in the picker; never invent required limits.
      if (model == null || JSON.stringify(model) === JSON.stringify(previous)) continue;
      await configCommand({ type: "provider.model.upsert", provider_id: providerId, model_id: entry.slug, model });
    }
    return providerId;
  });
}

export async function ensureAccountProfile(input: {
  kind: AccountKind;
  baseUrl: string;
  model: string;
  modelMetadata?: Partial<Omit<ModelEntry, "slug">>;
  makeDefault?: boolean;
}): Promise<{ providerId: string; modelId: string } | null> {
  const providerId = await syncAccountCatalog({
    kind: input.kind, baseUrl: input.baseUrl,
    models: [{ ...input.modelMetadata, slug: input.model, displayName: input.modelMetadata?.displayName ?? "" }],
  });
  if (providerId == null) return null;
  const model = registry()?.providers.find((provider) => provider.id === providerId)
    ?.models.find((entry) => entry.id === input.model)?.definition;
  if (model == null) {
    setError(`模型目录没有提供 ${input.model} 的上下文窗口和最大输出；请先刷新目录，或到「设置 → 服务商」补充该模型。`);
    return null;
  }
  if (!model.enabled) {
    setError(`模型 ${input.model} 已停用，请到「设置 → 服务商」启用后再选择。`);
    return null;
  }
  if (input.makeDefault === true) {
    const selected = await perform(async () => {
      await setDefaultSelection({ provider_id: providerId, model_id: input.model, options: {} });
      return true;
    });
    if (selected !== true) return null;
  }
  return { providerId, modelId: input.model };
}
