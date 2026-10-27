/**
 * 模型目录 —— **按 provider 归口**的取数与选择器条目合成。
 *
 * 为什么单独一层：目录的来源跟着凭据走 —— 套餐读 ChatGPT 目录（`siwc.models`），
 * DeepSeek 账号读推理 origin 自己的 `/models`（`dsaccount.models`），BYOK 压根没有
 * 账户级目录（模型名由用户在设置页自己填）。接入页与输入区的选择器都要吃这同一条
 * 判定；两边各写一套 `switch (credential)`，迟早出现"一家接了新 provider、另一家
 * 还在显示空列表"这种漂移（本项目就栽过一次）。
 *
 * 两条纪律：
 * - **不猜 slug**：目录取不到就给空，让调用方显示可操作的提示（登录 / 刷新 / 手填），
 *   而不是编一个模型名写进用户配置。
 * - **当前那个模型必须看得见**：目录与"配置里生效的值"不一致时（切过账户、上游
 *   改名），选择器要把它一起列出来，否则用户面对一个没有任何选中项的列表。
 */
import { dsaccountModels } from "../lib/dsaccount";
import { siwcModels, type SiwcModelEntry } from "../lib/siwc";
import { modelSpec, type SpecBucket } from "../models/specs";
import type { ProviderKind } from "./providers";

/** 与 `SiwcModelEntry` / `DsModelEntry` 同形：两家共用一套选择器渲染。 */
export type ModelEntry = SiwcModelEntry;

/** 有账户级目录的那两类（BYOK 不在内）。 */
export type CatalogKind = "plan" | "account";

/** provider 类别 → 模型特判桶（展示名与档位都按桶查，两家的 slug 互不串门）。 */
export function specBucketOfKind(kind: ProviderKind): SpecBucket {
  if (kind === "plan") return "plan";
  if (kind === "account") return "account";
  return "byok";
}

/** 这一类 provider 的目录来源；BYOK 返回 `null` = 没有账户级目录可拉。 */
export function catalogKindOf(kind: ProviderKind): CatalogKind | null {
  return kind === "plan" || kind === "account" ? kind : null;
}

/** 取数依赖注入（脱壳可测；默认那份才碰 Tauri）。 */
export type CatalogDeps = {
  plan: () => Promise<ModelEntry[]>;
  account: () => Promise<ModelEntry[]>;
};

export const defaultCatalogDeps: CatalogDeps = {
  plan: () => siwcModels(),
  account: () => dsaccountModels(),
};

/** 按来源取一次目录。原样透传后端条目（键名映射已在 `lib/*` 那层收口）。 */
export function fetchModelCatalog(
  kind: CatalogKind,
  deps: CatalogDeps = defaultCatalogDeps,
): Promise<ModelEntry[]> {
  return deps[kind]();
}

/**
 * 目录 + 额外要列出的 slug → 选择器条目。
 *
 * `extras` 是"目录里没有但用户看得见的事实"：当前生效的模型名、该 provider 槽位
 * 记住的模型名。它们排在目录之后（目录是权威列表），空白与重复都去掉；展示名先取
 * 特判合集（`../models/specs`），再取目录自己给的名字，都没有就用 slug。
 */
export function modelOptions(
  kind: ProviderKind,
  catalog: readonly ModelEntry[],
  extras: readonly (string | null | undefined)[] = [],
): ModelEntry[] {
  const bucket = specBucketOfKind(kind);
  const bySlug = new Map<string, string>();
  const push = (slug: string | null | undefined, displayName?: string | null): void => {
    const key = slug?.trim();
    if (key == null || key === "" || bySlug.has(key)) return;
    bySlug.set(key, displayName?.trim() ?? "");
  };
  for (const entry of catalog) push(entry.slug, entry.displayName);
  for (const extra of extras) push(extra);

  const out: ModelEntry[] = [];
  for (const [slug, fromCatalog] of bySlug) {
    const { spec } = modelSpec(bucket, slug);
    out.push({ slug, displayName: spec.displayName ?? (fromCatalog === "" ? slug : fromCatalog) });
  }
  return out;
}

/**
 * 切到某一家时该写哪个模型名。优先级：
 * 1. 该 provider 槽位记住的那条（用户上次在这一家亲手选的）；
 * 2. 当前配置里的模型 **且它在这一家的目录里**（ round-trip 切回时不必换掉他正用的）；
 * 3. 目录首条（第一次从 BYOK 切过来：全局 `model` 还是用户自己的端点上的 slug，
 *    留在这儿就等于"切过去了但没有可用模型"）；
 * 4. `null` = 一个都不知道，那就**不发** `model` 字段，让界面提示用户确认。
 */
export function preferredModel(options: {
  remembered?: string | null;
  current?: string | null;
  catalog: readonly ModelEntry[];
}): string | null {
  const remembered = options.remembered?.trim();
  if (remembered != null && remembered !== "") return remembered;
  const current = options.current?.trim();
  if (current != null && current !== "") {
    if (options.catalog.some((entry) => entry.slug.trim() === current)) return current;
  }
  return options.catalog[0]?.slug ?? null;
}
