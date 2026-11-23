/**
 * 宿主面面板:运行时环境概览 + 直连 daemon 原始查询(带耗时与一键复制)。
 */
import { For, Show, createSignal, type Component } from "solid-js";
import IconCopy from "~icons/lucide/copy";
import IconFolderOpen from "~icons/lucide/folder-open";
import { isDesktopRuntime, transport } from "../../lib/transport";
import { loadHostRuntimeInfo, openHostLogs, type HostRuntimeInfo } from "../../lib/hostmem";
import { errorTextOf, isScopeError, loadMemorySnapshot } from "../../lib/memwatch";

type Call = { id: string; label: string; hint: string; run: () => Promise<unknown> };

const CALLS: Call[] = [
  { id: "daemon.version", label: "daemon.version", hint: "sidecar 自身版本", run: () => transport.query("daemon.version", {}) },
  { id: "session.list", label: "session.list", hint: "daemon 侧会话目录", run: () => transport.query("session.list", {}) },
  { id: "workspace.list", label: "workspace.list", hint: "UI 工作区注册表", run: () => transport.query("workspace.list", {}) },
  { id: "config.load", label: "config.load", hint: "原始配置(密钥为掩码)", run: () => transport.query("config.load", {}) },
];

export const HostPanel: Component = () => {
  const [runtime, setRuntime] = createSignal<HostRuntimeInfo | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<{ label: string; text: string; ms: number; failed: boolean } | null>(null);
  const [scopeNote, setScopeNote] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  void loadHostRuntimeInfo().then((info) => setRuntime(info)).catch(() => {});

  const run = async (call: Call): Promise<void> => {
    setBusy(call.id);
    const t0 = performance.now();
    try {
      const value = await call.run();
      setResult({
        label: call.label,
        text: JSON.stringify(value, null, 2),
        ms: Math.round(performance.now() - t0),
        failed: false,
      });
    } catch (cause) {
      setResult({
        label: call.label,
        text: errorTextOf(cause),
        ms: Math.round(performance.now() - t0),
        failed: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const probeScope = async (): Promise<void> => {
    setBusy("scope");
    setScopeNote(null);
    try {
      const snap = await loadMemorySnapshot();
      setScopeNote(`admin 可用：schema v${snap.schema_version}，${snap.sessions.length} 条会话量规。`);
    } catch (cause) {
      setScopeNote(
        isScopeError(cause)
          ? "admin 不可用（403 insufficient_scope）：当前凭据非 admin scope。"
          : `探测失败：${errorTextOf(cause)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const copyResult = async (): Promise<void> => {
    const text = result()?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div class="dev-panel">
      {/* 运行时环境卡 */}
      <div class="dev-card">
        <div class="dev-card-head">
          <h4 class="dev-card-title">运行时环境</h4>
          <Show when={isDesktopRuntime()}>
            <button type="button" class="dev-btn" onClick={() => { void openHostLogs(); }}>
              <IconFolderOpen />
              <span>打开日志目录</span>
            </button>
          </Show>
        </div>
        <div class="dev-card-body">
          <div class="dev-kv-grid">
            <div class="dev-kv"><span>宿主壳</span><b>{isDesktopRuntime() ? "Electron" : "Browser"}</b></div>
            <div class="dev-kv"><span>传输层</span><b>{transport.constructor.name}</b></div>
            <Show when={runtime()}>
              {(r) => (
                <>
                  <div class="dev-kv"><span>App / Electron</span><b>v{r().appVersion} / {r().electron}</b></div>
                  <div class="dev-kv"><span>Chromium / Node</span><b>{r().chrome} / {r().node}</b></div>
                  <div class="dev-kv"><span>系统 / 架构</span><b>{r().platform} {r().arch} ({r().osRelease})</b></div>
                  <div class="dev-kv">
                    <span>主显示器</span>
                    <b>{r().display.width}×{r().display.height} @{r().display.scaleFactor}x · {r().display.refreshRate}Hz</b>
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </div>

      {/* 原始查询按钮组 */}
      <div class="dev-actions">
        <For each={CALLS}>
          {(call) => (
            <button
              type="button"
              class={result()?.label === call.label ? "dev-btn is-active" : "dev-btn"}
              title={call.hint}
              disabled={busy() != null}
              onClick={() => { void run(call); }}
            >
              {call.label}
            </button>
          )}
        </For>
        <button
          type="button"
          class="dev-btn"
          title="探测当前凭据是否具备 admin scope"
          disabled={busy() != null}
          onClick={() => { void probeScope(); }}
        >
          admin scope 探针
        </button>
      </div>

      <Show when={busy() != null}>
        <p class="dev-muted">请求中…</p>
      </Show>
      <Show when={scopeNote() != null}>
        <p class="dev-note">{scopeNote()}</p>
      </Show>

      <div class="dev-card">
        <Show when={result()} fallback={<div class="dev-card-body"><p class="dev-muted">选择一个方法读取 daemon 原始返回体。</p></div>}>
          {(current) => (
            <>
              <div class="dev-card-head">
                <h4 class="dev-card-title">
                  {current().label}
                  <span class="dev-muted"> · {current().ms} ms</span>
                  <Show when={current().failed}>
                    <span class="dev-err-tag">失败</span>
                  </Show>
                </h4>
                <button type="button" class="dev-btn" onClick={() => { void copyResult(); }}>
                  <IconCopy />
                  <span>{copied() ? "已复制" : "复制 JSON"}</span>
                </button>
              </div>
              <pre class={current().failed ? "dev-json is-failed" : "dev-json"}>{current().text}</pre>
            </>
          )}
        </Show>
      </div>
    </div>
  );
};
