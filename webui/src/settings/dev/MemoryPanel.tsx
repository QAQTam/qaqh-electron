/**
 * Daemon 内存探测面板:每秒拉取一次增量快照(`after_sequence`),卸载即停采集。
 */
import { For, Show, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import IconPause from "~icons/lucide/pause";
import IconPlay from "~icons/lucide/play";
import IconStepForward from "~icons/lucide/step-forward";
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

const GROUPS: Array<{ id: ComponentGroup; label: string }> = [
  { id: "ringing", label: "ringing" },
  { id: "agent_registry", label: "agent_registry" },
  { id: "service", label: "service" },
  { id: "transport", label: "transport(mcp)" },
  { id: "workspace", label: "workspace" },
  { id: "other", label: "other" },
];

const PHASE_ROWS = 16;
const shortId = (value: string): string => (value.length > 12 ? value.slice(0, 10) : value);

export const MemoryPanel: Component = () => {
  const [snap, setSnap] = createSignal<MemorySnapshot | null>(null);
  const [phases, setPhases] = createSignal<PhaseSample[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [denied, setDenied] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  let stopped = false;
  let timer = 0;

  const tick = async (): Promise<void> => {
    try {
      const next = await loadMemorySnapshot(phases().at(-1)?.sequence);
      if (stopped) return;
      setPhases((prev) => mergePhaseSamples(prev, next.phases));
      setSnap(next);
      setError(null);
    } catch (cause) {
      if (stopped) return;
      setDenied(isScopeError(cause));
      setError(errorTextOf(cause));
    }
  };

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
        <span class={running() && error() == null && !paused() ? "dev-state is-live" : "dev-state"}>
          {running() ? (error() != null ? "采样失败" : paused() ? "已暂停" : "采样中") : "启动中…"}
        </span>
        <Show when={snap() != null}>
          <span class="dev-muted">
            {formatClock(snap()?.sampled_at_ms ?? null)} · schema v{snap()?.schema_version ?? "?"} · {snap()?.process.source}
          </span>
        </Show>
        <div class="dev-toolbar-right">
          <button type="button" class="dev-btn" onClick={() => setPaused((value) => !value)}>
            <Show when={paused()} fallback={<IconPause />}><IconPlay /></Show>
            <span>{paused() ? "继续" : "暂停"}</span>
          </button>
          <Show when={paused()}>
            <button type="button" class="dev-btn" onClick={() => { void tick(); }}>
              <IconStepForward />
              <span>单步</span>
            </button>
          </Show>
        </div>
      </div>

      <Show when={denied()}>
        <p class="dev-warn">
          内存探测要求 daemon admin scope（403 insufficient_scope）。
        </p>
      </Show>
      <Show when={error() != null && !denied()}>
        <p class="dev-err">{error()}</p>
      </Show>

      <Show when={snap()} fallback={<p class="dev-muted">{error() == null ? "等待第一次快照…" : ""}</p>}>
        {(s) => (
          <>
            <div class="dev-kpi-grid">
              <div class="dev-kpi">
                <span class="dev-kpi-label"><span>Daemon 工作集</span></span>
                <span class="dev-kpi-value">{formatBytes(s().process.resident_bytes)}</span>
                <span class="dev-kpi-sub">峰值 {formatBytes(s().process.peak_resident_bytes)}</span>
              </div>
              <div class="dev-kpi">
                <span class="dev-kpi-label"><span>私有内存</span></span>
                <span class="dev-kpi-value">{formatBytes(s().process.private_bytes)}</span>
                <span class="dev-kpi-sub">采样峰值 {formatBytes(s().peak_sampled_private_bytes)}</span>
              </div>
              <div class="dev-kpi">
                <span class="dev-kpi-label"><span>虚拟内存</span></span>
                <span class="dev-kpi-value">{formatBytes(s().process.virtual_bytes)}</span>
                <span class="dev-kpi-sub">数据源 {s().process.source}</span>
              </div>
              <div class="dev-kpi">
                <span class="dev-kpi-label"><span>常驻 / 跟踪会话</span></span>
                <span class="dev-kpi-value">{s().resident_session_count} / {s().tracked_session_count}</span>
                <span class="dev-kpi-sub">阶段样本 {phases().length} 条</span>
              </div>
            </div>

            <Show when={s().process.error != null}>
              <p class="dev-warn">进程内存读取降级：{s().process.error}</p>
            </Show>
            <Show when={s().phase_gap || s().dropped_phase_samples > 0}>
              <p class="dev-warn">
                phase 环形缓冲已丢弃 {s().dropped_phase_samples} 条（最早序号 {s().oldest_phase_sequence ?? "—"}）。
              </p>
            </Show>

            <Show when={ringSlices().length > 0}>
              <div class="dev-card">
                <div class="dev-card-head">
                  <h4 class="dev-card-title">组件估算占比</h4>
                </div>
                <div class="dev-card-body">
                  <RingChart slices={ringSlices()} caption="组件估算内存占比" />
                </div>
              </div>
            </Show>

            <div class="dev-card">
              <div class="dev-card-head">
                <h4 class="dev-card-title">组件量规</h4>
                <span class="dev-muted">{s().components.length} 项</span>
              </div>
              <Show when={s().components.length > 0} fallback={<div class="dev-card-body"><p class="dev-muted">暂无组件量规上报。</p></div>}>
                <div class="dev-table-wrap">
                  <table class="dev-table">
                    <thead>
                      <tr><th>名称</th><th>组</th><th class="num">条数</th><th class="num">payload</th><th class="num">估算</th></tr>
                    </thead>
                    <tbody>
                      <For each={s().components} keyed={(item) => item.name}>
                        {(item) => (
                          <tr>
                            <td class="mono">{item().name}</td>
                            <td><span class="dev-pill">{item().group}</span></td>
                            <td class="num">{item().item_count}</td>
                            <td class="num">{formatBytes(item().payload_bytes)}</td>
                            <td class="num">{formatBytes(item().heap_estimate_bytes)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>

            <div class="dev-card">
              <div class="dev-card-head">
                <h4 class="dev-card-title">会话量规</h4>
                <span class="dev-muted">{s().sessions.length} 条</span>
              </div>
              <Show when={s().sessions.length > 0} fallback={<div class="dev-card-body"><p class="dev-muted">暂无会话量规。</p></div>}>
                <div class="dev-table-wrap">
                  <table class="dev-table">
                    <thead>
                      <tr><th>会话</th><th>常驻</th><th class="num">消息</th><th class="num">回合</th><th class="num">估算合计</th><th class="num">上下文</th><th>最近阶段</th></tr>
                    </thead>
                    <tbody>
                      <For each={s().sessions} keyed={(item) => item.session_id}>
                        {(item) => (
                          <tr>
                            <td class="mono" title={item().session_id}>{shortId(item().session_id)}</td>
                            <td><span class={item().resident ? "dev-pill is-ok" : "dev-pill"}>{item().resident ? "常驻" : "冷"}</span></td>
                            <td class="num">{item().message_count}</td>
                            <td class="num">{item().turn_count}</td>
                            <td class="num">{formatBytes(sessionEstimateBytes(item()))}</td>
                            <td class="num">{formatBytes(item().context_payload_bytes)}</td>
                            <td class="mono">{item().last_phase}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>

            <div class="dev-card">
              <div class="dev-card-head">
                <h4 class="dev-card-title">阶段趋势</h4>
                <span class="dev-muted">缓冲 {phases().length} 条</span>
              </div>
              <div class="dev-card-body">
                <Sparkline values={phaseTrend()} label="resident 趋势" />
              </div>
              <Show when={recentPhases().length > 0}>
                <div class="dev-table-wrap">
                  <table class="dev-table">
                    <thead>
                      <tr><th class="num">#</th><th>时间</th><th>阶段</th><th class="num">工作集</th><th class="num">store 估算</th></tr>
                    </thead>
                    <tbody>
                      <For each={recentPhases()} keyed={(row) => row.sequence}>
                        {(row) => (
                          <tr>
                            <td class="num">{row().sequence}</td>
                            <td class="mono">{formatClock(row().at_ms)}</td>
                            <td class="mono">{row().phase}</td>
                            <td class="num">{formatBytes(row().process.resident_bytes)}</td>
                            <td class="num">{formatBytes(row().store_heap_estimate_bytes)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};
