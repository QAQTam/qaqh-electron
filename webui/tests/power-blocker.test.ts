/** 休眠限制纯逻辑:模式归一化、双开关互转、无 localStorage 时的降级。 */
import { describe, expect, test } from "vitest";
import {
  modeFromToggles,
  normalizeMode,
  storedPowerMode,
  togglesFromMode,
} from "../src/lib/power-blocker";

describe("normalizeMode", () => {
  test("合法模式原样通过", () => {
    expect(normalizeMode("off")).toBe("off");
    expect(normalizeMode("keep-awake")).toBe("keep-awake");
    expect(normalizeMode("keep-awake-bright")).toBe("keep-awake-bright");
  });

  test("非法/历史残留值退到 off,不抛错", () => {
    expect(normalizeMode("sleep")).toBe("off");
    expect(normalizeMode(null)).toBe("off");
    expect(normalizeMode(undefined)).toBe("off");
    expect(normalizeMode(42)).toBe("off");
    expect(normalizeMode("")).toBe("off");
  });
});

describe("modeFromToggles / togglesFromMode 互转", () => {
  test("常亮蕴含阻止休眠:只开常亮也是 bright", () => {
    expect(modeFromToggles(false, true)).toBe("keep-awake-bright");
  });

  test("标准组合", () => {
    expect(modeFromToggles(false, false)).toBe("off");
    expect(modeFromToggles(true, false)).toBe("keep-awake");
    expect(modeFromToggles(true, true)).toBe("keep-awake-bright");
  });

  test("关掉「阻止休眠」时忽略常亮(用户预期:全关)", () => {
    expect(modeFromToggles(false, true)).not.toBe("keep-awake");
  });

  test("回显互转:每个模式都能还原出一致的双开关", () => {
    for (const mode of ["off", "keep-awake", "keep-awake-bright"] as const) {
      const t = togglesFromMode(mode);
      expect(modeFromToggles(t.keepAwake, t.keepBright)).toBe(mode);
    }
    expect(togglesFromMode("keep-awake-bright")).toEqual({ keepAwake: true, keepBright: true });
  });
});

describe("storedPowerMode", () => {
  test("node 环境无 localStorage,安全降级为 off 不抛错", () => {
    expect(storedPowerMode()).toBe("off");
  });
});
