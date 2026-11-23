/**
 * 事件流面板:webview 实际收到的宿主事件与发出的 RPC(支持类型筛选与关键字搜索)。
 */
import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import IconPause from "~icons/lucide/pause";
import IconPlay from "~icons/lucide/play";
import IconTrash2 from "~icons/lucide/trash-2";
import { clearDevLog, devLogCount, devLogEntries, type DevLogEntry } from "../../lib/devlog";
import { devMode } from "../../lib/devmode";

type KindFilter = "all" | "rpc" | "event" | "error";

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "rpc", label: "RPC" },
  { id: "event", label: "事件" },
  { id: "error", label: "故障" },
];

const KIND_LABEL: Record<string, string> = { rpc: "RPC", event: "事件", error: "故障" };

const clock = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

export const EventLogPanel: Component = () => {
  const [paused, setPaused] = createSignal(false);
  const [frozen, setFrozen] = createSignal<DevLogEntry[] | null>(null);
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [query, setQuery] = createSignal("");

  const toggleFreeze = (): void => {
    if (paused()) {
      setFrozen(null);
      setPaused(false);
    } else {
      setFrozen(devLogEntries().slice());
      setPaused(true);
    }
  };

  const rows = createMemo<DevLogEntry[]>(() => {
    const source = (frozen() ?? devLogEntries()).slice().reverse();
    const k = kind();
    const q = query().trim().toLowerCase();
    return source.filter((item) => {
      if (k !== "all" && item.kind !== k && !(k === "error" && item.failed)) return false;
      if (!q) return true;
      return item.tag.toLowerCase().includes(q) || item.detail.toLowerCase().includes(q);
    });
  });

  return (
    <div class="dev-panel">
      <div class="dev-toolbar">
        <div class="dev-tabs" role="tablist" aria-label="类型过滤">
          <For each={KIND_FILTERS}>{(item) => (
            <button
              type="button"
              class={kind() === item.id ? "dev-tab is-active" : "dev-tab"}
              onClick={() => setKind(item.id)}
            >
              {item.label}
            </button>
          )}</For>
        </div>
        <input
          type="search"
          class="dev-search"
          placeholder="过滤通道 / 方法 / 摘要…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <span class="dev-muted">显示 {rows().length} / 累计 {devLogCount()}</span>
        <div class="dev-toolbar-right">
          <button type="button" class={paused() ? "dev-btn is-active" : "dev-btn"} onClick={toggleFreeze}>
            <Show when={paused()} fallback={<IconPause />}><IconPlay /></Show>
            <span>{paused() ? "跟随最新" : "冻结视图"}</span>
          </button>
          <button type="button" class="dev-btn" onClick={clearDevLog}>
            <IconTrash2 />
            <span>清空</span>
          </button>
        </div>
      </div>

      <Show when={!devMode()}>
        <p class="dev-warn">开发者模式已收回，不再记录新条目。</p>
      </Show>

      <div class="dev-card">
        <Show when={rows().length > 0} fallback={<div class="dev-card-body"><p class="dev-muted">暂无匹配的事件记录。</p></div>}>
          <div class="dev-table-wrap">
            <table class="dev-table dev-log">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>通道 / 方法</th>
                  <th>摘要</th>
                  <th class="num">耗时</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()} keyed={(row) => row.id}>
                  {(row) => (
                    <tr class={row().failed ? "dev-log-row is-failed" : "dev-log-row"}>
                      <td>{clock(row().at)}</td>
                      <td>
                        <span class={row().failed ? "dev-pill is-err" : "dev-pill"}>
                          {KIND_LABEL[row().kind] ?? row().kind}
                        </span>
                      </td>
                      <td>{row().tag}</td>
                      <td class="dev-log-detail" title={row().detail}>{row().detail}</td>
                      <td class={row().ms != null && row().ms! >= 200 ? "num dev-log-slow" : "num"}>
                        {row().ms == null ? "—" : `${row().ms} ms`}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </div>
  );
};
