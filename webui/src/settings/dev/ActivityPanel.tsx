/**
 * 活动状态面板:纯读前端 store,不碰后端。
 */
import { For, Show, createMemo, type Component } from "solid-js";
import { activeId, activeTab, tabs } from "../../tabs/store";
import type { SessionStore } from "../../session/store";

const num = (value: number | null | undefined): string => (value == null ? "—" : String(value));
const pct = (value: number | null): string => (value == null ? "—" : `${value.toFixed(1)}%`);
const shortId = (value: string): string => (value.length > 12 ? value.slice(0, 10) : value);

const connPill = (value: string): string => {
  if (value === "live") return "dev-pill is-ok";
  if (value === "reconnecting" || value === "connecting") return "dev-pill is-warn";
  if (value === "closed") return "dev-pill is-err";
  return "dev-pill";
};

const StoreRows: Component<{ store: SessionStore }> = (props) => {
  const state = () => props.store.state[0];
  const metrics = () => props.store.composerMetrics[0]();
  return (
    <div class="dev-kv-grid">
      <div class="dev-kv"><span>seed</span><b>{props.store.seed}</b></div>
      <div class="dev-kv"><span>标题</span><b>{props.store.title[0]() ?? "—"}</b></div>
      <div class="dev-kv"><span>connection</span><b class={connPill(props.store.connection[0]())}>{props.store.connection[0]()}</b></div>
      <div class="dev-kv"><span>activity</span><b>{props.store.activity[0]() ?? "—"}</b></div>
      <div class="dev-kv"><span>回合 (总/运行/失败)</span><b>{state().totalTurns} / {state().runningTurns} / {state().failedTurns}</b></div>
      <div class="dev-kv"><span>serverEpoch</span><b>{state().serverEpoch ?? "—"}</b></div>
      <div class="dev-kv"><span>oldestIndex</span><b>{num(state().oldestIndex)}</b></div>
      <div class="dev-kv"><span>slots / version</span><b>{state().slots.length} / {state().structureVersion}</b></div>
      <div class="dev-kv"><span>hasMore / truncated</span><b>{String(state().hasMore)} / {String(state().truncatedBefore)}</b></div>
      <div class="dev-kv"><span>activeTurnKey</span><b>{state().activeTurnKey ?? "—"}</b></div>
      <div class="dev-kv"><span>waits / 待授权 / todo</span><b>{state().waits.length} / {props.store.pending[0]().length} / {props.store.todos[0]().length}</b></div>
      <div class="dev-kv"><span>context / cache</span><b>{pct(metrics().contextPercent)} / {pct(metrics().cacheHitPercent)}</b></div>
      <div class="dev-kv">
        <span>usage extras</span>
        <b>{Object.keys(metrics().extras).length === 0 ? "—" : Object.entries(metrics().extras).map(([k, v]) => `${k}=${v}`).join(" ")}</b>
      </div>
      <div class="dev-kv"><span>loadError / hasNewReply</span><b>{String(props.store.loadError[0]())} / {String(props.store.hasNewReply[0]())}</b></div>
    </div>
  );
};

export const ActivityPanel: Component = () => {
  const tab = createMemo(() => activeTab());
  return (
    <div class="dev-panel">
      <div class="dev-card">
        <div class="dev-card-head">
          <h4 class="dev-card-title">
            当前活动标签
            <Show when={tab()}>{(current) => <span class="dev-muted"> · {shortId(current().id)}</span>}</Show>
          </h4>
        </div>
        <div class="dev-card-body">
          <Show when={tab()} fallback={<p class="dev-muted">当前没有活动标签。</p>}>
            {(current) => <StoreRows store={current().store} />}
          </Show>
        </div>
      </div>

      <div class="dev-card">
        <div class="dev-card-head">
          <h4 class="dev-card-title">全部标签</h4>
          <span class="dev-muted">{tabs().length} 个 · active {shortId(activeId() ?? "—")}</span>
        </div>
        <Show when={tabs().length > 0} fallback={<div class="dev-card-body"><p class="dev-muted">暂无打开的标签。</p></div>}>
          <div class="dev-table-wrap">
            <table class="dev-table">
              <thead>
                <tr>
                  <th>标签</th>
                  <th>seed</th>
                  <th>连接</th>
                  <th>状态</th>
                  <th class="num">回合</th>
                  <th class="num">待授权</th>
                  <th class="num">水位</th>
                </tr>
              </thead>
              <tbody>
                <For each={tabs()} keyed={(entry) => entry.id}>
                  {(entry) => (
                    <tr>
                      <td class="mono">{entry().id === activeId() ? "● " : ""}{shortId(entry().id)}</td>
                      <td class="mono" title={entry().seed}>{shortId(entry().seed)}</td>
                      <td><span class={connPill(entry().store.connection[0]())}>{entry().store.connection[0]()}</span></td>
                      <td class="mono">{entry().store.activity[0]() ?? "—"}</td>
                      <td class="num">{entry().store.state[0].totalTurns}</td>
                      <td class="num">{entry().store.pending[0]().length}</td>
                      <td class="num">{entry().store.state[0].structureVersion}</td>
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
