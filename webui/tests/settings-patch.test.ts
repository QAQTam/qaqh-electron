/** Merge-patch helpers for fields owned by the global config settings surface. */
import { describe, expect, test } from "vitest";
import type { ConfigDto } from "../src/api/qaqh/ConfigDto";
import type { SubagentDto } from "../src/api/qaqh/SubagentDto";
import {
  MASK,
  buildPatch,
  formatToolList,
  isPatchEmpty,
  needsBypassConfirm,
  parseToolList,
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
    complianceEnabled: false,
    exec: { defaultShell: null },
    sessionIdleUnloadSecs: 0,
    subagent: {
      model: "",
      baseUrl: "",
      apiKey: "",
      apiKeySet: false,
      maxTokens: 4096,
      timeoutSecs: 120,
      defaultTools: [],
      maxDepth: 1,
      messageInFlightPerPair: 16,
      messageOutboundPerSender: 1024,
    },
    mcp: { enabled: false, idleShutdownSecs: 300, servers: [] },
    lsp: { enabled: false, idleShutdownSecs: 600, servers: [] },
    tokenizerPath: null,
    sandbox: { enabled: false },
    toolAllowlistEnabled: false,
    toolAllowlist: [],
  };
  return { ...base, ...overrides };
}

function withSubagent(base: ConfigDto, overrides: Partial<SubagentDto>): ConfigDto {
  return { ...base, subagent: { ...base.subagent, ...overrides } };
}

describe("buildPatch", () => {
  test("identical drafts produce an empty patch", () => {
    expect(isPatchEmpty(buildPatch(dto(), dto()))).toBe(true);
  });

  test("only changed fields owned by this settings surface are sent", () => {
    expect(buildPatch(dto(), dto({ complianceEnabled: true, sessionIdleUnloadSecs: 900 }))).toEqual({
      complianceEnabled: true,
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

  test("subagent changes are sparse and compare tool lists by content", () => {
    expect(buildPatch(dto(), dto()).subagent).toBeUndefined();
    expect(buildPatch(dto(), withSubagent(dto(), { timeoutSecs: 240 })).subagent).toEqual({ timeoutSecs: 240 });
    expect(buildPatch(dto(), withSubagent(dto(), { defaultTools: ["read"] })).subagent).toEqual({ defaultTools: ["read"] });
    expect(buildPatch(withSubagent(dto(), { defaultTools: ["read"] }), dto()).subagent).toEqual({ defaultTools: [] });
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

  test("validates subagent depth and timeout limits", () => {
    expect(validatePatch({ subagent: { maxDepth: 17 } })).toContain("subagent.maxDepth");
    expect(validatePatch({ subagent: { maxDepth: 1 } })).toBeNull();
    expect(validatePatch({ subagent: { timeoutSecs: 0 } })).toContain("subagent.timeoutSecs");
    // subagent.maxTokens 已随 providers.toml 目录退役（ringing-commands-7）。
    expect(validatePatch({ subagent: {} })).toBeNull();
  });

  test("a clean generated patch passes validation", () => {
    const patch: ConfigPatchWire = buildPatch(dto(), dto());
    expect(validatePatch(patch)).toBeNull();
  });
});

test("tool list text parsing trims blank entries and formats canonical comma lists", () => {
  expect(parseToolList("read, write ,")).toEqual(["read", "write"]);
  expect(parseToolList("")).toEqual([]);
  expect(formatToolList(["read", "write"])).toBe("read, write");
});
