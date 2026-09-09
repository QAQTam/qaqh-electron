// Inspector：240px 右抽屉（spec §9）。三页签：工具（ToolCallView 流）/ diff / 事件。
// ⌘I 呼出，默认收合。
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Component } from "solid-js";
import type { SessionView } from "qaqh-js-sdk";
import { diffStat, parseDiff } from "../lib/diff";

type InspectorTab = "tools" | "diff" | "events";

const badge = (status: string) => status;

const Inspector: Component<{ session: SessionView | null; rawEvents: string[] }> = (props) => {
  const [tab, setTab] = createSignal<InspectorTab>("tools");

  const toolGroups = createMemo(() => {
    const s = props.session;
    if (!s) return [];
    const byTurn = new Map<string, typeof s.tools>();
    for (const t of s.tools) {
      const arr = byTurn.get(t.turnId) ?? [];
      arr.push(t);
      byTurn.set(t.turnId, arr);
    }
    return [...byTurn.entries()].reverse();
  });

  const diffFiles = createMemo(() => {
    const s = props.session;
    if (!s) return [];
    const byFile = new Map<string, { add: number; del: number; diff: string }>();
    for (const t of s.tools) {
      const d = t.result?.diff;
      if (!d) continue;
      const file = /(?:diff --git a\/(\S+)|\+\+\+ b\/(\S+))/.exec(d);
      const name = file?.[1] ?? file?.[2] ?? "(unknown)";
      const prev = byFile.get(name) ?? { add: 0, del: 0, diff: "" };
      const stat = diffStat(d);
      byFile.set(name, {
        add: prev.add + stat.add,
        del: prev.del + stat.del,
        diff: prev.diff + (prev.diff ? "\n" : "") + d,
      });
    }
    return [...byFile.entries()];
  });

  const [openDiff, setOpenDiff] = createSignal<string | null>(null);

  return (
    <div class="inspector">
      <div class="inspector-tabs">
        <button class={["inspector-tab", { on: tab() === "tools" }]} onClick={() => setTab("tools")}>
          工具
        </button>
        <button class={["inspector-tab", { on: tab() === "diff" }]} onClick={() => setTab("diff")}>
          diff
        </button>
        <button class={["inspector-tab", { on: tab() === "events" }]} onClick={() => setTab("events")}>
          事件
        </button>
      </div>
      <div class="inspector-body">
        <Show when={tab() === "tools"}>
          <Show when={toolGroups().length > 0} fallback={<div class="inspector-empty">本会话暂无工具调用</div>}>
            <For each={toolGroups()}>
              {([turnId, tools]) => (
                <div class="ins-tool-group">
                  <div class="ins-tool-group-title">turn {turnId.slice(0, 8)}</div>
                  <For each={tools}>
                    {(t) => (
                      <div class="ins-tool-card">
                        <span class={["tool-badge", badge(t.status)]}>{t.status}</span>
                        <span class="name">{t.name}</span>
                        <span class="sum">{t.result?.summary ?? t.argsSoFar.slice(0, 40)}</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
        <Show when={tab() === "diff"}>
          <Show when={diffFiles().length > 0} fallback={<div class="inspector-empty">本会话暂无代码变更</div>}>
            <For each={diffFiles()}>
              {([name, stat]) => (
                <div>
                  <button class="ins-diff-file" onClick={() => setOpenDiff(openDiff() === name ? null : name)}>
                    <span>{name}</span>
                    <span>
                      <span class="diff-stat-add">+{stat.add}</span>{" "}
                      <span class="diff-stat-del">−{stat.del}</span>
                    </span>
                  </button>
                  <Show when={openDiff() === name}>
                    <div class="diff">
                      <For each={parseDiff(stat.diff)}>
                        {(l) => <div class={["diff-line", l.kind]}>{l.text || " "}</div>}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
        <Show when={tab() === "events"}>
          <Show when={props.rawEvents.length > 0} fallback={<div class="inspector-empty">暂无事件（调试流）</div>}>
            <For each={props.rawEvents.slice(-120).reverse()}>
              {(ev) => (
                <div class="ins-event" title={ev}>
                  {ev}
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default Inspector;
