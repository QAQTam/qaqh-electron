// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { Sidebar } from "../src/app/Sidebar";

afterEach(() => document.body.replaceChildren());

test("settings sidebar switches sections and reflects the current selection", async () => {
  const [section, setSection] = createSignal("section-providers");
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(Sidebar, {
    section: "settings", onNavigate: vi.fn(),
    get settingsSection() { return section(); }, onSettingsSection: setSection,
  }), root);
  try {
    await flush();
    const providers = root.querySelector<HTMLButtonElement>('[data-section-id="section-providers"]')!;
    const appearance = root.querySelector<HTMLButtonElement>('[data-section-id="section-appearance"]')!;
    expect(providers.getAttribute("aria-current")).toBe("page");
    appearance.click();
    await flush();
    expect(section()).toBe("section-appearance");
    expect(appearance.getAttribute("aria-current")).toBe("page");
    expect(providers.hasAttribute("aria-current")).toBe(false);
  } finally { dispose(); }
});
