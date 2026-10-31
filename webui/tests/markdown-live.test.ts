// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

// Exercise real client reactivity/DOM, not Solid's default Node SSR runtime.
vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { Markdown } from "../src/markdown/Markdown";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

test("assistant DOM catches up without a tool signal even if animation frames are paused", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const [text, setText] = createSignal("已显示");
  const [streaming, setStreaming] = createSignal(true);
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(Markdown, {
    text,
    get streaming() { return streaming(); },
  }), root);
  try {
    await flush();
    expect(root.textContent).toBe("已显示");
    setText("已显示，后端收到工具之前的完整尾句。");
    await flush();
    await vi.advanceTimersByTimeAsync(150);
    expect(root.textContent).toBe(text());
    // No tool event / streaming=false was needed to release the tail.
    setStreaming(false);
    await flush();
    expect(root.textContent).toBe(text());
  } finally {
    dispose();
  }
});
