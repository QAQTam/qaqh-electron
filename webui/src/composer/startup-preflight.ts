/**
 * 启动页预检态(阶段B):「下一条会话」的模型/强度/工具模式草稿。
 *
 * 启动页没有会话 seed,`session.settings.patch` 无处可发;这一份本地草稿就是它,
 * 发送首条消息时随 `session.create` 一次性带上:
 * - `modelSelection: null` = **不发** `model_selection`,后端回落 `default_model_selection`
 *   (`crates/qaqh-runtime/src/service/handlers/session.rs:173-176`,无默认才报错);
 * - `toolMode` 空串或 `standard` = 不写 `tool_mode` 列,与后端「空串 = 未指定」的
 *   零迁移语义一致(`service/params.rs:16-19`);
 * - `custom` 必须带非空白名单,否则后端 400(`params.rs:21-23`)——写口在这里就挡住。
 *
 * 叶子语义与会话卡完全同构(见 session/store `setSessionEffort/setSessionMaxTokens`
 * 的注释):清除是删叶子(跟随该模型默认),设叶子时若还没有可依附的整对,
 * 以**存档默认那一对**为底落上——这正是后端此刻会解析用的对,不是替用户编一个。
 * 换模型必须清掉 options 的档位叶子:跨模型沿用旧档位会被 resolver 400 拒
 * (`qaqh-profile/src/resolver.rs`,交接文档 §3),丢叶子是正确行为而非 bug。
 *
 * 本模块刻意纯函数化(只吃 Registry 快照),tabs/store 的信号与启动页的写口
 * 都薄得可以在 node 环境下直接测。
 */
import type { ModelSelection } from "../api/qaqh/ModelSelection";
import type { Registry } from "../settings/registry";

export interface StartupPreflight {
  /** null = 跟随存档默认(发送时省略 model_selection)。 */
  modelSelection: ModelSelection | null;
  /** "" = 未指定(后端默认 standard);否则是 KNOWN_MODES 里的档位名。 */
  toolMode: string;
  /** 仅 toolMode === "custom" 时有意义,且必非空。 */
  customTools: string[];
}

export const EMPTY_PREFLIGHT: StartupPreflight = {
  modelSelection: null,
  toolMode: "",
  customTools: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** localStorage 回读的唯一入口:坏数据一律塌回空,不做半句信任。 */
export function normalizePreflight(raw: unknown): StartupPreflight {
  if (!isRecord(raw)) return EMPTY_PREFLIGHT;
  const selection = raw.modelSelection;
  let modelSelection: ModelSelection | null = null;
  if (isRecord(selection)
    && typeof selection.provider_id === "string" && selection.provider_id !== ""
    && typeof selection.model_id === "string" && selection.model_id !== "") {
    const options = isRecord(selection.options) ? selection.options : {};
    // 叶子按**类型**收,收不下就整键省略(而不是落成 null):写回再读回的往返
    // 必须与原值 `toEqual` 相等,null 键会多出一个"看见却没意义"的覆写。
    const kept: ModelSelection["options"] = {};
    if (typeof options.reasoning_effort === "string") kept.reasoning_effort = options.reasoning_effort;
    if (typeof options.max_output_tokens === "number") kept.max_output_tokens = options.max_output_tokens;
    modelSelection = {
      provider_id: selection.provider_id,
      model_id: selection.model_id,
      options: kept,
    };
  }
  const toolMode = typeof raw.toolMode === "string" ? raw.toolMode : "";
  const customTools = Array.isArray(raw.customTools)
    ? raw.customTools.filter((item): item is string => typeof item === "string")
    : [];
  const next: StartupPreflight = {
    modelSelection,
    toolMode,
    // 非 custom 档不带白名单落存:半途状态不给复活的机会。
    customTools: toolMode === "custom" && customTools.length > 0 ? customTools : [],
  };
  // 全空形状塌回唯一权威引用——「跟随存档」在类型上就该只有一个值。
  return next.modelSelection == null && next.toolMode === "" && next.customTools.length === 0
    ? EMPTY_PREFLIGHT
    : next;
}

export function readPreflight(store: Pick<Storage, "getItem">): StartupPreflight {
  try {
    const text = store.getItem(PREFLIGHT_STORAGE_KEY);
    if (text == null) return EMPTY_PREFLIGHT;
    return normalizePreflight(JSON.parse(text));
  } catch {
    return EMPTY_PREFLIGHT;
  }
}

export const PREFLIGHT_STORAGE_KEY = "qaqh.startup.preflight";

export function writePreflight(store: Pick<Storage, "setItem" | "removeItem">, value: StartupPreflight): void {
  try {
    if (value.modelSelection == null && value.toolMode === "" && value.customTools.length === 0) {
      store.removeItem(PREFLIGHT_STORAGE_KEY);
      return;
    }
    store.setItem(PREFLIGHT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 隐私模式:内存态照常工作,只是刷新后回到「跟随存档」。
  }
}

/** 整对换模型:沿用当前 provider,退回存档默认 provider,再退回首个登记了它的启用 provider。 */
function resolveProviderForModel(registry: Registry | null, model: string, current: ModelSelection | null): string | null {
  if (registry == null) return null;
  const holds = (providerId: string | null | undefined): boolean =>
    providerId != null && registry.providers.some((provider) =>
      provider.id === providerId
      && provider.models.some((entry) => entry.id === model && entry.definition.enabled));
  if (holds(current?.provider_id)) return current!.provider_id;
  if (holds(registry.defaultSelection?.provider_id)) return registry.defaultSelection!.provider_id;
  const holder = registry.providers.find((provider) =>
    provider.models.some((entry) => entry.id === model && entry.definition.enabled));
  return holder?.id ?? null;
}

/**
 * 模型行写口。`null` = 清除预检(回到「跟随存档默认」);字符串 = 落整对并**清掉
 * options 的叶子**(换模型沿用旧档位会被 resolver 400 拒,见文件头)。
 */
export function writePreflightModel(
  current: StartupPreflight, registry: Registry | null, model: string | null,
): StartupPreflight {
  if (model == null) return { ...current, modelSelection: null };
  const providerId = resolveProviderForModel(registry, model, current.modelSelection);
  if (providerId == null) {
    throw new Error(`模型「${model}」不在任何已启用的服务商登记里:先到「设置 → 服务商」登记并启用它`);
  }
  return { ...current, modelSelection: { provider_id: providerId, model_id: model, options: {} } };
}

/** 依附或新建整对时用的默认底:后端此刻真正会用的那一对。 */
function attachableBase(registry: Registry | null): ModelSelection | null {
  return registry?.defaultSelection ?? null;
}

function withEffortLeaf(selection: ModelSelection, effort: string | null): ModelSelection {
  const options = { ...selection.options };
  if (effort == null) delete options.reasoning_effort;
  else options.reasoning_effort = effort;
  return { ...selection, options };
}

function withMaxTokensLeaf(selection: ModelSelection, maxTokens: number | null): ModelSelection {
  const options = { ...selection.options };
  if (maxTokens == null) delete options.max_output_tokens;
  else options.max_output_tokens = maxTokens;
  return { ...selection, options };
}

/**
 * 强度写口。与会话卡同规:清除(null)在没有叶子可清时是**无操作**,不是报错;
 * 设定值却没有可依附的整对时,以存档默认那一对为底落上(副作用:此后本会话预检
 * 钉在当时的默认对上,不再跟随存档——与会话页 §4.5 的补偿同一句话)。
 */
export function writePreflightEffort(
  current: StartupPreflight, registry: Registry | null, effort: string | null,
): StartupPreflight {
  const selection = current.modelSelection;
  if (selection == null) {
    if (effort == null) return current;
    const base = attachableBase(registry);
    if (base == null) throw new Error("还没有可依附的服务商:先在「模型」行选一个,或到设置页设默认模型");
    return { ...current, modelSelection: withEffortLeaf(base, effort) };
  }
  return { ...current, modelSelection: withEffortLeaf(selection, effort) };
}

export function writePreflightMaxTokens(
  current: StartupPreflight, registry: Registry | null, maxTokens: number | null,
): StartupPreflight {
  const selection = current.modelSelection;
  if (selection == null) {
    if (maxTokens == null) return current;
    const base = attachableBase(registry);
    if (base == null) throw new Error("还没有可依附的服务商:先在「模型」行选一个,或到设置页设默认模型");
    return { ...current, modelSelection: withMaxTokensLeaf(base, maxTokens) };
  }
  return { ...current, modelSelection: withMaxTokensLeaf(selection, maxTokens) };
}

/** 工具模式写口:custom 的空白名单在这里挡下(后端会 400),其余档清掉 customTools。 */
export function writePreflightToolMode(
  current: StartupPreflight, mode: string, customTools: string[],
): StartupPreflight {
  if (mode === "custom") {
    if (customTools.length === 0) return current;
    return { ...current, toolMode: "custom", customTools };
  }
  return { ...current, toolMode: mode, customTools: [] };
}

/** 随首条消息的 `session.create` 发出去的参数;null = 省略,后端回落默认。 */
export interface PreflightCreateArgs {
  modelSelection: ModelSelection | null;
  toolMode: string | null;
  customTools: string[] | null;
}

export function preflightCreateArgs(preflight: StartupPreflight): PreflightCreateArgs {
  const sendsToolMode = preflight.toolMode !== "" && preflight.toolMode !== "standard";
  return {
    modelSelection: preflight.modelSelection,
    toolMode: sendsToolMode ? preflight.toolMode : null,
    customTools: sendsToolMode && preflight.toolMode === "custom" ? preflight.customTools : null,
  };
}
