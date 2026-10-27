/**
 * 内存探测面板:每秒向 daemon 取一次增量快照(`after_sequence` 游标),离开面板即
 * 停止采集。
 *
 * 为什么必须成对 start/stop:采集是 opt-in 的,`start` 之后 daemon 每秒采样一次
 * 并常驻环形缓冲(`service.rs:383`、`memwatch/lib.rs`)。控制台开着让它跑是应有
 * 之义,关掉以后还继续跑就是拿用户机器的常驻开销换一次调试。
 */
import { For, Show, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import {
  MEMORY_POLL_MS,
  errorTextOf,
  formatBytes,
  formatClock,
  isScopeError,
  loadMemorySnapshot,
  mergePhaseSamples,
  sessionEstimateBytes,
  startMemoryProbe,
  stopMemoryProbe,
  type ComponentGroup,
  type MemorySnapshot,
  type PhaseSample,
} from "../../lib/memwatch";
import { RingChart, Sparkline, type RingSlice } from "./Charts";

/** 与后端 `ComponentGroup` 封闭枚举同名;顺序即环图槽位顺序(见 Charts 的着色)。 */
const GROUPS: Array<{ id: ComponentGroup; label: string }> = [
  { id: "ringing", label: "ringing" },
  { id: "agent_registry", label: "agent_registry" },
  { id: "service", label: "service" },
  { id: "transport", label: "transport(mcp/lsp)" },
  { id: "workspace", label: "workspace" },
  { id: "other", label: "other" },
];

/** 表格里只展开最近若干条 phase;全量趋势交给 sparkline。 */
const PHASE_ROWS = 16;
const shortId = (value: string): string => (value.length > 12 ? value.slice(0, 10) : value);

export const MemoryPanel: Component = () => {
  const [snap, setSnap] = createSignal<MemorySnapshot | null>(null);
  const [phases, setPhases] = createSignal<PhaseSample[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [denied, setDenied] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  /** 已消费到的 phase 游标;`null` = 还没取过,下一次拿全量有界环。 */
  let cursor: number | null = null;
  let stopped = false;
  let timer = 0;

  const tick = async (): Promise<void> => {
    try {
      const next = await loadMemorySnapshot(cursor);
      if (stopped) return;
      cursor = next.latest_phase_sequence ?? cursor;
      setPhases((prev) => mergePhaseSamples(prev, next.phases));
      setSnap(next);
      setError(null);
    } catch (cause) {
      if (stopped) return;
      setDenied(isScopeError(cause));
      setError(errorTextOf(cause));
    }
  };

  // 组件体每个实例只跑一次,这里就当作挂载钩子用(rc.13 起 `onMount` 不再是
  // solid-js 的导出,而 onCleanup 注册在组件作用域是合法的)。
  void (async () => {
    try {
      await startMemoryProbe();
      if (stopped) return;
      setRunning(true);
      await tick();
      if (stopped) return;
      timer = window.setInterval(() => {
        if (!paused()) void tick();
      }, MEMORY_POLL_MS);
    } catch (cause) {
      if (stopped) return;
      setDenied(isScopeError(cause));
      setError(errorTextOf(cause));
    }
  })();

  onCleanup(() => {
    stopped = true;
    window.clearInterval(timer);
    // 卸载即停表。stop 失败不值得在 UI 上留痕:下一次进面板的 start 会重新开关采集。
    void stopMemoryProbe().catch(() => {});
  });

  const ringSlices = createMemo<RingSlice[]>(() => {
    const snapshot = snap();
    if (snapshot == null) return [];
    const totals = new Map<ComponentGroup, number>();
    for (const item of snapshot.components) {
      const bytes = item.heap_estimate_bytes ?? 0;
      if (bytes <= 0) continue;
      totals.set(item.group, (totals.get(item.group) ?? 0) + bytes);
    }
    return GROUPS.filter((group) => (totals.get(group.id) ?? 0) > 0).map((group) => ({
      key: group.id,
      label: group.label,
      value: totals.get(group.id) ?? 0,
    }));
  });

  const phaseTrend = createMemo(() => phases().map((row) => row.process.resident_bytes ?? 0));
  const recentPhases = createMemo(() => phases().slice(-PHASE_ROWS).reverse());

  return (
    <div class="dev-panel">
      <div class="dev-toolbar">
        <span class={running() && error() == null ? "dev-state is-live" : "dev-state"}>
          {running() ? (error() != null ? "采样失败" : paused() ? "已暂停" : "采样中") : "启动中…"}
        </span>
        <Show when={snap() != null}>
          <span class="dev-muted">采样时刻 {formatClock(snap()?.sampled_at_ms ?? null)} · schema v{snap()?.schema_version ?? "?"}</span>
        </Show>
        <button type="button" class="ghost-mini" onClick={() => setPaused((value) => !value)}>
          {paused() ? "继续" : "暂停"}
        </button>
        <Show when={paused()}>
          <button type="button" class="ghost-mini" onClick={() => { void tick(); }}>单步</button>
        </Show>
      </div>

      <Show when={denied()}>
        <p class="dev-warn">
          内存探测要求 daemon 的 admin scope:本地 sidecar 用宿主 admin token 天然满足,
          连远程 daemon 且凭据是低权限设备令牌时这三个方法会被拒(403 insufficient_scope)。
        </p>
      </Show>
      <Show when={error() != null && !denied()}>
        <p class="dev-err">{error()}</p>
      </Show>

      <Show when={snap()} fallback={<p class="dev-muted">{error() == null ? "等待第一次快照…" : ""}</p>}>
        {(s) => (
          <>
            <div class="readonly-grid">
              <span>resident</span>
              <b>{formatBytes(s().process.resident_bytes)}</b>
              <span>private</span>
              <b>{formatBytes(s().process.private_bytes)}</b>
              <span>virtual</span>
              <b>{formatBytes(s().process.virtual_bytes)}</b>
              <span>峰值 resident</span>
              <b>{formatBytes(s().process.peak_resident_bytes)}</b>
              <span>采样峰值 private</span>
              <b>{formatBytes(s().peak_sampled_private_bytes)}</b>
              <span>会话(常驻/跟踪)</span>
              <b>{s().resident_session_count} / {s().tracked_session_count}</b>
              <span>数据来源</span>
              <b>{s().process.source}</b>
            </div>
            <Show when={s().process.error != null}>
              <p class="dev-warn">进程内存读取降级:{s().process.error}</p>
            </Show>
            <Show when={s().phase_gap || s().dropped_phase_samples > 0}>
              <p class="dev-warn">
                phase 环形缓冲已丢弃 {s().dropped_phase_samples} 条(现存最早序号 {s().oldest_phase_sequence ?? "—"}),下方趋势不连续。
              </p>
            </Show>
            <Show when={s().dropped_session_gauges > 0}>
              <p class="dev-warn">会话量规超出上限,已丢弃 {s().dropped_session_gauges} 条。</p>
            </Show>

            <Show when={ringSlices().length > 0}>
              <RingChart slices={ringSlices()} caption="组件估算内存占比" />
            </Show>

            <h4 class="dev-sub">组件(估算,非分配器实时值)</h4>
            <Show when={s().components.length > 0} fallback={<p class="dev-muted">当前没有组件量规上报。</p>}>
              <table class="readonly-table">
                <thead>
                  <tr><th>名称</th><th>组</th><th>条数</th><th>payload</th><th>估算</th></tr>
                </thead>
                <tbody>
                  <For each={s().components} keyed={(item) => item.name}>
                    {(item) => (
                      <tr>
                        <td>{item().name}</td>
                        <td>{item().group}</td>
                        <td>{item().item_count}</td>
                        <td>{formatBytes(item().payload_bytes)}</td>
                        <td>{formatBytes(item().heap_estimate_bytes)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <h4 class="dev-sub">会话(按估算合计降序,与 daemon 同一排序口径)</h4>
            <Show when={s().sessions.length > 0} fallback={<p class="dev-muted">还没有会话量规(先跑一轮对话)。</p>}>
              <table class="readonly-table">
                <thead>
                  <tr><th>会话</th><th>常驻</th><th>消息</th><th>回合</th><th>估算合计</th><th>上下文</th><th>最近阶段</th></tr>
                </thead>
                <tbody>
                  <For each={s().sessions} keyed={(item) => item.session_id}>
                    {(item) => (
                      <tr>
                        <td title={item().session_id}>{shortId(item().session_id)}</td>
                        <td>{item().resident ? "是" : "否"}</td>
                        <td>{item().message_count}</td>
                        <td>{item().turn_count}</td>
                        <td>{formatBytes(sessionEstimateBytes(item()))}</td>
                        <td>{formatBytes(item().context_payload_bytes)}</td>
                        <td>{item().last_phase}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <h4 class="dev-sub">阶段样本(resident 趋势,缓冲内 {phases().length} 条)</h4>
            <Sparkline values={phaseTrend()} label="resident 趋势" />
            <Show when={recentPhases().length > 0} fallback={<p class="dev-muted">还没有阶段样本。</p>}>
              <table class="readonly-table">
                <thead>
                  <tr><th>#</th><th>时间</th><th>阶段</th><th>resident</th><th>store 估算</th></tr>
                </thead>
                <tbody>
                  <For each={recentPhases()} keyed={(row) => row.sequence}>
                    {(row) => (
                      <tr>
                        <td>{row().sequence}</td>
                        <td>{formatClock(row().at_ms)}</td>
                        <td>{row().phase}</td>
                        <td>{formatBytes(row().process.resident_bytes)}</td>
                        <td>{formatBytes(row().store_heap_estimate_bytes)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
