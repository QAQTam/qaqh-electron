/**
 * 调试台用的两个图:环形占比图 + 趋势线。都不加依赖,数学在 `lib/dev-charts.ts`
 * (纯函数、可单测),这里只摆 SVG。
 *
 * 环图用 `stroke-dasharray` 而不是扇形 path:周长固定、每段只算弧长与偏移,不会
 * 出现 sweep-flag / large-arc 那类一端写错就整圈翻过来的坑。
 */
import { For, Show, createMemo, type Component } from "solid-js";
import { ringSegments, sparkline } from "../../lib/dev-charts";

type RingRow = RingSlice & { dashArray: string; dashOffset: number; share: number; slot: number };

export interface RingSlice {
  key: string;
  label: string;
  /** 字节量;非正数不参与分割(dev-charts 里过滤)。 */
  value: number;
}

const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** 与后端 ComponentGroup 的封闭枚举同宽(6 组);槽位只按顺序着色。 */
const SLOT_COUNT = 6;

export const RingChart: Component<{ slices: RingSlice[]; caption?: string }> = (props) => {
  const rows = createMemo((): RingRow[] => {
    const live = props.slices.filter((slice) => slice.value > 0);
    const segments = ringSegments(live.map((slice) => slice.value), RING_CIRCUMFERENCE);
    // 两侧同源同序(dev-charts 只过滤非正数),按下标配对即可,不引入索引断言。
    return live.reduce<RingRow[]>((acc, slice, index) => {
      const segment = segments[index];
      if (segment != null) acc.push({ ...slice, ...segment, slot: index % SLOT_COUNT });
      return acc;
    }, []);
  });
  return (
    <div class="dev-ring-wrap">
      <svg class="dev-ring" viewBox="0 0 100 100" role="img" aria-label={props.caption ?? "占比"}>
        <circle class="dev-ring-track" cx="50" cy="50" r={RING_RADIUS} />
        <For each={rows()} keyed={(row) => row.key}>
          {(row) => (
            <circle
              class={`dev-ring-seg dev-ring-s${row().slot}`}
              cx="50"
              cy="50"
              r={RING_RADIUS}
              transform={`rotate(-90 50 50)`}
              stroke-dasharray={row().dashArray}
              stroke-dashoffset={row().dashOffset}
            />
          )}
        </For>
      </svg>
      <ul class="dev-ring-legend">
        <For each={rows()} keyed={(row) => row.key}>
          {(row) => (
            <li>
              <i class={`dev-swatch dev-ring-s${row().slot}`} />
              <span class="dev-ring-label">{row().label}</span>
              <b>{Math.round(row().share * 100)}%</b>
            </li>
          )}
        </For>
        <Show when={rows().length === 0}>
          <li class="dev-ring-empty">没有可比量的数据</li>
        </Show>
      </ul>
    </div>
  );
};

export const Sparkline: Component<{ values: number[]; width?: number; height?: number; label?: string }> = (props) => {
  const line = createMemo(() =>
    sparkline(props.values, props.width ?? 260, props.height ?? 44),
  );
  return (
    <div class="dev-spark">
      <svg class="dev-spark-svg" viewBox={`0 0 ${props.width ?? 260} ${props.height ?? 44}`} preserveAspectRatio="none" role="img" aria-label={props.label ?? "趋势"}>
        <Show when={line().points !== ""}>
          <polyline class="dev-spark-line" points={line().points} />
        </Show>
      </svg>
      <Show when={line().points === ""}>
        <span class="dev-spark-empty">采样不足</span>
      </Show>
    </div>
  );
};
