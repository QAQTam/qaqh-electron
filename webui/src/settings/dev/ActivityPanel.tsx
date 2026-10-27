/**
 * 活动状态面板:纯读前端 store,不碰后端。
 *
 * 这块数据本来就因为渲染而响应式更新(连接态、水位、回合计数都在 `SessionStore`
 * 的信号上),控制台只是把平时不显示的那半张脸露出来——所以它免费、实时,而且不会
 * 因为观察而改变被观察的东西。
 *
 * `SessionStore` 的每个信号字段存的是 `createSignal` 的**元组**(App.tsx:268 同
 * 一路数),读一律 `store.connection[0]()`,这里不另造访问器。
 */
import { For, Show, createMemo, type Component } from "solid-js";
import { activeId, activeTab, tabs } from "../../tabs/store";
import type { SessionStore } from "../../session/store";

const num = (value: number | null | undefined): string => (value == null ? "—" : String(value));
const pct = (value: number | null): string => (value == null ? "—" : `${value.toFixed(1)}%`);
const shortId = (value: string): string => (value.length > 12 ? value.slice(0, 10) : value);

/** 单个 store 的读数;非活动标签也照读,多标签状态对拍就靠这个。 */
const StoreRows: Component<{ store: SessionStore }> = (props) => {
  const state = () => props.store.state[0];
  const metrics = () => props.store.composerMetrics[0]();
  return (
    <div class="readonly-grid">
      <span>seed</span>
      <b>{props.store.seed}</b>
      <span>标题</span>
      <b>{props.store.title[0]() ?? "—"}</b>
      <span>connection</span>
      <b>{props.store.connection[0]()}</b>
      <span>activity</span>
      <b>{props.store.activity[0]() ?? "—"}</b>
      <span>回合(总/运行/失败)</span>
      <b>{state().totalTurns} / {state().runningTurns} / {state().failedTurns}</b>
      <span>watermark</span>
      <b>{num(state().watermark)}</b>
      <span>serverEpoch</span>
      <b>{state().serverEpoch ?? "—"}</b>
      <span>oldestIndex</span>
      <b>{num(state().oldestIndex)}</b>
      <span>slots / structureVersion</span>
      <b>{state().slots.length} / {state().structureVersion}</b>
      <span>hasMore / truncatedBefore</span>
      <b>{String(state().hasMore)} / {String(state().truncatedBefore)}</b>
      <span>activeTurnKey</span>
      <b>{state().activeTurnKey ?? "—"}</b>
      <span>waits</span>
      <b>{state().waits.length}</b>
      <span>待授权 / todo</span>
      <b>{props.store.pending[0]().length} / {props.store.todos[0]().length}</b>
      <span>tokensPerSecond</span>
      <b>{num(metrics().tokensPerSecond)}</b>
      <span>contextPercent</span>
      <b>{pct(metrics().contextPercent)}</b>
      <span>cacheHitPercent</span>
      <b>{pct(metrics().cacheHitPercent)}</b>
      <span>usage extras</span>
      <b>{Object.keys(metrics().extras).length === 0 ? "—" : Object.entries(metrics().extras).map(([key, value]) => `${key}=${value}`).join(" ")}</b>
      <span>loadError / hasNewReply</span>
      <b>{String(props.store.loadError[0]())} / {String(props.store.hasNewReply[0]())}</b>
      <span>压缩锚点</span>
      <b>{props.store.compactedAfter[0]() ?? "—"}</b>
    </div>
  );
};

export const ActivityPanel: Component = () => {
  const tab = createMemo(() => activeTab());
  return (
    <div class="dev-panel">
      <Show when={tab()} fallback={<p class="dev-muted">没有活动标签:先开一个会话再看这块。</p>}>
        {(current) => (
          <>
            <h4 class="dev-sub">活动标签({shortId(current().id)})</h4>
            <StoreRows store={current().store} />
          </>
        )}
      </Show>

      <h4 class="dev-sub">全部标签({tabs().length},activeId {shortId(activeId() ?? "—")})</h4>
      <Show when={tabs().length > 0} fallback={<p class="dev-muted">当前没有打开的标签。</p>}>
        <table class="readonly-table">
          <thead>
            <tr><th>标签</th><th>seed</th><th>connection</th><th>activity</th><th>回合</th><th>待授权</th><th>水位</th></tr>
          </thead>
          <tbody>
            <For each={tabs()} keyed={(entry) => entry.id}>
              {(entry) => (
                <tr>
                  <td>{entry().id === activeId() ? "★ " : ""}{shortId(entry().id)}</td>
                  <td title={entry().seed}>{shortId(entry().seed)}</td>
                  <td>{entry().store.connection[0]()}</td>
                  <td>{entry().store.activity[0]() ?? "—"}</td>
                  <td>{entry().store.state[0].totalTurns}</td>
                  <td>{entry().store.pending[0]().length}</td>
                  <td>{entry().store.state[0].watermark}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};
