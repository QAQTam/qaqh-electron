import { describe, expect, it } from "vitest";

import {
  EFFORT_LADDER,
  MODEL_SPECS,
  modelDefaultEffort,
  modelEfforts,
  modelSpec,
} from "../src/models/specs";
import {
  isAccountCredential,
  isDeepseekAccountMode,
  isPlanMode,
} from "../src/oauth/mode";

describe("账号额度判定", () => {
  it("只有 credential=chatgpt_plan 算套餐", () => {
    expect(isPlanMode({ credential: "chatgpt_plan" })).toBe(true);
    expect(isPlanMode({ credential: "deepseek_account" })).toBe(false);
    expect(isPlanMode({ credential: "api_key" })).toBe(false);
    expect(isPlanMode(null)).toBe(false);
  });

  it("DeepSeek 账号不是套餐，但算账号额度", () => {
    expect(isDeepseekAccountMode({ credential: "deepseek_account" })).toBe(true);
    expect(isAccountCredential({ credential: "deepseek_account" })).toBe(true);
    expect(isAccountCredential({ credential: "chatgpt_plan" })).toBe(true);
    expect(isAccountCredential({ credential: "api_key" })).toBe(false);
    expect(isAccountCredential(null)).toBe(false);
    expect(isAccountCredential({ credential: "" })).toBe(false);
  });
});

describe("模型特判合集", () => {
  it("套餐模型条目提供展示名", () => {
    for (const slug of [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]) {
      const { spec, known } = modelSpec("plan", slug);
      expect(known, slug).toBe(true);
      expect(spec.displayName, slug).toBeTruthy();
    }
  });

  it("未收录的模型不报错但必须标出 known=false", () => {
    const { spec, known } = modelSpec("plan", "brand-new-model");
    expect(known).toBe(false);
    expect(modelEfforts(spec)).toEqual(EFFORT_LADDER);
  });

  it("efforts 可以收窄档位；默认档不在可选里时落到最弱档", () => {
    expect(modelEfforts({ efforts: ["low", "high"] })).toEqual(["low", "high"]);
    expect(modelDefaultEffort({ efforts: ["low", "high"], defaultEffort: "ultra" })).toBe("low");
    expect(modelDefaultEffort({ defaultEffort: "xhigh" })).toBe("xhigh");
    // byok 桶空是有意的：说不出差异就别写。
    expect(MODEL_SPECS.byok).toEqual({});
  });

  it("档位按桶分开：套餐不含 max，DeepSeek 账号原样收平台的 max", () => {
    expect(EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    for (const spec of Object.values(MODEL_SPECS.plan)) {
      expect(modelEfforts(spec)).not.toContain("max");
    }
    for (const spec of Object.values(MODEL_SPECS.account)) {
      expect(modelEfforts(spec)).toEqual(["low", "high", "max"]);
    }
    expect(modelEfforts({})).toEqual(EFFORT_LADDER);
  });

});
