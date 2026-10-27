import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import {
  detectLowSpecHardware,
  isLowSpecActive,
  performanceMode,
  setPerformanceMode,
} from "../src/lib/visual";

describe("渲染性能模式 (visual performance mode)", () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, val); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };

  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
    setPerformanceMode("auto");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("双核或以下硬件能被正确识别为受限/低配硬件", () => {
    const original = navigator.hardwareConcurrency;
    try {
      Object.defineProperty(navigator, "hardwareConcurrency", { value: 2, configurable: true });
      expect(detectLowSpecHardware()).toBe(true);

      Object.defineProperty(navigator, "hardwareConcurrency", { value: 8, configurable: true });
      expect(detectLowSpecHardware()).toBe(false);
    } finally {
      Object.defineProperty(navigator, "hardwareConcurrency", { value: original, configurable: true });
    }
  });

  test("在强制 low 档位下恒定激活低配模式，在 quality 下停用", () => {
    setPerformanceMode("low");
    expect(performanceMode()).toBe("low");
    expect(isLowSpecActive()).toBe(true);

    setPerformanceMode("quality");
    expect(performanceMode()).toBe("quality");
    expect(isLowSpecActive()).toBe(false);
  });

  test("在 auto 档位下随硬件并发核数动态自适应", () => {
    setPerformanceMode("auto");
    const original = navigator.hardwareConcurrency;
    try {
      // 模拟受限硬件（双核）
      Object.defineProperty(navigator, "hardwareConcurrency", { value: 2, configurable: true });
      expect(isLowSpecActive()).toBe(true);

      // 模拟高性能硬件（16核）
      Object.defineProperty(navigator, "hardwareConcurrency", { value: 16, configurable: true });
      expect(isLowSpecActive()).toBe(false);
    } finally {
      Object.defineProperty(navigator, "hardwareConcurrency", { value: original, configurable: true });
    }
  });
});
