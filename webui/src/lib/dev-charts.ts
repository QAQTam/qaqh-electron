/**
 * 手搓图表的数学部分(纯函数,组件在 `settings/dev/Charts.tsx`)。
 *
 * 两个仓库都没有画数据的 SVG/canvas 前例,也不打算为此加图表依赖——所以这里只做
 * 两段小数学:环形图用 `stroke-dasharray` 摆钟面弧(避开弧路径的 start/end 角
 * 与 sweep-flag 那一串易错的东西),趋势线用 `<polyline>` 的等距采样点。
 */

export interface RingSegment {
  /** `stroke-dasharray` 值:本段弧长 + 剩余周长。 */
  dashArray: string;
  /** `stroke-dashoffset`:把本段旋到累计位置(顺时针,从 12 点起)。 */
  dashOffset: number;
  value: number;
  /** 占总量比例,0..1;总量为 0 时为 0。 */
  share: number;
}

/**
 * 非正值(缺测、空组件)不参与分割——否则一段 0 字节的弧会在图里占出一个看不见的
 * 扇区,图例还对得上、视觉上却少了一块。
 */
export function ringSegments(values: readonly number[], circumference: number): RingSegment[] {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || circumference <= 0) return [];
  let swept = 0;
  return positive.map((value) => {
    const share = value / total;
    const arc = share * circumference;
    // 首段偏移写成 0 而不是 -0:`-0` 会流进 SVG 属性,单测里 `Object.is(-0, 0)` 也是两回事。
    const segment: RingSegment = {
      dashArray: `${arc.toFixed(3)} ${(circumference - arc).toFixed(3)}`,
      dashOffset: swept === 0 ? 0 : -swept,
      value,
      share,
    };
    swept += arc;
    return segment;
  });
}

export interface Sparkline {
  /** `<polyline points>` 值;少于 2 个点时为空串(一条线画不出趋势)。 */
  points: string;
  min: number;
  max: number;
  /** 是否被裁过:极差为 0 时全部点压在同一高度,得给个可视中线而不是报错。 */
  flat: boolean;
}

/**
 * 等 x 间隔、y 按 [min,max] 归一到 [height-pad, pad](SVG y 轴向下,所以取反)。
 */
export function sparkline(values: readonly number[], width: number, height: number, pad = 3): Sparkline {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.length > 0 ? Math.min(...finite) : 0;
  const max = finite.length > 0 ? Math.max(...finite) : 0;
  if (finite.length < 2 || width <= 0 || height <= 2 * pad) {
    return { points: "", min, max, flat: true };
  }
  const flat = max === min;
  const span = max - min;
  const stepX = width / (finite.length - 1);
  const midY = height / 2;
  const toY = (value: number): number => (flat ? midY : height - pad - ((value - min) / span) * (height - 2 * pad));
  const points = finite.map((value, index) => `${(index * stepX).toFixed(2)},${toY(value).toFixed(2)}`).join(" ");
  return { points, min, max, flat };
}

/** 图例里的百分比,整数即可(扇区大小已给出量级)。 */
export const formatShare = (share: number): string => `${Math.round(share * 100)}%`;
