// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));
vi.mock("../src/composer/model-config", () => ({
  availableTiers: () => ["low", "high", "max"], catalogError: () => null, catalogOptions: () => [],
  configError: () => null, configLoaded: () => true, currentEffort: () => "high", currentModel: () => "global-model",
  currentProviderKind: () => "account", defaultTier: () => "high", loadCatalog: vi.fn(), refreshConfig: vi.fn(),
  modelMetadata: () => ({ maxOutputTokens: 393_216, reasoningLevels: ["low", "high", "max"] }),
}));

import { createComponent, flush } from "solid-js";
import { render } from "@solidjs/web";
import { EffortCard } from "../src/composer/EffortCard";

afterEach(() => document.body.replaceChildren());

test("session effort overrides are used consistently in chip, warning and reset", async () => {
  const onEffort = vi.fn();
  const onMaxTokens = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(EffortCard, {
    open: true, onToggle: vi.fn(), model: () => "session-model", effort: () => "xhigh",
    providerKind: () => "account", modelOverridden: () => true, effortOverridden: () => true,
    maxTokens: () => 16_384, onEffort, onMaxTokens,
  }), root);
  try {
    await flush();
    expect(root.querySelector(".effort-trigger")!.textContent).toContain("xhigh");
    expect(root.querySelector(".effort-trigger .effort-tone-warning")).not.toBeNull();
    const warning = root.querySelector(".effort-card__note.is-error")!.textContent;
    expect(warning).toContain("「xhigh」");
    expect(warning).not.toContain("「high」");
    expect(root.textContent).toContain("模型单独设置 · 强度单独设置");
    expect(root.textContent).toContain("模型输出上限：393,216 tokens");
    root.querySelector<HTMLButtonElement>(".effort-card__reset")!.click();
    expect(onEffort).toHaveBeenCalledWith("high");
    root.querySelector<HTMLButtonElement>(".effort-card__inherit")!.click();
    expect(onEffort).toHaveBeenCalledWith(null);
    const input = root.querySelector<HTMLInputElement>(".effort-card__params input")!;
    input.focus();
    input.value = "400000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    input.blur();
    await flush();
    expect(onMaxTokens).not.toHaveBeenCalled();
    expect(root.textContent).toContain("不能超过模型上限");
  } finally { dispose(); }
});
