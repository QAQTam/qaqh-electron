/**
 * 宿主面面板:直连 daemon 的原始读法,不经任何前端归一化。
 *
 * 和设置页的区别就是「原始」二字——设置页看到的是 `settings/store.ts` 归一化并
 * 补齐默认值之后的 `ConfigDto`,这里看的是 daemon 原样返回的 JSON(密钥仍是掩码
 * `"****"`,`qaqh-config/dto.rs:22`)。排查「前端把后端的东西读歪了没有」时,
 * 需要的正是未经加工的那份。
 */
import { For, Show, createSignal, type Component } from "solid-js";
import { isTauriRuntime, transport } from "../../lib/transport";
import { errorTextOf, isScopeError, loadMemorySnapshot } from "../../lib/memwatch";

type Call = { id: string; label: string; hint: string; run: () => Promise<unknown> };

const CALLS: Call[] = [
  { id: "daemon.version", label: "daemon.version", hint: "sidecar 自身版本(与壳版本分开)", run: () => transport.rpc("daemon.version", {}) },
  { id: "session.list", label: "session.list", hint: "daemon 侧会话目录", run: () => transport.rpc("session.list", {}) },
  { id: "workspace.list", label: "workspace.list", hint: "UI 工作区注册表", run: () => transport.rpc("workspace.list", {}) },
  { id: "config.load", label: "config.load", hint: "原始配置,密钥为掩码", run: () => transport.rpc("config.load", {}) },
];

export const HostPanel: Component = () => {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<{ label: string; text: string; failed: boolean } | null>(null);
  const [scopeNote, setScopeNote] = createSignal<string | null>(null);

  const previewMode = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("preview") === "tauri";

  const run = async (call: Call): Promise<void> => {
    setBusy(call.id);
    try {
      const value = await call.run();
      setResult({ label: call.label, text: JSON.stringify(value, null, 2), failed: false });
    } catch (cause) {
      setResult({ label: call.label, text: errorTextOf(cause), failed: true });
    } finally {
      setBusy(null);
    }
  };

  /** Admin scope 探针:能不能用内存探测,一行话就说明当前凭据是什么身份。 */
  const probeScope = async (): Promise<void> => {
    setBusy("scope");
    setScopeNote(null);
    try {
      const snap = await loadMemorySnapshot(null);
      setScopeNote(`admin 可用:快照 schema v${snap.schema_version},${snap.sessions.length} 条会话量规。`);
    } catch (cause) {
      setScopeNote(isScopeError(cause)
        ? "admin 不可用(403 insufficient_scope):当前凭据不是 admin scope,内存探测用不了。"
        : `探测失败:${errorTextOf(cause)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="dev-panel">
      <div class="readonly-grid">
        <span>运行时</span>
        <b>{isTauriRuntime() ? "Tauri 壳" : previewMode ? "浏览器预览替身" : "纯浏览器(无壳)"}</b>
        <span>传输后端</span>
        <b>{transport.constructor.name}</b>
      </div>

      <div class="dev-actions">
        <For each={CALLS}>
          {(call) => (
            <button type="button" class="ghost-mini" title={call.hint} disabled={busy() != null} onClick={() => { void run(call); }}>
              {call.label}
            </button>
          )}
        </For>
        <button type="button" class="ghost-mini" title="试一发 admin-only 的 snapshot,看当前凭据的 scope" disabled={busy() != null} onClick={() => { void probeScope(); }}>
          admin scope 探针
        </button>
      </div>

      <Show when={busy() != null}>
        <p class="dev-muted">请求中…</p>
      </Show>
      <Show when={scopeNote() != null}>
        <p class="dev-note">{scopeNote()}</p>
      </Show>
      <Show when={result()} fallback={<p class="dev-muted">挑一个方法读原始返回体。</p>}>
        {(current) => (
          <>
            <h4 class="dev-sub">
              {current().label}
              <Show when={current().failed}>
                <span class="dev-err-tag"> 失败</span>
              </Show>
            </h4>
            <pre class={current().failed ? "dev-json is-failed" : "dev-json"}>{current().text}</pre>
          </>
        )}
      </Show>
    </div>
  );
};
