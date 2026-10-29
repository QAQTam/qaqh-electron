/** 壳断点纯函数(spec §4.6):1280/800 两条边界,闭区间归左。 */
import { describe, expect, test } from "vitest";
import { shellColsFor } from "../src/lib/shell-cols";

describe("shellColsFor", () => {
  test("≥1280 三列;边界值归左", () => {
    expect(shellColsFor(1280)).toBe(3);
    expect(shellColsFor(1920)).toBe(3);
    expect(shellColsFor(1279)).not.toBe(3);
  });

  test("800–1279 两列;边界值归左", () => {
    expect(shellColsFor(800)).toBe(2);
    expect(shellColsFor(1279)).toBe(2);
    expect(shellColsFor(799)).not.toBe(2);
  });

  test("<800 单列(抽屉态)", () => {
    expect(shellColsFor(799)).toBe(1);
    expect(shellColsFor(640)).toBe(1);
    expect(shellColsFor(320)).toBe(1);
  });

  test("非法宽度不抛,按最小壳处理", () => {
    expect(shellColsFor(0)).toBe(1);
    expect(shellColsFor(Number.NaN)).toBe(1);
  });
});
