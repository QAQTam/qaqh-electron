/** 手搓图表的数学:占比要能对上 100%,趋势点不能画到画布外。 */
import { describe, expect, it } from "vitest";
import { ringSegments, sparkline } from "../src/lib/dev-charts";

const CIRC = 100;

describe("ringSegments", () => {
  it("弧长与偏移铺满整圈", () => {
    const segments = ringSegments([50, 30, 20], CIRC);
    expect(segments).toHaveLength(3);
    expect(segments[0]!.dashOffset).toBe(0);
    expect(segments[1]!.dashOffset).toBeCloseTo(-50);
    expect(segments[2]!.dashOffset).toBeCloseTo(-80);
    const arcs = segments.map((row) => Number.parseFloat(row.dashArray.split(" ")[0] ?? "0"));
    expect(arcs.reduce((sum, value) => sum + value, 0)).toBeCloseTo(CIRC);
  });

  it("占比按总量归一", () => {
    const segments = ringSegments([1, 3], CIRC);
    expect(segments[0]!.share).toBeCloseTo(0.25);
    expect(segments[1]!.share).toBeCloseTo(0.75);
  });

  it("非正数不参与分割,全零时不给图", () => {
    expect(ringSegments([10, 0, -5], CIRC)).toHaveLength(1);
    expect(ringSegments([0, 0], CIRC)).toEqual([]);
    expect(ringSegments([], CIRC)).toEqual([]);
  });
});

describe("sparkline", () => {
  it("两点以上按等距铺开,y 落在 [pad, height-pad]", () => {
    const line = sparkline([0, 50, 100], 200, 40, 4);
    const pairs = line.points.split(" ").map((entry) => entry.split(",").map(Number));
    expect(pairs).toHaveLength(3);
    expect(pairs[0]?.[0]).toBe(0);
    expect(pairs[2]?.[0]).toBeCloseTo(200);
    // 最大值贴顶(40-4=36 起算的是 y 向下),最小值贴底(4)。
    expect(pairs[0]?.[1]).toBeCloseTo(36);
    expect(pairs[2]?.[1]).toBeCloseTo(4);
    expect(line.min).toBe(0);
    expect(line.max).toBe(100);
    expect(line.flat).toBe(false);
  });

  it("极差为 0 时压在中线而不是除零", () => {
    const line = sparkline([7, 7, 7], 100, 20);
    expect(line.flat).toBe(true);
    expect(line.points.split(" ")).toHaveLength(3);
    const ys = line.points.split(" ").map((entry) => Number(entry.split(",")[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeCloseTo(10);
  });

  it("少于两点画不出趋势", () => {
    expect(sparkline([1], 100, 20).points).toBe("");
    expect(sparkline([], 100, 20).points).toBe("");
  });
});
