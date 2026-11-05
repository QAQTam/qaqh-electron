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
import type { ProviderKind } from "./mode";

/** 与 `SiwcModelEntry` / `DsModelEntry` 同形：两家共用一套选择器渲染。 */
export type ModelEntry = SiwcModelEntry;

/** 有账户级目录的那两类（BYOK 不在内）。 */
export type CatalogKind = "plan" | "account";

/** 这一类 provider 的目录来源；BYOK 返回 `null` = 没有账户级目录可拉。 */
export function catalogKindOf(kind: ProviderKind): CatalogKind | null {
  return kind === "plan" || kind === "account" ? kind : null;
}

/** 取数依赖注入（脱壳可测；默认那份才碰 Electron 壳）。 */
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
 * 目录返回的展示名，没有展示名时使用用户填写的模型 ID。
 */
export function modelOptions(
  catalog: readonly ModelEntry[],
  extras: readonly (string | null | undefined)[] = [],
): ModelEntry[] {
  const bySlug = new Map<string, ModelEntry>();
  const push = (entry: ModelEntry): void => {
    const key = entry.slug.trim();
    if (key == null || key === "" || bySlug.has(key)) return;
    bySlug.set(key, entry);
  };
  for (const entry of catalog) push(entry);
  for (const extra of extras) {
    const slug = extra?.trim();
    if (slug != null && slug !== "") push({ slug, displayName: "" });
  }

  const out: ModelEntry[] = [];
  for (const [slug, fromCatalog] of bySlug) {
    out.push({
      ...fromCatalog,
      slug,
      displayName: fromCatalog.displayName.trim() || slug,
    });
  }
  return out;
}
