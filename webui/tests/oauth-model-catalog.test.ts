/**
 * 模型目录层（`src/oauth/model-catalog.ts`）的单测。
 *
 * 这一层存在的全部理由：接入页与输入区的"没有模型可切换"是同一个病 ——
 * 目录来源跟着凭据走，两家各有各的 wire 与目录。判定写在两处就会漂，
 * 所以漂一次就在这里钉住一次。
 */
import { describe, expect, it } from "vitest";

import {
  catalogKindOf,
  fetchModelCatalog,
  modelOptions,
  preferredModel,
  specBucketOfKind,
  type CatalogDeps,
  type ModelEntry,
} from "../src/oauth/model-catalog";

const PLAN: ModelEntry[] = [
  { slug: "gpt-6-luna", displayName: "ChatGPT 给的展示名" },
  { slug: "brand-new-model", displayName: "  " },
];
const ACCOUNT: ModelEntry[] = [
  { slug: "deepseek-flash", displayName: "平台给的展示名" },
  { slug: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
];

function spyDeps(record: string[]): CatalogDeps {
  return {
    plan: () => {
      record.push("plan");
      return Promise.resolve(PLAN);
    },
    account: () => {
      record.push("account");
      return Promise.resolve(ACCOUNT);
    },
  };
}

describe("目录来源跟着 provider 走", () => {
  it("BYOK 没有账户级目录：来源为 null（拉了也是错的表）", () => {
    expect(catalogKindOf("byok")).toBeNull();
    expect(catalogKindOf("plan")).toBe("plan");
    expect(catalogKindOf("account")).toBe("account");
  });

  it("桶按 provider 分：两家的 slug 互不串门", () => {
    expect(specBucketOfKind("plan")).toBe("plan");
    expect(specBucketOfKind("account")).toBe("account");
    expect(specBucketOfKind("byok")).toBe("byok");
  });

  it("取数只碰这一家自己的来源，不顺手调另一家", async () => {
    const calls: string[] = [];
    await expect(fetchModelCatalog("account", spyDeps(calls))).resolves.toEqual(ACCOUNT);
    await expect(fetchModelCatalog("plan", spyDeps(calls))).resolves.toEqual(PLAN);
    expect(calls).toEqual(["account", "plan"]);
  });
});

describe("选择器条目合成", () => {
  it("展示名先取特判合集（那是我们验证过的那份），再取目录给的", () => {
    const [flash] = modelOptions("account", ACCOUNT, []);
    expect(flash).toEqual({ slug: "deepseek-flash", displayName: "DeepSeek-V4.1-Flash" });
  });

  it("未收录的模型不报错：目录给了名字就用它，空白名字退回 slug", () => {
    const options = modelOptions("plan", PLAN, []);
    expect(options.find((entry) => entry.slug === "gpt-6-luna")?.displayName).toBe("GPT-6-Luna");
    expect(options.find((entry) => entry.slug === "brand-new-model")?.displayName).toBe(
      "brand-new-model",
    );
  });

  it("配置里 / 槽位里那条不在目录里的模型也要列出来，且排在目录之后", () => {
    const options = modelOptions("account", ACCOUNT, ["leftover-from-byok", "deepseek-flash"]);
    expect(options.map((entry) => entry.slug)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "leftover-from-byok",
    ]);
    // 空白 / null / undefined 不进列表：它们不是模型名。
    expect(modelOptions("account", ACCOUNT, ["  ", null, undefined, ""])).toHaveLength(2);
  });

  it("BYOK 桶是空的（有意），条目全走目录名而不是硬套套餐的展示名", () => {
    const options = modelOptions("byok", PLAN, []);
    expect(options[0]).toEqual({ slug: "gpt-6-luna", displayName: "ChatGPT 给的展示名" });
  });
});

describe("切到某一家时写哪个模型名", () => {
  it("槽位记住的那条优先：那是用户在这一家亲手选的", () => {
    expect(preferredModel({ remembered: "gpt-6-sol", current: "gpt-6-luna", catalog: PLAN })).toBe(
      "gpt-6-sol",
    );
    // 空白串不算"记住过"（合并补丁里空串 = 保持现值，留着它等于没填）。
    expect(preferredModel({ remembered: "   ", catalog: PLAN })).toBe("gpt-6-luna");
  });

  it("没记住时，当前模型只要**在这家的目录里**就保留（来回切不必换掉他正用的）", () => {
    expect(preferredModel({ current: "gpt-6-luna", catalog: PLAN })).toBe("gpt-6-luna");
  });

  it("当前模型不在这家的目录里 → 落到目录首条，而不是把上一家的 slug 留下", () => {
    expect(preferredModel({ current: "deepseek-v4.1-flash", catalog: PLAN })).toBe("gpt-6-luna");
  });

  it("目录为空 → null：宁可不写 model 让界面提示，也不编一个模型名进用户配置", () => {
    expect(preferredModel({ current: "whatever", catalog: [] })).toBeNull();
    expect(preferredModel({ catalog: [] })).toBeNull();
  });
});
