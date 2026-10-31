import { afterEach, expect, test, vi } from "vitest";
import { createPaintScheduler } from "../src/markdown/paint";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
  let text = "";
  const paints: string[] = [];
  const scheduler = createPaintScheduler(() => paints.push(text), () => Date.now());
  return { paints, scheduler, set: (value: string) => { text = value; },
    frame: () => { const callback = frame; frame = undefined; callback?.(0); } };
}

test("one frame paints all received assistant text, without a character reveal backlog", () => {
  const h = harness();
  h.set("前半句");
  h.scheduler.schedule();
  h.set("前半句，后半句也已经到达。");
  h.scheduler.schedule();
  h.frame();
  expect(h.paints).toEqual(["前半句，后半句也已经到达。"]);
  vi.advanceTimersByTime(500);
  expect(h.paints).toHaveLength(1);
});

test("paused rAF paints the tail without waiting for a tool or seal event", () => {
  const h = harness();
  h.set("没有后续事件也必须显示的尾巴");
  h.scheduler.schedule();
  vi.advanceTimersByTime(120);
  expect(h.paints).toEqual(["没有后续事件也必须显示的尾巴"]);
});

test("over-budget painting coalesces updates without restarting its deadline", () => {
  const h = harness();
  const due = Date.now() + 120;
  for (let i = 0; i < 6; i++) {
    h.set(`latest-${i}`);
    h.scheduler.schedule(due);
    vi.advanceTimersByTime(20);
  }
  expect(h.paints).toEqual(["latest-5"]);
});

test("seal flush bypasses throttle and cancels every scheduled callback", () => {
  const h = harness();
  h.set("完整输出");
  h.scheduler.schedule(Date.now() + 120);
  h.scheduler.flush();
  expect(h.paints).toEqual(["完整输出"]);
  vi.advanceTimersByTime(500);
  h.frame();
  expect(h.paints).toHaveLength(1);
});

test("dispose cancels the frame and fallback timer", () => {
  const h = harness();
  h.scheduler.schedule();
  h.scheduler.cancel();
  h.frame();
  vi.advanceTimersByTime(500);
  expect(h.paints).toEqual([]);
});
