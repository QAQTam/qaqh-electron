import { describe, expect, it } from "vitest";

import { EFFORT_LADDER, reasoningTiers } from "../src/models/reasoning";
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

describe("推理档位只来自声明的元数据", () => {
  it("保留协议词表，不为缺失能力的模型生成档位", () => {
    expect(EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(reasoningTiers()).toEqual([]);
    expect(reasoningTiers(["low", "high", "max"])).toEqual(["low", "high", "max"]);
  });
});
