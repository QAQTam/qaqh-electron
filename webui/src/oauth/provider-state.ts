/**
 * 每 provider 的状态（**前端代管**）+ 切换时该写进 daemon 的字段。
 *
 * 存在的理由就是你点出的那个问题：**单一的全局 `model` 装不下两份状态**。
 * 关掉套餐时如果把套餐的 slug 留在全局配置里，用户自己的端点就废了；反过来
 * 开套餐时又会被 BYOK 的模型名带偏。所以：**切走之前先把当前这套抓下来**存进
 * 该 provider 的槽位，切回来再写回去（`captureProviderState` + `switchFields`）。
 *
 * 为什么状态放前端而不是后端：后端短期内没有 per-provider 结构（见
 * `../models/specs.ts` 顶部）。等友商的 key 也要代管时，再谈要不要挪进 daemon
 * 的加密存储——那时动的只是这一层。
 *
 * 状态里**永远不含凭据**：这里存的是模型名/端点/协议/档位，密钥在 daemon。
 */
import type { ConfigDto } from "../api/qaqh/ConfigDto";
import { wireForDaemon } from "../settings/patch";
import { DSACCOUNT_CONTEXT_LENGTH, OAUTH_CONTEXT_LENGTH } from "./mode";
import {
  BYOK_PROVIDER_ID,
  DSACCOUNT_PROVIDER_ID,
  PLAN_PROVIDER_ID,
  type ProviderEntry,
} from "./providers";

/** 一家 provider 记住的东西。全可选：没抓过的字段就不写回。 */
export type ProviderState = {
  model?: string;
  effort?: string;
  baseUrl?: string;
  wire?: string;
  contextLength?: number;
};

export type ProviderStateMap = Record<string, ProviderState>;

/** 本机存储键（与 Codex 的 `chatgpt-work-model-settings-v1` 同思路）。 */
export const PROVIDER_STATE_KEY = "qaqh.provider-state.v1";

/** 能从 daemon 读模型里抓到的那部分。 */
export type CapturableConfig = Pick<
  ConfigDto,
  "model" | "baseUrl" | "wire" | "contextLength" | "reasoningEffort"
>;

/** 抓一份"当前这套"。**切走之前必须调**——不抓就还原不回来。 */
export function captureProviderState(config: CapturableConfig): ProviderState {
  return {
    model: config.model,
    effort: config.reasoningEffort,
    baseUrl: config.baseUrl,
    wire: config.wire,
    contextLength: config.contextLength,
  };
}

/**
 * 当前生效的是哪一家：读**配置里的 credential**，不是前端的"我想用哪家"。
 * 两者可能不一致（别的端改过配置），以配置为准。
 */
export function activeProviderId(config: Pick<ConfigDto, "credential">): string {
  if (config.credential === "chatgpt_plan") return PLAN_PROVIDER_ID;
  if (config.credential === "deepseek_account") return DSACCOUNT_PROVIDER_ID;
  return BYOK_PROVIDER_ID;
}

/** 记下某一家这份状态（浅合并：没给的字段保留旧的）。 */
export function rememberState(
  map: ProviderStateMap,
  providerId: string,
  state: ProviderState,
): ProviderStateMap {
  return { ...map, [providerId]: { ...map[providerId], ...state } };
}

const given = (value: string | undefined): boolean =>
  value != null && value.trim() !== "";

/**
 * 切到某一家时写进 daemon 的字段（K3 合并补丁：只发这几个键）。
 *
 * 字段值必须是 daemon **写模型**能收的拼写：`wire` 尤其——读模型回显规范名
 * （`chat`/`messages`），但 `ConfigPatch::validate` 目前只收旧拼写；桥在
 * `../settings/patch::wireForDaemon`（直发规范名 = 400 action_failed）。
 *
 * `apiBase` 未知（daemon 没连通，拿不到官方端点）时**不动 endpoint**：让后端的
 * 保存期校验给出可读错误，而不是猜一个 URL 填进用户配置。
 *
 * **已知缺口**：合并补丁的语义是"空串 = 保持现值"，所以没有"清空某字段"的表达。
 * 于是**第一次**切到某一家时，若该槽位还没抓过模型名，全局 `model` 会留着上一家
 * 的 slug。切**到**账号额度那两家时，接入页（`./OAuthPage`）从这一家自己的目录里
 * 取一条填上（见 `./model-catalog::preferredModel`）；切回 BYOK 没有目录可取，
 * 只能提示用户确认模型名 —— 假装已经切干净了更糟。
 */
export function switchFields(
  provider: ProviderEntry,
  states: ProviderStateMap,
  apiBase: string | null,
): Record<string, unknown> {
  const saved = states[provider.id] ?? {};
  if (provider.kind === "plan") {
    return {
      credential: "chatgpt_plan",
      // 套餐直连只提供 Responses API；这里先归位，免得到保存期才被后端拒绝。
      wire: "responses",
      contextLength: saved.contextLength ?? OAUTH_CONTEXT_LENGTH,
      ...(apiBase == null ? {} : { baseUrl: apiBase }),
      ...(given(saved.model) ? { model: saved.model } : {}),
    };
  }
  if (provider.kind === "account") {
    return {
      credential: "deepseek_account",
      // DeepSeek 账号余额走 OpenAI 兼容的 chat completions；官方 base 由后端的
      // `apply_deepseek_account` 钉死，这里只在**已知**时写（`apiBase` 取自
      // `dsaccount.status.inferenceOrigin`，前端不拼 URL）。
      // 写 daemon 校验认的旧拼写 `openai`（= 规范名 `chat`；写模型不收规范名）。
      wire: "openai",
      // 分母跟着这一家走（实测 1M）：不写就沿用上一家的值，压缩时机就错了。
      contextLength: saved.contextLength ?? DSACCOUNT_CONTEXT_LENGTH,
      ...(apiBase == null ? {} : { baseUrl: apiBase }),
      ...(given(saved.model) ? { model: saved.model } : {}),
    };
  }
  // 切回自带 key：把当初抓下来的模型/端点/协议写回去。
  // 这一条就是"关掉 OAuth 不丢配置" —— 没有它，套餐的 slug 会留在你的端点上。
  // 协议先过 `wireForDaemon`：快照里可能是规范名（读模型回显）或更早版本存下的
  // 旧拼写，出网必须是 daemon 认的那个；认不出的值不发（让保存期校验报错，而不是
  // 制造一个必然 400 的请求）。
  const wire = wireForDaemon(saved.wire);
  return {
    credential: "api_key",
    ...(given(saved.model) ? { model: saved.model } : {}),
    ...(given(saved.baseUrl) ? { baseUrl: saved.baseUrl } : {}),
    ...(wire == null ? {} : { wire }),
  };
}

/** 只用到这两个方法，方便测试注入假存储。 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** 取本机存储；浏览器预览/测试里可能没有（隐私模式会抛），取不到返回 null。 */
export function safeStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读状态。**任何异常都退回空表**：一份坏掉的 blob 不该让页面打不开。 */
export function loadState(storage: StorageLike | null = safeStorage()): ProviderStateMap {
  if (storage == null) return {};
  try {
    const raw = storage.getItem(PROVIDER_STATE_KEY);
    if (raw == null || raw.trim() === "") return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ProviderStateMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const state: ProviderState = {};
      if (typeof entry.model === "string") state.model = entry.model;
      if (typeof entry.effort === "string") state.effort = entry.effort;
      if (typeof entry.baseUrl === "string") state.baseUrl = entry.baseUrl;
      if (typeof entry.wire === "string") state.wire = entry.wire;
      if (typeof entry.contextLength === "number") state.contextLength = entry.contextLength;
      out[id] = state;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写状态；写不进去（配额/隐私模式）就算了——它只是"下次少填一次"的便利。 */
export function saveState(map: ProviderStateMap, storage: StorageLike | null = safeStorage()): void {
  if (storage == null) return;
  try {
    storage.setItem(PROVIDER_STATE_KEY, JSON.stringify(map));
  } catch {
    // 忽略：状态丢了不影响功能，只是下次要重选。
  }
}

/** 名录里 byok 那一家的 id（`switchFields` 的调用方常要它）。 */
export const BYOK_ID = BYOK_PROVIDER_ID;
/** 名录里套餐那一家的 id。 */
export const PLAN_ID = PLAN_PROVIDER_ID;

/**
 * 「上次在用的是哪一家**账号额度**」——胶囊开关拨回"开"时的落点。
 *
 * 单独一个键，不进 `PROVIDER_STATE_KEY` 那份表：那份是"每家的字段快照"，
 * 混进一个字符串就把 `loadState` 的形状约定破坏了（它只认嵌套对象）。
 * 存的是 provider id，不是凭据 —— 与那份表同样的边界。
 */
export const LAST_ACCOUNT_KEY = "qaqh.oauth.lastAccountProvider";

export function loadLastAccountProvider(
  storage: StorageLike | null = safeStorage(),
): string | null {
  if (storage == null) return null;
  try {
    const raw = storage.getItem(LAST_ACCOUNT_KEY);
    return raw == null || raw.trim() === "" ? null : raw.trim();
  } catch {
    return null;
  }
}

/** 写不落也就罢了：丢了只影响"下次拨开关落到哪家"，不影响推理本身。 */
export function saveLastAccountProvider(
  providerId: string,
  storage: StorageLike | null = safeStorage(),
): void {
  if (storage == null) return;
  try {
    storage.setItem(LAST_ACCOUNT_KEY, providerId);
  } catch {
    // 忽略。
  }
}
