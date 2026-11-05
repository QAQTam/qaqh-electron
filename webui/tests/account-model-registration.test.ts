import { expect, test, vi } from "vitest";
import type { ModelDef, ModelSelection } from "@qaqh/sdk/protocol";

vi.mock("../src/lib/transport", () => ({
  transport: { command: vi.fn(), query: vi.fn() },
}));
vi.mock("../src/lib/config-events", () => ({ notifyConfigChanged: vi.fn() }));

import { transport } from "../src/lib/transport";
import { ensureAccountProfile } from "../src/settings/registry";

test("account registration keeps the advertised reasoning levels usable by the default selection", async () => {
  const models: Record<string, ModelDef> = {};
  let provider: Record<string, unknown> | undefined;
  let revision = 0;
  let selection: ModelSelection | null = null;
  vi.mocked(transport.query).mockResolvedValue({ profiles: {} });
  vi.mocked(transport.command).mockImplementation(async (command) => {
    if (command.type === "provider.list") {
      return {
        command_id: "catalog", status: "accepted",
        result: structuredClone({
          revision, default_model_selection: selection,
          providers: provider == null ? {} : { "deepseek-account": { ...provider, models } },
        }),
      };
    }
    if (command.type === "provider.upsert") provider = command.provider;
    if (command.type === "provider.model.upsert") models[command.model_id] = command.model;
    if (command.type === "model.selection.set_default") selection = command.selection;
    revision += 1;
    return { command_id: "write", status: "accepted", result: { revision } };
  });

  await expect(ensureAccountProfile({
    kind: "account", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    modelMetadata: {
      contextWindow: 1_048_576, maxOutputTokens: 393_216,
      reasoningLevels: ["low", "high", "max"], defaultEffort: "high",
    },
    makeDefault: true,
  })).resolves.toEqual({ providerId: "deepseek-account", modelId: "deepseek-flash" });

  const model = models["deepseek-flash"]!;
  expect(model.capabilities.reasoning).toBe(true);
  expect(model.reasoning_levels).toContain(model.defaults.reasoning_effort);
  expect(model.defaults.reasoning_effort).toBe("high");
  expect(selection).toEqual({ provider_id: "deepseek-account", model_id: "deepseek-flash", options: {} });

  selection = null;
  await ensureAccountProfile({
    kind: "account", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", makeDefault: false,
  });
  expect(selection).toBeNull();
});
