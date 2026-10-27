import { describe, expect, it } from "vitest";

import { EFFORT_LADDER } from "../src/models/specs";
import {
  effortDisplayOf,
  effortFillPercent,
  stepTier,
  tierIndexForPointer,
  tierTone,
} from "../src/composer/effort-track";

const RECT = { left: 100, width: 400 };

describe("轨道：指针 → 档位", () => {
  it("两端与中点都落在正确的档上（5 档）", () => {
    expect(tierIndexForPointer(100, RECT, 5)).toBe(0);
    expect(tierIndexForPointer(200, RECT, 5)).toBe(1);
    expect(tierIndexForPointer(300, RECT, 5)).toBe(2);
    expect(tierIndexForPointer(400, RECT, 5)).toBe(3);
    expect(tierIndexForPointer(500, RECT, 5)).toBe(4);
  });

  it("越界夹住，不返回 -1/5（拖出轨道外是最常见的一手）", () => {
    expect(tierIndexForPointer(0, RECT, 5)).toBe(0);
    expect(tierIndexForPointer(-999, RECT, 5)).toBe(0);
    expect(tierIndexForPointer(9999, RECT, 5)).toBe(4);
  });

  it("半数才跳档（拖动时的手感边界）", () => {
    // 第 0→1 档的分界在 150（400/4 = 100 一格，半格 50）。
    expect(tierIndexForPointer(149, RECT, 5)).toBe(0);
    expect(tierIndexForPointer(151, RECT, 5)).toBe(1);
  });

  it("退化输入不炸：零宽 / 单档", () => {
    expect(tierIndexForPointer(120, { left: 100, width: 0 }, 5)).toBe(0);
    expect(tierIndexForPointer(120, RECT, 1)).toBe(0);
    expect(tierIndexForPointer(120, RECT, 0)).toBe(0);
  });
});

describe("轨道：填充比例", () => {
  it("首档 0%、末档 100%、中间等分", () => {
    expect(effortFillPercent(0, 5)).toBe(0);
    expect(effortFillPercent(2, 5)).toBe(50);
    expect(effortFillPercent(4, 5)).toBe(100);
  });

  it("越界夹住；单档恒为 0（没有可填充的跨度）", () => {
    expect(effortFillPercent(-3, 5)).toBe(0);
    expect(effortFillPercent(99, 5)).toBe(100);
    expect(effortFillPercent(0, 1)).toBe(0);
  });
});

describe("键盘步进", () => {
  it("两端停住，不循环（循环会让最强档多按一下掉到最弱）", () => {
    expect(stepTier(EFFORT_LADDER, "low", -1)).toBe("low");
    expect(stepTier(EFFORT_LADDER, "ultra", 1)).toBe("ultra");
    // 阶梯六档（后端同序）：xhigh → **max** → ultra。
    expect(stepTier(EFFORT_LADDER, "xhigh", 1)).toBe("max");
    expect(stepTier(EFFORT_LADDER, "max", 1)).toBe("ultra");
    expect(stepTier(EFFORT_LADDER, "medium", -1)).toBe("low");
  });

  it("当前值不在档位表里 → 落到首档；空表 → 原样返回", () => {
    expect(stepTier(["low", "high"], "ultra", 1)).toBe("low");
    expect(stepTier([], "high", 1)).toBe("high");
  });

  it("收窄过的档位表也按它自己的顺序步进", () => {
    expect(stepTier(["low", "high"], "low", 1)).toBe("high");
    expect(stepTier(["low", "high"], "high", 1)).toBe("high");
  });
});

describe("配色分级", () => {
  it("只有 ultra 走特殊配色，其余同一档色", () => {
    expect(tierTone("ultra")).toBe("ultra");
    for (const tier of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(tierTone(tier)).toBe("normal");
    }
  });
});

/**
 * chip 上那个词的三态（回归："默认显示轻度，点进去才变真值"）。
 *
 * 病根是把"还没读到配置"和"后端就是第一档"画成同一个样子：首帧
 * `currentEffort()` 为空 → `?? allowed[0]` → `low`/「轻度」，而后端 profile
 * 缺省时回填的是 `high`。
 */
describe("档名三态", () => {
  const LADDER = EFFORT_LADDER;

  it("配置还没读到 → pending：不许报任何档名", () => {
    expect(effortDisplayOf("", LADDER, false)).toEqual({ kind: "pending" });
    // 读失败留下一个旧值也不许当真：loaded=false 一律压过值本身。
    expect(effortDisplayOf("high", LADDER, false)).toEqual({ kind: "pending" });
  });

  it("读到空串 = 没设过，与「没读到」分开说", () => {
    expect(effortDisplayOf("", LADDER, true)).toEqual({ kind: "unset" });
    expect(effortDisplayOf("   ", LADDER, true)).toEqual({ kind: "unset" });
  });

  it("读到且在表里 → 就是那个档（后端真值优先，绝不再落到首档）", () => {
    expect(effortDisplayOf("high", LADDER, true)).toEqual({ kind: "tier", tier: "high" });
    expect(effortDisplayOf("max", LADDER, true)).toEqual({ kind: "tier", tier: "max" });
  });

  it("读到但不在当前模型的档位表里 → offLadder 并原样带出那个值", () => {
    // 例：套餐桶只到 ultra 但没有 max，而配置里留着别处带来的 max。
    expect(effortDisplayOf("max", ["low", "medium", "high", "xhigh", "ultra"], true)).toEqual({
      kind: "offLadder",
      raw: "max",
    });
    // 后端 `EFFORT_OFF` 会把这类值提升成 `low` 再发（思考不可关），但 `config.load`
    // 原样回吐存的串 —— 界面要说"后端现值是 minimal"，不许冒充第一档或替它改写。
    expect(effortDisplayOf("minimal", LADDER, true)).toEqual({ kind: "offLadder", raw: "minimal" });
  });

  it("值两边空白都吃掉：带空格的配置值仍认得出来", () => {
    expect(effortDisplayOf("  xhigh ", LADDER, true)).toEqual({ kind: "tier", tier: "xhigh" });
  });
});
