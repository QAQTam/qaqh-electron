// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

// Exercise real client reactivity/DOM, not Solid's default Node SSR runtime.
vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { Markdown } from "../src/markdown/Markdown";

const originalMatchMedia = window.matchMedia;
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true, value: originalMatchMedia,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Drive rAF by hand; the fallback timer stays under fake timers. */
function harness(options: { reduceMotion?: boolean } = {}) {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  let frame: FrameRequestCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { frame = null; });
  const matcher = (media: string) => ({
    matches: options.reduceMotion ?? false,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true, value: matcher,
  });

  const [text, setText] = createSignal("");
  const [streaming, setStreaming] = createSignal(true);
  const [revision, setRevision] = createSignal(0);
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(() => createComponent(Markdown, {
    text,
    get streaming() { return streaming(); },
    get revision() { return revision(); },
  }), root));

  return {
    setText,
    setStreaming,
    setRevision,
    text: () => root.textContent ?? "",
    hasFrame: () => frame != null,
    step: async (frames = 1): Promise<void> => {
      for (let i = 0; i < frames; i += 1) {
        const cb = frame;
        frame = null;
        clock += 16;
        cb?.(clock);
        await flush();
      }
    },
  };
}

test("大块突发按帧摊平,而不是一帧蹦出全文", async () => {
  const h = harness();
  const full = "字".repeat(300);
  h.setText(full);
  await flush();
  expect(h.hasFrame()).toBe(true);
  await h.step(1);
  expect(h.text().length).toBeGreaterThan(0);
  expect(h.text().length).toBeLessThan(300);
  await h.step(24);
  expect(h.text()).toBe(full);
  expect(h.hasFrame()).toBe(false);
});

test("正常逐 token 流与单个较长 token 一帧追平,不产生额外 reveal 帧", async () => {
  const h = harness();
  h.setText("Hello ");
  await flush();
  await h.step(1);
  expect(h.text()).toBe("Hello ");

  h.setText("Hello world");
  await flush();
  await h.step(1);
  expect(h.text()).toBe("Hello world");
  expect(h.hasFrame()).toBe(false);

  const next = "Hello world " + "x".repeat(20);
  h.setText(next);
  await flush();
  await h.step(1);
  expect(h.text()).toBe(next);
  expect(h.hasFrame()).toBe(false);
});

test("v3 累计全文替换不会重复拼接,reveal 中途换 target 仍收敛到最新全文", async () => {
  const h = harness();
  h.setText("A".repeat(200));
  await flush();
  await h.step(1);
  expect(h.text().length).toBeGreaterThan(0);
  expect(h.text().length).toBeLessThan(200);

  // message_delta.text 是累计全文;若按旧的增量片段 append 语义处理会变成 600 字。
  h.setText("A".repeat(400));
  await flush();
  await h.step(24);
  expect(h.text()).toBe("A".repeat(400));
  expect(h.text().length).toBe(400);

  h.setText("第一段");
  await flush();
  await h.step(1);
  expect(h.text()).toBe("第一段");
  h.setText("第一段，第二段");
  await flush();
  await h.step(1);
  expect(h.text()).toBe("第一段，第二段");
});

test("resync / 快照整块落地直接全量显示", async () => {
  const h = harness();
  const full = "x".repeat(5_000);
  h.setText(full);
  await flush();
  await h.step(1);
  expect(h.text().length).toBe(5_000);
});

test("封口立即补齐未露完的突发,不留半截", async () => {
  const h = harness();
  const full = "字".repeat(300);
  h.setText(full);
  await flush();
  await h.step(1);
  expect(h.text().length).toBeLessThan(300);
  h.setStreaming(false);
  await flush();
  expect(h.text()).toBe(full);
  expect(h.hasFrame()).toBe(false);
});

test("正文整体替换或 revision 变化时整块重画,不做入场动画", async () => {
  const h = harness();
  h.setText("字".repeat(300));
  await flush();
  await h.step(1);
  expect(h.text().length).toBeLessThan(300);

  h.setText("完全不同的正文");
  await flush();
  expect(h.text()).toBe("完全不同的正文");

  h.setRevision(1);
  await flush();
  expect(h.text()).toBe("完全不同的正文");
});

test("prefers-reduced-motion 下突发也直接全量", async () => {
  const h = harness({ reduceMotion: true });
  const full = "字".repeat(300);
  h.setText(full);
  await flush();
  await h.step(1);
  expect(h.text()).toBe(full);
});

test("rAF 暂停时兜底定时器一次画完,不留下半截 reveal", async () => {
  const h = harness();
  const full = "字".repeat(300);
  h.setText(full);
  await flush();
  await h.step(1);
  expect(h.text().length).toBeLessThan(300);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.text()).toBe(full);
});
