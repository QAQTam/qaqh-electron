/**
 * 「本机」面板:壳进程 + 界面进程组 + daemon + 页面自身,各占多少一次看全。
 *
 * 四路数据各自的脾气不一样,所以分开兜,任何一路失败都只少它那一行:
 *  - `host_memory` 是壳命令,旧壳/纯浏览器里没有 → 少一行。
 *  - `host_process_group` 走 WebView2 的 `GetProcessInfos` + psapi 逐进程读;
 *    非 Windows 返回 `unsupported`,由 `excluded` 说明口径。
 *  - daemon 那一行走 `diagnostics.memory.snapshot`,要求 admin scope;这里只读
 *    `process` 字段,**不 start**——采集开关仍归「内存」面板管。
 *  - 页面数字来自 `performance.memory`(只有 Chromium/WebView2 给)+ DOM 规模。
 */
import { For, Show, createSignal, onCleanup, type Component } from "solid-js";
import { formatBytes, formatClock, errorTextOf, isScopeError, loadMemorySnapshot, MEMORY_POLL_MS } from "../../lib/memwatch";
import { captureRendererMemory, loadHostMemory, loadProcessGroup, summarizeMachineMemory, type MachineMemoryView } from "../../lib/hostmem";

export const MachinePanel: Component = () => {
  const [view, setView] = createSignal<MachineMemoryView | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [at, setAt] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  let stopped = false;
  let timer = 0;

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
      daemon = (await loadMemorySnapshot(null)).process;
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
                        <td title="psapi 口径是进程全生命周期峰值,不是本次会话">{formatBytes(row().peak)}</td>
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
