/**
 * 「本机」面板:壳进程 + 界面进程组 + daemon + 页面自身,各占多少一次看全。
 *
 * 四路数据各自的脾气不一样,所以分开兜,任何一路失败都只少它那一行:
 *  - `host_memory` 是 Electron 壳命令,旧壳/纯浏览器里没有 → 少一行。
 *  - `host_process_group` 走 Electron `app.getAppMetrics()`,按进程角色聚合;
 *    拿不到成员时由 `excluded` 说明口径。
 *  - daemon 那一行走 `diagnostics.memory.snapshot`,要求 admin scope;这里只读
 *    `process` 字段,**不 start**——采集开关仍归「内存」面板管。
 *  - 页面数字来自 `performance.memory`(Chromium 渲染进程)+ DOM 规模。
 */
import { For, Show, createSignal, onCleanup, type Component } from "solid-js";
import { formatBytes, formatClock, errorTextOf, isScopeError, loadMemorySnapshot, MEMORY_POLL_MS } from "../../lib/memwatch";
import { captureRendererMemory, loadHostMemory, loadProcessGroup, summarizeMachineMemory, type MachineMemoryView } from "../../lib/hostmem";
import { loadGpuStatus, type GpuStatus } from "../../lib/gpu";
import {
  applyStagedUpdate, checkForUpdates, loadStagedStatus, stageUpdate,
  type StagedStatus, type UpdateCheckResult,
} from "../../lib/updater";
import { requireDesktopHost } from "../../lib/desktop-host";

export const MachinePanel: Component = () => {
  const [view, setView] = createSignal<MachineMemoryView | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [at, setAt] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  // GPU 后端在会话期内不会变,探一次就够;失败只少这一块,不影响内存采样。
  const [gpu, setGpu] = createSignal<GpuStatus | null>(null);
  // 组件热更新:检查(plan)/暂存(stage)/应用(apply),见 webui/src/lib/updater.ts。
  const [plan, setPlan] = createSignal<UpdateCheckResult | null>(null);
  const [staged, setStaged] = createSignal<StagedStatus | null>(null);
  const [updateNote, setUpdateNote] = createSignal<string | null>(null);
  const [updateBusy, setUpdateBusy] = createSignal(false);
  let stopped = false;
  let timer = 0;

  void loadGpuStatus().then((value) => {
    if (!stopped) setGpu(value);
  }).catch(() => {});

  // 已暂存的更新跨面板存活,挂载时读一次,有就亮出「应用」。
  void loadStagedStatus().then((value) => {
    if (!stopped && value) setStaged(value);
  }).catch(() => {});

  const tick = async (): Promise<void> => {
    const notes: string[] = [];
    let host = null as Awaited<ReturnType<typeof loadHostMemory>>;
    try {
      host = await loadHostMemory();
    } catch (cause) {
      notes.push(`壳未提供 host_memory(${errorTextOf(cause)})`);
    }
    let daemon = null as Awaited<ReturnType<typeof loadMemorySnapshot>>["process"] | null;
    try {
      daemon = (await loadMemorySnapshot()).process;
    } catch (cause) {
      notes.push(isScopeError(cause) ? "daemon 内存读数要求 admin scope" : `daemon 快照失败(${errorTextOf(cause)})`);
    }
    let group = null as Awaited<ReturnType<typeof loadProcessGroup>>;
    try {
      group = await loadProcessGroup();
    } catch (cause) {
      notes.push(`壳未提供 host_process_group(${errorTextOf(cause)})`);
    }
    if (stopped) return;
    setView(summarizeMachineMemory(host, daemon, captureRendererMemory(), group));
    setAt(Date.now());
    setNote(notes.length > 0 ? notes.join(" · ") : null);
  };

  // 组件体只跑一次,当作挂载钩子用(与 MemoryPanel 同一写法)。
  void tick().then(() => {
    if (stopped) return;
    timer = window.setInterval(() => {
      if (!paused()) void tick();
    }, MEMORY_POLL_MS);
  });

  onCleanup(() => {
    stopped = true;
    window.clearInterval(timer);
  });

  const segment = (label: string, bytes: number | null): string => `${label} ${formatBytes(bytes)}`;

  // ── 组件热更新动作(每步独立兜错,不互相打断) ──
  const runUpdateStep = async (step: () => Promise<void>): Promise<void> => {
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      await step();
    } catch (cause) {
      setUpdateNote(errorTextOf(cause));
    } finally {
      setUpdateBusy(false);
    }
  };
  const doCheck = (): void => {
    void runUpdateStep(async () => {
      const result = await checkForUpdates();
      if (!result) {
        setUpdateNote("纯浏览器环境没有更新链路。");
        return;
      }
      setPlan(result);
      setStaged(null);
    });
  };
  const doStage = (): void => {
    void runUpdateStep(async () => {
      const status = await stageUpdate();
      if (!status) {
        setUpdateNote("纯浏览器环境没有更新链路。");
        return;
      }
      setStaged(status);
      setPlan(null);
    });
  };
  const doApply = (): void => {
    void runUpdateStep(async () => {
      const result = await applyStagedUpdate();
      if (result.policy === "electron") {
        // detached updater 已挂上 --wait-pid,走既有退出流程即可,换文件与重启由 updater 接手。
        setUpdateNote("壳即将退出,更新将在退出后应用并自动重启。");
        requireDesktopHost().requestQuit({ stopDaemon: false, stopActiveWork: false });
        return;
      }
      setStaged(null);
      setUpdateNote("daemon 已换血并重连,壳未重启。");
    });
  };

  return (
    <div class="dev-panel">
      <div class="dev-toolbar">
        <span class={paused() ? "dev-state" : "dev-state is-live"}>{paused() ? "已暂停" : "采样中"}</span>
        <span class="dev-muted">{formatClock(at())}</span>
        <button type="button" class="ghost-mini" onClick={() => setPaused((value) => !value)}>
          {paused() ? "继续" : "暂停"}
        </button>
      </div>

      <Show when={view()}>
        {(current) => (
          <>
            <p class="dev-mem-total">
              <b>{formatBytes(current().totalBytes)}</b>
              <span>合计(已覆盖部分)</span>
            </p>
            <p class="dev-muted">
              {current().rows.map((row) => segment(row.label, row.resident)).join(" · ")}
              <Show when={current().group.length > 0}>
                {" · "}
                {segment("界面进程组", current().group.reduce((sum, row) => sum + (row.resident ?? 0), 0))}
              </Show>
              <Show when={current().renderer != null}>
                {" · "}
                {segment("页面 JS 堆", current().renderer?.usedJsHeapBytes ?? null)}
              </Show>
            </p>
            <Show when={note() != null}>
              <p class="dev-warn">{note()}</p>
            </Show>
          </>
        )}
      </Show>

      <Show when={view()}>
        {(current) => (
          <>
            <h4 class="dev-sub">进程</h4>
            <Show when={current().rows.length > 0} fallback={<p class="dev-muted">两个进程都没读到。</p>}>
              <table class="readonly-table">
                <thead>
                  <tr><th>进程</th><th>resident</th><th>private</th><th>峰值 resident</th><th>来源</th></tr>
                </thead>
                <tbody>
                  <For each={current().rows} keyed={(row) => row.id}>
                    {(row) => (
                      <tr>
                        <td>{row().label}</td>
                        <td>{formatBytes(row().resident)}</td>
                        <td>{formatBytes(row().private)}</td>
                        <td title="进程全生命周期峰值(Linux procfs VmHWM / Windows psapi),不是本次会话峰值">{formatBytes(row().peak)}</td>
                        <td>{row().source}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <h4 class="dev-sub">界面进程组(角色由引擎自报,不靠进程名猜)</h4>
            <Show when={current().group.length > 0} fallback={<p class="dev-muted">没有界面进程组读数。</p>}>
              <table class="readonly-table">
                <thead>
                  <tr><th>角色</th><th>进程数</th><th>resident</th><th>private</th><th>读不到</th></tr>
                </thead>
                <tbody>
                  <For each={current().group} keyed={(row) => row.kind}>
                    {(row) => (
                      <tr>
                        <td>{row().label}</td>
                        <td>{row().count}</td>
                        <td>{formatBytes(row().resident)}</td>
                        <td>{formatBytes(row().private)}</td>
                        <td>{row().failed > 0 ? `${row().failed} 个` : "—"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <h4 class="dev-sub">图形后端</h4>
            <Show when={gpu()} fallback={<p class="dev-muted">壳未提供 GPU 读数(旧壳/纯浏览器)。</p>}>
              {(current) => (
                <>
                  <div class="readonly-grid">
                    <span>合成</span>
                    <b>{current().compositing ?? "—"}</b>
                    <span>软件渲染</span>
                    <b>{current().softwareRendering == null ? "—" : current().softwareRendering ? "是" : "否"}</b>
                    <span>驱动</span>
                    <b>{[current().vendor, current().renderer].filter(Boolean).join(" / ") || "—"}</b>
                  </div>
                  <Show when={current().software === true}>
                    <p class="dev-warn">GPU 落在软件光栅(SwiftShader):每帧都由 CPU 绘制,关动画/去模糊的主题级优化收效有限——先解决硬件加速,再谈视觉降载。</p>
                  </Show>
                  <Show when={current().error != null}>
                    <p class="dev-warn">GPU 读数失败({current().error})。</p>
                  </Show>
                </>
              )}
            </Show>

            <h4 class="dev-sub">组件热更新</h4>
            <div class="dev-toolbar">
              <button type="button" class="ghost-mini" disabled={updateBusy()} onClick={doCheck}>
                检查更新
              </button>
              <Show when={plan() && !plan()!.upToDate}>
                <button type="button" class="ghost-mini" disabled={updateBusy()} onClick={doStage}>
                  暂存
                </button>
              </Show>
              <Show when={staged()}>
                <button type="button" class="ghost-mini" disabled={updateBusy()} onClick={doApply}>
                  应用
                </button>
              </Show>
            </div>
            <Show when={plan()}>
              {(current) => (
                <p class="dev-muted">
                  {current().upToDate
                    ? `已是最新(release ${current().plan.releaseId})`
                    : `release ${current().plan.releaseId}:${current().plan.mode} [${current().plan.artifacts.join(", ")}]`}
                </p>
              )}
            </Show>
            <Show when={staged()}>
              {(current) => (
                <p class="dev-muted">
                  已暂存 {current().operationId}(release {current().releaseId})·
                  {current().restartPolicy === "daemon" ? "应用后仅重启 daemon" : "应用后退出壳并自动重启"}
                </p>
              )}
            </Show>
            <Show when={updateNote() != null}>
              <p class="dev-warn">{updateNote()}</p>
            </Show>

            <h4 class="dev-sub">渲染层</h4>
            <Show when={current().renderer}>
              {(renderer) => (
                <div class="readonly-grid">
                  <span>已用 JS 堆</span>
                  <b>{formatBytes(renderer().usedJsHeapBytes)}</b>
                  <span>已分配 JS 堆</span>
                  <b>{formatBytes(renderer().totalJsHeapBytes)}</b>
                  <span>JS 堆上限</span>
                  <b>{formatBytes(renderer().jsHeapLimitBytes)}</b>
                  <span>主文档元素节点</span>
                  <b>{renderer().domNodes}</b>
                  <span>子框架</span>
                  <b>{renderer().childFrames}</b>
                </div>
              )}
            </Show>

            <Show when={current().excluded.length > 0}>
              <p class="dev-muted">未计入合计:{current().excluded.join("、")}。</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
