/** Merge-patch helpers for fields owned by the global config settings surface. */
import { describe, expect, test } from "vitest";
import type { ConfigDto } from "../src/api/qaqh/ConfigDto";
import {
  MASK,
  buildPatch,
  isPatchEmpty,
  needsBypassConfirm,
  validatePatch,
  type ConfigPatchWire,
} from "../src/settings/patch";

function dto(overrides: Partial<ConfigDto> = {}): ConfigDto {
  const base: ConfigDto = {
    model: "ox-alpha-free",
    baseUrl: "https://opencode.ai/zen/go/v1",
    wire: "chat",
    credential: "api_key",
    maxTokens: 96000,
    contextLength: 1000000,
    reasoningEffort: "max",
    autoCompactThreshold: 0.95,
    permissionLevel: 2,
    apiKey: MASK,
    lang: null,
    fontFamily: "",
    theme: null,
    notificationsEnabled: true,
    activeProfile: "default",
    profiles: ["default"],
    profilesDetail: {},
    exec: { defaultShell: null },
    sessionIdleUnloadSecs: 0,
    mcp: { enabled: false, idleShutdownSecs: 300, servers: [] },
    lsp: { enabled: false, idleShutdownSecs: 600, servers: [] },
    tokenizerPath: null,
    sandbox: { enabled: false },
    toolAllowlistEnabled: false,
    toolAllowlist: [],
    goals: { enabled: true, maxTokenBudget: null },
  };
  return { ...base, ...overrides };
}

describe("buildPatch", () => {
  test("identical drafts produce an empty patch", () => {
    expect(isPatchEmpty(buildPatch(dto(), dto()))).toBe(true);
  });

  test("only changed fields owned by this settings surface are sent", () => {
    expect(buildPatch(dto(), dto({ autoCompactThreshold: 0.5, sessionIdleUnloadSecs: 900 }))).toEqual({
      autoCompactThreshold: 0.5,
      sessionIdleUnloadSecs: 900,
    });
    // Provider and model settings are persisted through their dedicated v3 commands.
    expect(buildPatch(dto(), dto({ model: "another-model", baseUrl: "https://example.test" }))).toEqual({});
  });

  test("tokenizer path can be explicitly cleared and theme remains local", () => {
    expect(buildPatch(dto({ tokenizerPath: "/tmp/tok.json" }), dto()).tokenizerPath).toBe("");
    expect(buildPatch(dto(), dto({ theme: "dark" }))).toEqual({});
    expect(buildPatch(dto({ theme: "dark" }), dto({ theme: null }))).toEqual({});
  });

  test("exec shell changes are sent only when changed", () => {
    expect(buildPatch(dto(), dto()).exec).toBeUndefined();
    expect(buildPatch(dto(), dto({ exec: { defaultShell: "pwsh" } })).exec).toEqual({ defaultShell: "pwsh" });
    expect(buildPatch(dto({ exec: { defaultShell: "pwsh" } }), dto()).exec).toEqual({ defaultShell: "" });
  });

  test("retired subagent config surface never appears in patches (ADR-0018)", () => {
    const raw = buildPatch(dto(), dto()) as Record<string, unknown>;
    expect(raw.subagent).toBeUndefined();
  });

  test("goals changes are sparse; maxTokenBudget sends null to clear and stays absent when untouched", () => {
    expect(buildPatch(dto(), dto()).goals).toBeUndefined();
    expect(buildPatch(dto(), dto({ goals: { enabled: false, maxTokenBudget: null } })).goals).toEqual({ enabled: false });
    // null = 清除上限是显式语义,必须真的出现在 wire 上(K3 有意例外)。
    expect(buildPatch(dto({ goals: { enabled: true, maxTokenBudget: 4096 } }), dto()).goals).toEqual({ maxTokenBudget: null });
    expect(buildPatch(dto(), dto({ goals: { enabled: true, maxTokenBudget: 8192 } })).goals).toEqual({ maxTokenBudget: 8192 });
  });

  test("bypass confirmation is required only when changing to permission level 3", () => {
    expect(needsBypassConfirm(buildPatch(dto(), dto({ permissionLevel: 3 })))).toBe(true);
    expect(needsBypassConfirm(buildPatch(dto(), dto({ permissionLevel: 1 })))).toBe(false);
  });
});

describe("validatePatch", () => {
  test("validates compact threshold bounds and finite values", () => {
    expect(validatePatch({ autoCompactThreshold: 0 })).toBeNull();
    expect(validatePatch({ autoCompactThreshold: 1 })).toBeNull();
    expect(validatePatch({ autoCompactThreshold: 1.5 })).toContain("autoCompactThreshold");
    expect(validatePatch({ autoCompactThreshold: Number.NaN })).toContain("autoCompactThreshold");
  });

  test("permission levels are limited to the current three-tier model", () => {
    for (const level of [1, 2, 3]) expect(validatePatch({ permissionLevel: level })).toBeNull();
    expect(validatePatch({ permissionLevel: 4 })).toContain("permissionLevel");
  });

  test("goals budget rejects 0 and NaN but allows positive values and null", () => {
    // 镜像后端 validate:只拒 0;null=清除,正数放行。
    expect(validatePatch({ goals: { maxTokenBudget: 0 } })).toContain("goals.maxTokenBudget");
    expect(validatePatch({ goals: { maxTokenBudget: Number.NaN } })).toContain("goals.maxTokenBudget");
    expect(validatePatch({ goals: { maxTokenBudget: null } })).toBeNull();
    expect(validatePatch({ goals: { maxTokenBudget: 4096 } })).toBeNull();
  });

  test("a clean generated patch passes validation", () => {
    const patch: ConfigPatchWire = buildPatch(dto(), dto());
    expect(validatePatch(patch)).toBeNull();
  });
});
