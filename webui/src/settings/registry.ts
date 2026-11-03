/**
 * Provider/model catalog plus the separate legacy profile service.
 *
 * `provider.list` is the authority for providers, model definitions, the global
 * default model selection, and its `config_revision`. `profile.list` remains a
 * separate read model for saved profile names; its revision is never used to
 * guard provider or model writes.
 */
import { createSignal } from "solid-js";

import type { CredentialSource, ModelDef, ModelSelection, ProviderUpsertDto, Wire } from "@qaqh/sdk/protocol";
import { notifyConfigChanged } from "../lib/config-events";
import { transport } from "../lib/transport";

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
type ProfileWire = {
  name: string;
  provider: string;
  model: string;
  reasoning_effort?: string | null;
  max_tokens?: number | null;
};
type LegacyProfilesDocument = {
  default_profile?: string | null;
  providers?: Record<string, ProviderWire>;
  profiles?: Record<string, ProfileWire>;
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
  referencedBy: string[];
};
export type RegistryProfile = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: string | null;
  contextLength: number | null;
  maxTokens: number | null;
  isDefault: boolean;
  credential: string;
};
export type Registry = {
  /** Revision of providers.toml only. */
  revision: number;
  defaultSelection: ModelSelection | null;
  /** Legacy profile reference matching defaultSelection, if one exists. */
  defaultProfile: string | null;
  providers: RegistryProvider[];
  profiles: RegistryProfile[];
};
export type ProviderRow = { provider: RegistryProvider; profiles: RegistryProfile[] };

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

function mapRegistry(catalog: ProviderCatalog, legacy: LegacyProfilesDocument): Registry {
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
  const legacyProfiles = legacy.profiles ?? {};
  const profiles = Object.entries(legacyProfiles).map(([id, profile]) => {
    const provider = byId.get(profile.provider);
    const model = provider?.models.find((entry) => entry.id === profile.model)?.definition;
    provider?.referencedBy.push(id);
    const isDefault = defaultSelection?.provider_id === profile.provider && defaultSelection.model_id === profile.model;
    return {
      id,
      name: profile.name !== "" ? profile.name : id,
      providerId: profile.provider,
      providerName: provider?.name ?? legacy.providers?.[profile.provider]?.name ?? profile.provider,
      model: profile.model,
      effort: profile.reasoning_effort ?? null,
      contextLength: model?.context_window ?? null,
      maxTokens: profile.max_tokens ?? model?.defaults.max_output_tokens ?? model?.max_output_tokens ?? null,
      isDefault,
      credential: provider?.credential ?? legacy.providers?.[profile.provider]?.credential ?? "api_key",
    };
  });
  const defaultProfile = profiles.find((profile) => profile.isDefault)?.id ?? null;
  if (defaultSelection != null) {
    const provider = byId.get(defaultSelection.provider_id);
    if (provider && !provider.referencedBy.includes("default_model_selection")) provider.referencedBy.push("default_model_selection");
  }
  return { revision: catalog.revision, defaultSelection, defaultProfile, providers, profiles };
}

export function providerRows(value: Registry): ProviderRow[] {
  return value.providers.map((provider) => ({
    provider,
    profiles: value.profiles.filter((profile) => profile.providerId === provider.id),
  }));
}

async function readRegistry(): Promise<Registry> {
  const [ack, legacySnapshot] = await Promise.all([
    transport.command({ type: "provider.list" }),
    transport.query("profile.list", {}),
  ]);
  if (ack.status !== "accepted") throw new Error(ack.message ?? ack.code ?? "provider.list was rejected");
  // backend-v3(B08/D3):profile.list 返回 ProfileListSnapshot 摘要(camelCase,
  // 无 provider 引用、无 default 指针);provider 归属按 baseUrl 对回新目录,
  // default 指针在 config 的 activeProfile,不在此文件。
  const catalog = readProviderCatalog(ack.result);
  const summaries = legacySnapshot?.profiles ?? {};
  const legacy: LegacyProfilesDocument = {
    profiles: Object.fromEntries(
      Object.entries(summaries).map(([id, summary]) => {
        const providerId =
          Object.entries(catalog.providers).find(([, provider]) => provider.base_url === summary.baseUrl)?.[0] ?? "";
        return [
          id,
          {
            name: summary.name,
            provider: providerId,
            model: summary.model,
            reasoning_effort: summary.effort ?? null,
            max_tokens: summary.maxTokens ?? null,
          },
        ];
      }),
    ),
  };
  const next = mapRegistry(catalog, legacy);
  setRegistry(next);
  return next;
}

export async function refreshRegistry(): Promise<void> {
  setLoading(true);
  setError(null);
  try { await readRegistry(); }
  catch (cause) { setError(messageOf(cause)); }
  finally { setLoading(false); }
}

async function perform<T>(action: () => Promise<T>): Promise<T | null> {
  setBusy(true);
  setError(null);
  try {
    const value = await action();
    await readRegistry();
    notifyConfigChanged();
    return value;
  } catch (cause) {
    setError(messageOf(cause));
    return null;
  } finally { setBusy(false); }
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
export type ProfileInput = {
  name: string;
  provider: string;
  model: string;
  effort: string | null;
  maxTokens: number | null;
};

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
  if (current?.profiles.some((profile) => profile.providerId === providerId && profile.model === modelId)) {
    setError("不能删除被存档引用的模型；请先删除或更换存档");
    return false;
  }
  const result = await perform(async () => {
    await configCommand({ type: "provider.model.delete", provider_id: providerId, model_id: modelId });
    return true;
  });
  return result === true;
}

function selectionFor(providerId: string, modelId: string, effort: string | null, maxTokens: number | null): ModelSelection {
  return {
    provider_id: providerId,
    model_id: modelId,
    options: {
      ...(effort == null ? {} : { reasoning_effort: effort }),
      ...(maxTokens == null ? {} : { max_output_tokens: maxTokens }),
    },
  };
}

async function setDefaultSelection(selection: ModelSelection): Promise<void> {
  await configCommand({ type: "model.selection.set_default", selection });
}

export async function saveProfile(input: ProfileInput, options: { makeDefault?: boolean } = {}): Promise<string | null> {
  const value = registry();
  const id = newId(input.name, (value?.profiles ?? []).map((profile) => profile.id));
  const result = await perform(async () => {
    if (!registry()?.providers.some((provider) => provider.id === input.provider)) throw new Error("所选 Provider 不存在");
    const provider = registry()!.providers.find((item) => item.id === input.provider)!;
    const model = provider.models.find((item) => item.id === input.model);
    if (model == null || !model.definition.enabled) throw new Error("请先在服务商目录中添加并启用此模型");
    await transport.command({
      type: "profile.create",
      id,
      name: input.name.trim() || id,
      provider: input.provider,
      model: input.model.trim(),
      reasoning_effort: input.effort,
      max_tokens: input.maxTokens,
    });
    if (options.makeDefault === true) {
      await setDefaultSelection(selectionFor(input.provider, input.model, input.effort, input.maxTokens));
    }
    return id;
  });
  return result;
}

export async function setDefaultProfile(id: string): Promise<boolean> {
  const current = registry();
  const profile = current?.profiles.find((item) => item.id === id);
  if (profile == null) { setError(`profile not found: ${id}`); return false; }
  const model = current?.providers.find((item) => item.id === profile.providerId)?.models.find((item) => item.id === profile.model);
  if (model == null || !model.definition.enabled) {
    setError(`存档「${profile.name}」引用的模型不在服务商目录中或已停用`);
    return false;
  }
  const result = await perform(async () => {
    await setDefaultSelection(selectionFor(profile.providerId, profile.model, profile.effort, profile.maxTokens));
    return true;
  });
  return result === true;
}

export async function deleteProfile(id: string): Promise<boolean> {
  const result = await perform(async () => {
    await transport.command({ type: "profile.delete", name: id });
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
export function newId(name: string, existing: readonly string[], fallbackPrefix = "profile"): string {
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

export async function ensureAccountProfile(input: {
  kind: AccountKind;
  baseUrl: string;
  model: string;
  contextLength: number;
  makeDefault?: boolean;
}): Promise<{ providerId: string; modelId: string } | null> {
  const identity = ACCOUNT_IDENTITY[input.kind];
  await refreshRegistry();
  const current = registry();
  if (current == null) return null;
  const existing = current.providers.find((provider) => provider.credential === identity.credential);
  const providerId = existing?.id ?? identity.providerId;
  if (!await saveProvider(providerId, {
    name: existing?.name ?? identity.providerName,
    baseUrl: input.baseUrl,
    wire: "responses",
    credential: identity.credential,
  })) return null;

  const latest = registry();
  const provider = latest?.providers.find((item) => item.id === providerId);
  const existingModel = provider?.models.find((item) => item.id === input.model)?.definition;
  const model: ModelDef = existingModel ?? {
    enabled: true,
    display_name: input.model,
    context_window: input.contextLength,
    max_output_tokens: 8_192,
    reasoning_levels: [],
    // Account catalog metadata does not establish these generic transport
    // capabilities. Keep them off until the user or an authoritative catalog
    // entry enables them in Provider settings.
    capabilities: { tool_calls: false, image_input: false, native_web_search: false, reasoning: false },
    defaults: { max_output_tokens: 8_192, native_web_search: false },
  };
  if (existingModel == null && !await saveModel(providerId, input.model, model)) return null;
  if (input.makeDefault === true || latest?.defaultSelection == null) {
    const selected = await perform(async () => {
      await setDefaultSelection({ provider_id: providerId, model_id: input.model, options: {} });
      return true;
    });
    if (selected !== true) return null;
  }
  return { providerId, modelId: input.model };
}
