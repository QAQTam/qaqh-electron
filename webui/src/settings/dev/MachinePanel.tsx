/**
 * 「本机」遥测面板:总览 KPI + 内存占比条 + 进程/子进程组(含 CPU/唤醒率) + GPU 特性 + 渲染层。
 */
import { For, Show, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import IconCopy from "~icons/lucide/copy";
import IconPause from "~icons/lucide/pause";
import IconPlay from "~icons/lucide/play";
import {
  formatBytes,
  formatClock,
  errorTextOf,
  isScopeError,
  loadMemorySnapshot,
  MEMORY_POLL_MS,
} from "../../lib/memwatch";
import {
  captureRendererMemory,
  loadHostMemory,
  loadHostTelemetry,
  loadProcessGroup,
  stopHostTelemetry,
  summarizeMachineMemory,
  type HostTelemetry,
  type MachineMemoryView,
} from "../../lib/hostmem";
import { loadGpuStatus, type GpuStatus } from "../../lib/gpu";

const BAR_COLORS = ["#18181b", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#9ca3af"];

const fmtPct = (value: number | null): string => (value == null ? "—" : `${value.toFixed(1)}%`);
const fmtNum = (value: number | null): string => (value == null ? "—" : String(Math.round(value)));
const fmtMs = (value: number | null): string => (value == null ? "—" : `${value.toFixed(1)} ms`);

const featureTone = (value: string | null): string => {
  if (!value) return "dev-pill";
  const lower = value.toLowerCase();
  if (lower.startsWith("enabled")) return "dev-pill is-ok";
  if (lower.includes("software") || lower.startsWith("disabled")) return "dev-pill is-warn";
  return "dev-pill";
};

export const MachinePanel: Component = () => {
  const [view, setView] = createSignal<MachineMemoryView | null>(null);
  const [telemetry, setTelemetry] = createSignal<HostTelemetry | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [at, setAt] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [gpu, setGpu] = createSignal<GpuStatus | null>(null);
  let stopped = false;
  let timer = 0;

  void loadGpuStatus().then((value) => {
    if (!stopped) setGpu(value);
  }).catch(() => {});

  const tick = async (): Promise<void> => {
    const notes: string[] = [];
    const [hostRes, daemonRes, groupRes, telRes] = await Promise.allSettled([
      loadHostMemory(),
      loadMemorySnapshot(),
      loadProcessGroup(),
      loadHostTelemetry(),
    ]);
    const host = hostRes.status === "fulfilled" ? hostRes.value : (notes.push(`host_memory: ${errorTextOf(hostRes.reason)}`), null);
    const daemon = daemonRes.status === "fulfilled"
      ? daemonRes.value.process
      : (notes.push(isScopeError(daemonRes.reason) ? "daemon 内存需要 admin scope" : `daemon: ${errorTextOf(daemonRes.reason)}`), null);
    const group = groupRes.status === "fulfilled" ? groupRes.value : (notes.push(`host_process_group: ${errorTextOf(groupRes.reason)}`), null);
    const tel = telRes.status === "fulfilled" ? telRes.value : null;
    if (stopped) return;
    setView(summarizeMachineMemory(host, daemon, captureRendererMemory(), group));
    setTelemetry(tel);
    setAt(Date.now());
    setNote(notes.length > 0 ? notes.join(" · ") : null);
  };

  void tick().then(() => {
    if (stopped) return;
    timer = window.setInterval(() => {
      if (!paused()) void tick();
    }, MEMORY_POLL_MS);
  });

  onCleanup(() => {
    stopped = true;
    window.clearInterval(timer);
    void stopHostTelemetry();
  });

  const barSegments = createMemo(() => {
    const current = view();
    if (!current || !current.totalBytes || current.totalBytes <= 0) return [];
    const items: Array<{ label: string; bytes: number }> = [];
    for (const row of current.rows) {
      if (row.resident && row.resident > 0) items.push({ label: row.label, bytes: row.resident });
    }
    for (const g of current.group) {
      if (g.kind === "zygote" || g.kind === "sandbox_helper") continue;
      if (g.resident && g.resident > 0) items.push({ label: g.label, bytes: g.resident });
    }
    const total = items.reduce((s, x) => s + x.bytes, 0) || 1;
    return items.map((item, idx) => ({
      ...item,
      pct: Math.max(1.5, (item.bytes / total) * 100),
      color: BAR_COLORS[idx % BAR_COLORS.length],
    }));
  });

  const sysMemShare = createMemo(() => {
    const total = view()?.totalBytes;
    const sysTotal = telemetry()?.systemMemory.totalBytes;
    if (!total || !sysTotal) return null;
    return `${((total / sysTotal) * 100).toFixed(1)}% / ${formatBytes(sysTotal)}`;
  });

  const copySnapshot = async (): Promise<void> => {
    const payload = { at: new Date(at()).toISOString(), view: view(), telemetry: telemetry(), gpu: gpu() };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return (
    <div class="dev-panel">
      <div class="dev-toolbar">
        <span class={paused() ? "dev-state" : "dev-state is-live"}>{paused() ? "已暂停" : "采样中"}</span>
        <span class="dev-muted">{formatClock(at())}</span>
        <div class="dev-toolbar-right">
          <button type="button" class="dev-btn" onClick={() => setPaused((value) => !value)}>
            <Show when={paused()} fallback={<IconPause />}><IconPlay /></Show>
            <span>{paused() ? "继续" : "暂停"}</span>
          </button>
          <button type="button" class="dev-btn" onClick={() => { void copySnapshot(); }}>
            <IconCopy />
            <span>{copied() ? "已复制" : "导出快照"}</span>
          </button>
        </div>
      </div>

      <Show when={note() != null}>
        <p class="dev-warn">{note()}</p>
      </Show>

      <Show when={view()}>
        {(current) => (
          <>
            {/* 顶部 4 格 KPI 概览 */}
            <div class="dev-kpi-grid">
              <div class="dev-kpi">
                <span class="dev-kpi-label">
                  <span>应用总内存</span>
                  <Show when={telemetry()}>
                    {(t) => <span>可用 {formatBytes(t().systemMemory.freeBytes)}</span>}
                  </Show>
                </span>
                <span class="dev-kpi-value">{formatBytes(current().totalBytes)}</span>
                <span class="dev-kpi-sub">{sysMemShare() ?? "已覆盖进程工作集"}</span>
              </div>

              <div class="dev-kpi">
                <span class="dev-kpi-label">
                  <span>CPU / 唤醒</span>
                  <Show when={telemetry()}>
                    {(t) => <span>{t().cpuCores} 核</span>}
                  </Show>
                </span>
                <span class="dev-kpi-value">{fmtPct(current().totalCpuPercent)}</span>
                <span class="dev-kpi-sub">
                  空闲唤醒 {fmtNum(current().totalIdleWakeups)}/s
                </span>
              </div>

              <div class="dev-kpi">
                <span class="dev-kpi-label">
                  <span>图形加速</span>
                  <Show when={gpu()}>
                    {(g) => (
                      <span class={g().software === false ? "dev-pill is-ok" : g().software === true ? "dev-pill is-warn" : "dev-pill"}>
                        {g().software === false ? "硬件加速" : g().software === true ? "软件光栅" : "未知"}
                      </span>
                    )}
                  </Show>
                </span>
                <span class="dev-kpi-value">{gpu()?.vendor ?? "—"}</span>
                <span class="dev-kpi-sub" title={gpu()?.renderer ?? undefined}>
                  {gpu()?.renderer ?? gpu()?.compositing ?? "无 GPU 信息"}
                </span>
              </div>

              <div class="dev-kpi">
                <span class="dev-kpi-label">
                  <span>主进程事件循环 P95</span>
                  <span>DOM {current().renderer?.domNodes ?? "—"}</span>
                </span>
                <span class="dev-kpi-value">{fmtMs(telemetry()?.eventLoop.p95Ms ?? null)}</span>
                <span class="dev-kpi-sub">
                  JS 堆 {formatBytes(current().renderer?.usedJsHeapBytes ?? null)} / {formatBytes(current().renderer?.totalJsHeapBytes ?? null)}
                </span>
              </div>
            </div>

            {/* 内存占比堆叠条 */}
            <Show when={barSegments().length > 0}>
              <div class="dev-card">
                <div class="dev-card-body dev-bar-wrap">
                  <div class="dev-bar" role="img" aria-label="内存分布">
                    <For each={barSegments()}>
                      {(seg) => (
                        <div
                          class="dev-bar-seg"
                          style={{ width: `${seg.pct}%`, background: seg.color }}
                          title={`${seg.label}: ${formatBytes(seg.bytes)}`}
                        />
                      )}
                    </For>
                  </div>
                  <div class="dev-bar-legend">
                    <For each={barSegments()}>
                      {(seg) => (
                        <span class="dev-bar-item">
                          <i class="dev-bar-dot" style={{ background: seg.color }} />
                          <span>{seg.label}</span>
                          <b>{formatBytes(seg.bytes)}</b>
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </Show>

            {/* 核心进程 */}
            <div class="dev-card">
              <div class="dev-card-head">
                <h4 class="dev-card-title">核心进程</h4>
                <span class="dev-muted">{current().rows.length} 个</span>
              </div>
              <Show when={current().rows.length > 0} fallback={<div class="dev-card-body"><p class="dev-muted">暂无进程读数。</p></div>}>
                <div class="dev-table-wrap">
                  <table class="dev-table">
                    <thead>
                      <tr>
                        <th>进程</th>
                        <th class="num">PID</th>
                        <th class="num">工作集</th>
                        <th class="num">私有内存</th>
                        <th class="num">峰值工作集</th>
                        <th class="num">CPU</th>
                        <th class="num">唤醒/s</th>
                        <th>来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={current().rows} keyed={(row) => row.id}>
                        {(row) => (
                          <tr>
                            <td>{row().label}</td>
                            <td class="num">{row().pid ?? "—"}</td>
                            <td class="num">{formatBytes(row().resident)}</td>
                            <td class="num">{formatBytes(row().private)}</td>
                            <td class="num">{formatBytes(row().peak)}</td>
                            <td class="num">{fmtPct(row().cpuPercent)}</td>
                            <td class="num">{fmtNum(row().idleWakeups)}</td>
                            <td class="mono">{row().source}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>

            {/* 界面子进程组 */}
            <div class="dev-card">
              <div class="dev-card-head">
                <h4 class="dev-card-title">Chromium 进程组</h4>
                <span class="dev-muted">{current().group.reduce((s, r) => s + r.count, 0)} 个子进程</span>
              </div>
              <Show when={current().group.length > 0} fallback={<div class="dev-card-body"><p class="dev-muted">暂无子进程组读数。</p></div>}>
                <div class="dev-table-wrap">
                  <table class="dev-table">
                    <thead>
                      <tr>
                        <th>角色</th>
                        <th class="num">数量</th>
                        <th class="num">工作集</th>
                        <th class="num">私有内存</th>
                        <th class="num">峰值</th>
                        <th class="num">CPU</th>
                        <th class="num">唤醒/s</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={current().group} keyed={(row) => row.kind}>
                        {(row) => (
                          <tr>
                            <td title={row().pids.length > 0 ? `PID: ${row().pids.join(", ")}` : undefined}>{row().label}</td>
                            <td class="num">{row().count}</td>
                            <td class="num">{formatBytes(row().resident)}</td>
                            <td class="num">{formatBytes(row().private)}</td>
                            <td class="num">{formatBytes(row().peak)}</td>
                            <td class="num">{fmtPct(row().cpuPercent)}</td>
                            <td class="num">{fmtNum(row().idleWakeups)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>

            {/* 图形后端与渲染层 */}
            <div class="dev-card">
              <div class="dev-card-head">
                <h4 class="dev-card-title">图形后端与渲染层</h4>
                <Show when={gpu()?.driverVersion}>
                  {(ver) => <span class="dev-muted">驱动 {ver()}</span>}
                </Show>
              </div>
              <div class="dev-card-body">
                <Show when={gpu()?.software === true}>
                  <p class="dev-warn" style={{ "margin-bottom": "10px" }}>
                    当前处于软件光栅（SwiftShader），每帧均由 CPU 绘制。建议排查显卡驱动或关闭「禁用 GPU 加速」。
                  </p>
                </Show>
                <div class="dev-kv-grid">
                  <div class="dev-kv">
                    <span>合成器</span>
                    <b class={featureTone(gpu()?.compositing ?? null)}>{gpu()?.compositing ?? "—"}</b>
                  </div>
                  <div class="dev-kv">
                    <span>光栅化</span>
                    <b class={featureTone(gpu()?.rasterization ?? null)}>{gpu()?.rasterization ?? "—"}</b>
                  </div>
                  <div class="dev-kv">
                    <span>2D Canvas</span>
                    <b class={featureTone(gpu()?.canvas2d ?? null)}>{gpu()?.canvas2d ?? "—"}</b>
                  </div>
                  <div class="dev-kv">
                    <span>WebGL</span>
                    <b class={featureTone(gpu()?.webgl ?? null)}>{gpu()?.webgl ?? "—"}</b>
                  </div>
                  <div class="dev-kv">
                    <span>视频解码</span>
                    <b class={featureTone(gpu()?.videoDecode ?? null)}>{gpu()?.videoDecode ?? "—"}</b>
                  </div>
                  <div class="dev-kv">
                    <span>JS 堆 (已用 / 上限)</span>
                    <b>{formatBytes(current().renderer?.usedJsHeapBytes ?? null)} / {formatBytes(current().renderer?.jsHeapLimitBytes ?? null)}</b>
                  </div>
                  <Show when={current().renderer?.blinkAllocatedBytes != null}>
                    <div class="dev-kv">
                      <span>Blink 引擎内存</span>
                      <b>{formatBytes(current().renderer?.blinkAllocatedBytes ?? null)} / {formatBytes(current().renderer?.blinkTotalBytes ?? null)}</b>
                    </div>
                  </Show>
                  <div class="dev-kv">
                    <span>DOM 节点 / 子框架</span>
                    <b>{current().renderer?.domNodes ?? "—"} / {current().renderer?.childFrames ?? "—"}</b>
                  </div>
                  <Show when={telemetry()}>
                    {(t) => (
                      <div class="dev-kv">
                        <span>Event Loop (P50 / Max)</span>
                        <b>{fmtMs(t().eventLoop.p50Ms)} / {fmtMs(t().eventLoop.maxMs)}</b>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </div>

            <Show when={current().excluded.length > 0}>
              <p class="dev-muted">未计入总内存：{current().excluded.join(" · ")}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
