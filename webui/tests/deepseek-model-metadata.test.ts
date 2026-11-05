import { expect, test, vi } from "vitest";

vi.mock("../src/lib/transport/backend", () => ({ isDesktopRuntime: () => true }));
vi.mock("../src/lib/transport", () => ({ transport: { query: vi.fn() }, openExternalUrl: vi.fn() }));

import { transport } from "../src/lib/transport";
import { dsaccountModels } from "../src/lib/dsaccount";

test("account discovery carries server display names, limits, modalities and reasoning levels to the picker", async () => {
  vi.mocked(transport.query).mockResolvedValue([{ id: "deepseek-flash", name: "DeepSeek Flash",
    context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ["text", "image"],
    effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
  }]);
  await expect(dsaccountModels()).resolves.toEqual([{ slug: "deepseek-flash", displayName: "DeepSeek Flash",
    contextWindow: 1_048_576, maxOutputTokens: 393_216, imageInput: true,
    reasoningLevels: ["low", "high", "max"], defaultEffort: "high",
  }]);
});

test("missing or malformed metadata stays unknown instead of disabling capabilities or inventing limits", async () => {
  vi.mocked(transport.query).mockResolvedValue([{ id: "custom", name: " ", context_window: -1,
    max_output_tokens: 0, input_modalities: "image", effort: { supported_levels: ["high", 1] },
  }]);
  await expect(dsaccountModels()).resolves.toEqual([{ slug: "custom", displayName: "custom" }]);
});
