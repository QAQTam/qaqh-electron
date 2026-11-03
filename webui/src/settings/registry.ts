/**
 * `profiles.toml` 的**前端读模型与唯一写口** —— 服务商、存档、默认指针。
 *
 * 事实来源只有一处：daemon 的 `profile.list` 返回整份 `ProfilesDocument`
 * （snake_case）。一次读取同时拿到 providers + profiles + default_profile，
 * 避免拆成两次查询时读到撕裂快照。设置页的「服务商 / 存档」与首次引导都吃这一份。
 *
 * 写口纪律（与后端 `system.rs` 的 `ProviderDraft` / `ProfileDraft` 对齐）：
 * - `provider.upsert` 是**逐字段 merge**：省略的字段保持原值；
 * - `profile.create/update` 的 `profile` 是**整段替换**：可选字段必须显式带上，
 *   省略会在后端变成 `None`（= 清空）；
 * - `apiKey` 省略 / `"****"` = 保持，`""` = 清除，其他值 = 存新密钥；**永不发 `"set"`**；
 * - 默认存档不可删、被引用的服务商不可删 —— 前端只把按钮禁用，权威仍是后端。
 *
 * 这与应用设置的「草稿 + config.patch」完全分开：这里的每个写口立即落盘并广播，
 * 不参与设置页底部的保存流程，因此编辑存档不会丢掉应用设置草稿。
 */
import { createSignal } from "solid-js";

import type { DaemonCommand } from "../lib/transport/backend";
import { notifyConfigChanged } from "../lib/config-events";
import { transport } from "../lib/transport";

/** `ProfilesDocument` 的线形状（`qaqh_profile::ProfilesDocument`，snake_case）。 */
export type ProviderWire = {
  name: string;
  base_url: string;
  wire: string;
  credential: string;
  api_key?: string | null;
  headers?: Record<string, string>;
  compat?: unknown;
  models?: Record<string, unknown>;
};

export type ProfileWire = {
  name: string;
  provider: string;
  model: string;
  reasoning_effort?: string | null;
  context_length?: number | null;
  max_tokens?: number | null;
};

export type ProfilesDocumentWire = {
  revision: number;
  default_profile?: string | null;
  providers: Record<string, ProviderWire>;
  profiles: Record<string, ProfileWire>;
};

export type RegistryProvider = {
  id: string;
  name: string;
  baseUrl: string;
  wire: string;
  credential: string;
  apiKeySet: boolean;
  /** 引用它的存档 id（删除按钮的禁用依据）。 */
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
  /** 冗余自 provider，省得每个消费者再查一次。 */
  credential: string;
};

export type Registry = {
  revision: number;
  defaultProfile: string | null;
  providers: RegistryProvider[];
  profiles: RegistryProfile[];
};

/** 服务商页一行：服务商 + 引用它的存档。 */
export type ProviderRow = { provider: RegistryProvider; profiles: RegistryProfile[] };

const CREDENTIAL_LABELS: Record<string, string> = {
  api_key: "API key",
  chatgpt_plan: "ChatGPT 套餐",
  deepseek_account: "DeepSeek 账号",
};

export const credentialLabel = (credential: string): string =>
  CREDENTIAL_LABELS[credential] ?? credential;

const [registry, setRegistry] = createSignal<Registry | null>(null);
const [loading, setLoading] = createSignal(false);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export { registry, loading as registryLoading, busy as registryBusy, error as registryError };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function mapDocument(doc: ProfilesDocumentWire): Registry {
  const providers: RegistryProvider[] = Object.entries(doc.providers).map(([id, provider]) => ({
    id,
    name: provider.name,
    baseUrl: provider.base_url,
    wire: provider.wire,
    credential: provider.credential,
    apiKeySet: provider.api_key != null && provider.api_key !== "",
    referencedBy: [],
  }));
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultProfile = doc.default_profile ?? null;
  const profiles: RegistryProfile[] = Object.entries(doc.profiles).map(([id, profile]) => {
    const provider = byId.get(profile.provider);
    provider?.referencedBy.push(id);
    return {
      id,
      name: profile.name !== "" ? profile.name : id,
      providerId: profile.provider,
      providerName: provider?.name ?? profile.provider,
      model: profile.model,
      effort: profile.reasoning_effort ?? null,
      contextLength: profile.context_length ?? null,
      maxTokens: profile.max_tokens ?? null,
      isDefault: defaultProfile === id,
      credential: provider?.credential ?? "api_key",
    };
  });
  return { revision: doc.revision, defaultProfile, providers, profiles };
}

/** 服务商页要的聚合行；目录顺序沿用后端 BTreeMap（按 id 稳定）。 */
export function providerRows(value: Registry): ProviderRow[] {
  return value.providers.map((provider) => ({
    provider,
    profiles: value.profiles.filter((profile) => profile.providerId === provider.id),
  }));
}

async function readRegistry(): Promise<Registry> {
  const document = await transport.query<ProfilesDocumentWire>({ type: "profile.list" });
  const next = mapDocument(document);
  setRegistry(next);
  return next;
}

/** 读一次名录（页面挂载、引导检查、写后刷新）。 */
export async function refreshRegistry(): Promise<void> {
  setLoading(true);
  setError(null);
  try {
    await readRegistry();
  } catch (cause) {
    setError(messageOf(cause));
  } finally {
    setLoading(false);
  }
}

/**
 * 所有写命令的共同外壳：成功后重读名录并广播（模型/上下文镜像自己重读），
 * 失败把后端原文留在 `registryError`。返回值 `null` = 失败。
 */
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
  } finally {
    setBusy(false);
  }
}

const command = <T>(payload: DaemonCommand): Promise<T> =>
  transport.query<T>(payload);

/* ------------------------------------------------------------------ */
/* ID 规则：小写 [a-z0-9_-]、≤64；中文/空名回退到带时间戳的稳定前缀    */
/* ------------------------------------------------------------------ */

const MAX_ID = 64;

/** 展示名 → id 基名；全是非 ASCII 时返回空串，由调用方回退。 */
export function slugifyId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_ID);
}

/**
 * 在已有 id 集合里生成不冲突的 id。空 slug（中文名）回退 `profile-<36 进制时间>`；
 * 冲突时追加 `-2`、`-3`…，仍然守住 64 字符上限。
 */
export function newId(
  name: string,
  existing: readonly string[],
  fallbackPrefix = "profile",
): string {
  const taken = new Set(existing);
  const base =
    slugifyId(name) || `${fallbackPrefix}-${Date.now().toString(36)}`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/* ------------------------------------------------------------------ */
/* 写口                                                                */
/* ------------------------------------------------------------------ */

export type ProviderInput = {
  name: string;
  baseUrl: string;
  wire: string;
  credential: string;
  /** undefined = 保持；"" = 清除；其他 = 存新密钥。 */
  apiKey?: string;
};

export type ProfileInput = {
  /** 有值 = `profile.update`（整段替换）；无值 = `profile.create`。 */
  id?: string;
  name: string;
  provider: string;
  model: string;
  effort: string | null;
  contextLength: number | null;
  maxTokens: number | null;
};

export async function saveProvider(id: string, input: ProviderInput): Promise<boolean> {
  const result = await perform(async () => {
    await command({
      type: "provider.upsert",
      id,
      provider: {
        name: input.name.trim(),
        baseUrl: input.baseUrl.trim(),
        wire: input.wire,
        credential: input.credential,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      },
    });
    return true;
  });
  return result === true;
}

/** 建/改一条存档；返回落盘后的 id（失败 null）。 */
export async function saveProfile(
  input: ProfileInput,
  options: { makeDefault?: boolean } = {},
): Promise<string | null> {
  const value = registry();
  const id =
    input.id ??
    newId(input.name, (value?.profiles ?? []).map((profile) => profile.id));
  const result = await perform(async () => {
    await command({
      type: input.id == null ? "profile.create" : "profile.update",
      id,
      profile: {
        name: input.name.trim() === "" ? id : input.name.trim(),
        provider: input.provider,
        model: input.model.trim(),
        reasoningEffort: input.effort,
        contextLength: input.contextLength,
        maxTokens: input.maxTokens,
      },
    });
    if (options.makeDefault === true) {
      await command({ type: "profile.set_default", id });
    }
    return id;
  });
  return result;
}

export async function setDefaultProfile(id: string): Promise<boolean> {
  const result = await perform(async () => {
    await command({ type: "profile.set_default", id });
    return true;
  });
  return result === true;
}

export async function deleteProfile(id: string): Promise<boolean> {
  const result = await perform(async () => {
    await command({ type: "profile.delete", id });
    return true;
  });
  return result === true;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const result = await perform(async () => {
    await command({ type: "provider.delete", id });
    return true;
  });
  return result === true;
}

/* ------------------------------------------------------------------ */
/* 账号类服务商 / 存档的规范化创建（登录与首次引导共用）                */
/* ------------------------------------------------------------------ */

export type AccountKind = "plan" | "account";

const ACCOUNT_IDENTITY = {
  plan: {
    credential: "chatgpt_plan",
    providerId: "openai",
    profileId: "chatgpt-plan",
    providerName: "ChatGPT 套餐",
    profileName: "ChatGPT 套餐",
  },
  account: {
    credential: "deepseek_account",
    providerId: "deepseek-account",
    profileId: "deepseek-account",
    providerName: "DeepSeek 账号",
    profileName: "DeepSeek 账号",
  },
} as const;

/**
 * 登录成功后把「账号凭据」落成 Provider + 存档。
 *
 * - **复用已有账号 Provider**：历史配置里可能叫 `default-provider` 之类，按
 *   `credential` 找而不是盲目写稳定 id，否则同一账号会出现两个源；
 * - 存档同理：优先复用引用该 Provider 的第一条，后续登录只更新模型/窗口；
 * - `makeDefault` 由调用方决定（首次引导 / 用户点「启用」传 true；登录成功但
 *   已用着另一家账号时传 false，不抢默认）。
 */
export async function ensureAccountProfile(input: {
  kind: AccountKind;
  baseUrl: string;
  model: string;
  contextLength: number;
  makeDefault?: boolean;
}): Promise<{ providerId: string; profileId: string } | null> {
  const identity = ACCOUNT_IDENTITY[input.kind];
  await refreshRegistry();
  const current = registry();
  if (current == null) return null;

  const existingProvider = current.providers.find(
    (provider) => provider.credential === identity.credential,
  );
  const providerId = existingProvider?.id ?? identity.providerId;
  const providerSaved = await saveProvider(providerId, {
    name: existingProvider?.name ?? identity.providerName,
    baseUrl: input.baseUrl,
    wire: "responses",
    credential: identity.credential,
  });
  if (!providerSaved) return null;

  const afterProvider = registry();
  const existingProfile = afterProvider?.profiles.find(
    (profile) => profile.providerId === providerId,
  );
  const profileId = existingProfile?.id ?? identity.profileId;
  const savedId = await saveProfile({
    id: existingProfile?.id,
    name: existingProfile?.name ?? identity.profileName,
    provider: providerId,
    model: input.model,
    effort: existingProfile?.effort ?? null,
    contextLength: input.contextLength,
    maxTokens: existingProfile?.maxTokens ?? null,
  });
  if (savedId == null) return null;

  if (input.makeDefault === true || afterProvider?.defaultProfile == null) {
    const madeDefault = await setDefaultProfile(profileId);
    if (!madeDefault) return null;
  }
  return { providerId, profileId };
}
