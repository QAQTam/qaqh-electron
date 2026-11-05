import { beforeEach, expect, test, vi } from "vitest";
import type { ModelDef, ModelSelection } from "@qaqh/sdk/protocol";

vi.mock("../src/lib/transport", () => ({ transport: { command: vi.fn(), query: vi.fn() } }));
vi.mock("../src/lib/config-events", () => ({ notifyConfigChanged: vi.fn(), onConfigChanged: vi.fn(() => () => {}) }));

import { transport } from "../src/lib/transport";
import { mergeModelMetadata } from "../src/oauth/model-metadata";
import { ensureAccountProfile, modelSelectionIssue, refreshRegistry, registry, registryError, syncAccountCatalog } from "../src/settings/registry";

const entry = {
  slug: "deepseek-flash", displayName: "DeepSeek Flash", contextWindow: 1_048_576,
  maxOutputTokens: 393_216, reasoningLevels: ["low", "high", "max"], defaultEffort: "high", imageInput: true,
};

beforeEach(() => vi.clearAllMocks());

function mockCatalog(initial?: ModelDef) {
  const models: Record<string, ModelDef> = initial == null ? {} : { [entry.slug]: structuredClone(initial) };
  const providers: Record<string, Record<string, unknown>> = {
    "deepseek-account": { name: "DeepSeek", base_url: "https://api.deepseek.com", wire: "responses",
      credential: "deepseek_account", models },
  };
  const selection: ModelSelection = { provider_id: "other", model_id: "keep-my-default", options: {} };
  let revision = 10;
  vi.mocked(transport.query).mockResolvedValue({ profiles: {} });
  vi.mocked(transport.command).mockImplementation(async (command, _seed, preconditions) => {
    if (command.type === "provider.list") return {
      command_id: "read", status: "accepted",
      result: structuredClone({ revision, default_model_selection: selection, providers }),
    };
    expect(preconditions).toEqual([{ kind: "config_revision", revision }]);
    if (command.type === "provider.upsert") providers[command.id] = { ...command.provider, models: {} };
    if (command.type === "provider.model.upsert") {
      const target = providers[command.provider_id]!.models as Record<string, ModelDef>;
      target[command.model_id] = command.model;
    }
    // Discovery must never choose a model or edit saved profiles.
    expect(command.type).not.toBe("model.selection.set_default");
    expect(command.type).not.toMatch(/^profile\./);
    revision += 1;
    return { command_id: "write", status: "accepted", result: { revision } };
  });
  return models;
}

test("refresh updates existing limits and effort support, preserving disabled models and valid local preferences", async () => {
  const previous = mergeModelMetadata(entry)!;
  previous.enabled = false;
  previous.max_output_tokens = 500_000;
  previous.reasoning_levels = ["xhigh"];
  previous.defaults = { max_output_tokens: 16_384, reasoning_effort: "xhigh", native_web_search: false };
  previous.capabilities.tool_calls = true;
  const models = mockCatalog(previous);
  await expect(syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [entry] }))
    .resolves.toBe("deepseek-account");
  expect(models[entry.slug]).toMatchObject({
    enabled: false, max_output_tokens: 393_216, reasoning_levels: ["low", "high", "max"],
    defaults: { max_output_tokens: 16_384, reasoning_effort: "high" },
    capabilities: { tool_calls: true, image_input: true },
  });
  const writes = vi.mocked(transport.command).mock.calls.filter(([command]) => command.type === "provider.model.upsert");
  await syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [entry] });
  expect(vi.mocked(transport.command).mock.calls.filter(([command]) => command.type === "provider.model.upsert"))
    .toHaveLength(writes.length);
  await expect(ensureAccountProfile({ kind: "account", baseUrl: "https://api.deepseek.com", model: entry.slug }))
    .resolves.toBeNull();
  expect(registryError()).toContain("已停用");
});

test("partial or empty catalogs keep saved models; new incomplete models do not get invented limits", async () => {
  const previous = mergeModelMetadata(entry)!;
  const models = mockCatalog(previous);
  await syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [] });
  await syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [
    { slug: "unknown", displayName: "Unknown" }, { slug: entry.slug, displayName: entry.displayName },
  ] });
  expect(models[entry.slug]).toEqual(previous);
  expect(models.unknown).toBeUndefined();
});

test("parallel discoveries serialize revision guarded writes", async () => {
  const models = mockCatalog();
  await Promise.all([
    syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [entry] }),
    syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [{ ...entry, slug: "another" }] }),
  ]);
  expect(Object.keys(models)).toEqual([entry.slug, "another"]);
});

test("a response from an old login cannot import models after that login changes", async () => {
  const models = mockCatalog();
  await syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [entry], isCurrent: () => false });
  expect(models).toEqual({});
});

test("remote limits clamp local output defaults and removed capabilities are cleared only when declared", () => {
  const previous = mergeModelMetadata(entry)!;
  expect(mergeModelMetadata({ ...entry, maxOutputTokens: 4096, reasoningLevels: [], imageInput: false }, previous))
    .toMatchObject({ defaults: { max_output_tokens: 4096, reasoning_effort: null }, capabilities: { reasoning: false, image_input: false } });
  expect(mergeModelMetadata({ slug: entry.slug, displayName: entry.displayName }, previous)).toEqual(previous);
  expect(mergeModelMetadata({ ...entry, contextWindow: NaN, maxOutputTokens: -1 })).toBeNull();
});

test("profiles reject unavailable models, unsupported efforts and excessive output limits", () => {
  const model = mergeModelMetadata(entry)!;
  expect(modelSelectionIssue(model, "high", 16_384)).toBeNull();
  expect(modelSelectionIssue(model, "xhigh", null)).toContain("未声明支持");
  expect(modelSelectionIssue(model, null, 400_000)).toContain("最大输出");
  expect(modelSelectionIssue(undefined, null, null)).toContain("不在服务商目录");
});

test("provider catalog is read without joining legacy profiles", async () => {
  const model = mergeModelMetadata(entry)!;
  vi.mocked(transport.command).mockResolvedValue({ command_id: "read", status: "accepted", result: {
    revision: 1, default_model_selection: { provider_id: "account", model_id: entry.slug, options: { reasoning_effort: "high" } },
    providers: {
      byok: { name: "API key", base_url: "https://api.deepseek.com", wire: "responses", credential: "api_key", models: { [entry.slug]: model } },
      account: { name: "Account", base_url: "https://api.deepseek.com", wire: "responses", credential: "deepseek_account", models: { [entry.slug]: model } },
    },
  } });
  vi.mocked(transport.query).mockClear();
  await refreshRegistry();
  expect(registry()?.providers.map((provider) => provider.id)).toEqual(["byok", "account"]);
  expect(transport.query).not.toHaveBeenCalled();
});

test("a rejected metadata write is reported as a failure", async () => {
  mockCatalog();
  const original = vi.mocked(transport.command).getMockImplementation()!;
  vi.mocked(transport.command).mockImplementation(async (...args) => args[0].type === "provider.model.upsert"
    ? { command_id: "rejected", status: "rejected", message: "revision conflict" } : original(...args));
  await expect(syncAccountCatalog({ kind: "account", baseUrl: "https://api.deepseek.com", models: [entry] })).resolves.toBeNull();
  expect(registryError()).toBe("revision conflict");
});
