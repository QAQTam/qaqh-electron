/**
 * 事件流面板:webview 实际收到的宿主事件与发出的 RPC。
 *
 * 埋点在 `lib/transport/*`(`noteEvent` / `noteRpc`),只在开发者模式开着时记录。
 *  newest-first:排查时关心的是「刚刚发生了什么」,而不是要先滚到底。
 */
import { For, Show, createSignal, type Component } from "solid-js";
import { clearDevLog, devLogCount, devLogEntries, type DevLogEntry } from "../../lib/devlog";
import { devMode } from "../../lib/devmode";

const KIND_LABEL: Record<string, string> = { rpc: "RPC", event: "事件", error: "故障" };

const clock = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

export const EventLogPanel: Component = () => {
  const [paused, setPaused] = createSignal(false);
  /** 冻结就是拍照:捕获当时的数组,后续记录照常进行,只是视图不再跟随。 */
  const [frozen, setFrozen] = createSignal<DevLogEntry[] | null>(null);
  const toggleFreeze = (): void => {
    if (paused()) {
      setFrozen(null);
      setPaused(false);
    } else {
      setFrozen(devLogEntries().slice());
      setPaused(true);
    }
  };
  const rows = (): DevLogEntry[] => (frozen() ?? devLogEntries()).slice().reverse();
  return (
    <div class="dev-panel">
      <div class="dev-toolbar">
        <span class="dev-muted">累计 {devLogCount()} 条 · 缓冲内 {devLogEntries().length} 条</span>
        <button type="button" class="ghost-mini" onClick={toggleFreeze}>
          {paused() ? "跟随最新" : "冻结视图"}
        </button>
        <button type="button" class="ghost-mini" onClick={clearDevLog}>清空</button>
      </div>
      <Show when={!devMode()}>
        <p class="dev-warn">开发者模式已收回,不再记录新条目;缓冲里的残留还在,清空即归零。</p>
      </Show>
      <Show when={rows().length > 0} fallback={<p class="dev-muted">还没有记录。切到其他标签页、发消息或开关设置,都会在这里留下痕迹。</p>}>
        <table class="readonly-table dev-log">
          <thead>
            <tr><th>时间</th><th>类型</th><th>通道 / 方法</th><th>摘要</th><th>耗时</th></tr>
          </thead>
          <tbody>
            <For each={rows()} keyed={(row) => row.id}>
              {(row) => (
                <tr class={row().failed ? "dev-log-row is-failed" : "dev-log-row"}>
                  <td>{clock(row().at)}</td>
                  <td>{KIND_LABEL[row().kind] ?? row().kind}</td>
                  <td>{row().tag}</td>
                  <td class="dev-log-detail">{row().detail}</td>
                  <td>{row().ms == null ? "—" : `${row().ms}ms`}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};
