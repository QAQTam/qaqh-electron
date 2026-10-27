import { afterEach, describe, expect, it, vi } from "vitest";

const { flush } = vi.hoisted(() => ({ flush: vi.fn() }));
vi.mock("solid-js", () => ({ flush }));

import { withViewTransition } from "../src/ui/viewTransition";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fixture(platform: string, perfMode = "normal", reducedMotion = false) {
  let pending: (() => void) | undefined;
  const startViewTransition = vi.fn((update: () => void) => { pending = update; });
  vi.stubGlobal("document", {
    documentElement: { dataset: { platform, perfMode } },
    startViewTransition,
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reducedMotion })));
  return { startViewTransition, commit: () => pending?.() };
}

describe("视图过渡安全降级", () => {
  it("Linux 即使暴露 API 也不得调用:软件渲染后端会导致原生 SIGABRT", () => {
    const { startViewTransition } = fixture("linux");
    startViewTransition.mockImplementation(() => { throw new Error("unsafe native API"); });
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledExactlyOnceWith();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it.each(["windows", "macos"])("%s 保留异步视图过渡,更新后 flush 一次", (platform) => {
    const { startViewTransition, commit } = fixture(platform);
    const update = vi.fn();
    withViewTransition(update);
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    commit();
    expect(update).toHaveBeenCalledExactlyOnceWith();
    expect(flush).toHaveBeenCalledExactlyOnceWith();
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]!);
  });

  it("低配模式不用原生视图过渡", () => {
    const { startViewTransition } = fixture("windows", "low");
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("减少动态效果偏好不用原生视图过渡", () => {
    const { startViewTransition } = fixture("macos", "normal", true);
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("没有 API 或 matchMedia 时仍可直接更新", () => {
    fixture("windows");
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("matchMedia", undefined);
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });

  it("没有 document 时不访问浏览器对象", () => {
    vi.stubGlobal("document", undefined);
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
