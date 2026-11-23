/**
 * 会话内联便签总览卡（对齐 Antigravity Overview Sticky Card）：
 * 挂载在 `.workspace-content` 白画布右侧列内，展开时占真实列宽平滑挤压消息区，
 * 视觉上是一张钉在白画布右缘的圆角便签卡，与对话区浑然一体、零割裂感。
 */
import { createEffect, createMemo, createSignal, For, onSettled, Show, type Component } from "solid-js";
import autoAnimate from "@formkit/auto-animate";
import IconCheckCircle2 from "~icons/lucide/check-circle-2";
import IconCircle from "~icons/lucide/circle";
import IconCircleDot from "~icons/lucide/circle-dot";
import IconTerminal from "~icons/lucide/terminal";
import IconXCircle from "~icons/lucide/x-circle";
import IconActivity from "~icons/lucide/activity";
import { shellTabs } from "../exec/shell-tabs";
import { normalizeStatus, todoStatusLabel } from "../lib/todo";
import type { SessionStore } from "../session/store";
import { Badge } from "../ui/Badge";

const NARROW_RAIL_MAX = 720;

type TodoItem = { title?: string; status?: string; evidence?: string };

const TodoStatusIcon: Component<{ status: string }> = (props) => {
  const st = () => normalizeStatus(props.status);
  return (
    <span class={`overview-todo-icon is-${st()}`} aria-hidden="true">
      <Show when={st() === "completed"}><IconCheckCircle2 /></Show>
      <Show when={st() === "in_progress"}><IconCircleDot /></Show>
      <Show when={st() === "cancelled"}><IconXCircle /></Show>
      <Show when={st() === "pending"}><IconCircle /></Show>
    </span>
  );
};

export const WorkspacePanel: Component<{
  store: SessionStore;
  drawer?: boolean;
  drawerOpen?: boolean;
  manualOpen?: boolean | null;
  onManualToggle?: (value: boolean | null) => void;
  runningExecCount?: () => number;
  onToggleExec?: () => void;
}> = (props) => {
  const items = () => props.store.todos[0]();
  const [manualSignal, setManualSignal] = createSignal<boolean | null>(null);
  const manual = (): boolean | null => (props.manualOpen !== undefined ? props.manualOpen : manualSignal());
  const setManual = (value: boolean | null): void => {
    if (props.onManualToggle != null) props.onManualToggle(value);
    else setManualSignal(value);
  };
  const [narrow, setNarrow] = createSignal(false);
  let root: HTMLElement | undefined;

  createEffect(
    () => items().length,
    (total) => {
      if (total === 0) setManual(null);
    },
  );

  const open = () =>
    props.drawer === true
      ? props.drawerOpen === true
      : (manual() ?? (items().length > 0 && !narrow()));

  onSettled(() => {
    const host = root?.closest("#app");
    if (host == null) return;
    const sidebar = host.querySelector<HTMLElement>(".app-sidebar");
    const apply = (hostWidth: number): void => {
      const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 260;
      const width = hostWidth - sidebarWidth;
      setNarrow((prev) => (prev ? width < NARROW_RAIL_MAX + 24 : width < NARROW_RAIL_MAX));
    };
    apply(host.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != null) apply(width);
    });
    ro.observe(host);
    return () => ro.disconnect();
  });

  const doneCount = createMemo(
    () => items().filter((item: TodoItem) => normalizeStatus(item.status) === "completed").length,
  );

  let todoListEl: HTMLUListElement | undefined;
  onSettled(() => {
    if (todoListEl) autoAnimate(todoListEl, { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  });

  return (
    <aside
      ref={root}
      class={{
        "workspace-panel": true,
        "is-inline-sticky": props.drawer !== true,
        collapsed: props.drawer !== true && !open(),
        drawer: props.drawer === true,
        open: props.drawer === true && open(),
      }}
      aria-label="会话总览便签"
    >
      <div class="workspace-panel-surface">
        <Show when={open()}>
          <div class="overview-sticky-card">
            {/* 第一段：总览快捷入口 */}
            <div class="overview-section">
              <div class="overview-section-head">总览</div>
              <button
                type="button"
                class="overview-action-row"
                onClick={() => void shellTabs.open()}
              >
                <IconTerminal />
                <span>终端</span>
              </button>
              <Show when={props.onToggleExec != null}>
                <button
                  type="button"
                  class="overview-action-row"
                  onClick={() => props.onToggleExec?.()}
                >
                  <IconActivity />
                  <span>后台任务</span>
                  <Show when={(props.runningExecCount?.() ?? 0) > 0}>
                    <Badge tone="accent">{props.runningExecCount!()}</Badge>
                  </Show>
                </button>
              </Show>
            </div>

            {/* 第二段：当前会话待办清单 */}
            <div class="overview-section">
              <div class="overview-section-head">
                <span>待办</span>
                <Show when={items().length > 0}>
                  <Badge>{doneCount()}/{items().length}</Badge>
                </Show>
              </div>
              <Show
                when={items().length > 0}
                fallback={<div class="overview-empty">暂无待办步骤</div>}
              >
                <ul class="overview-todo-list" ref={todoListEl}>
                  <For each={items()}>
                    {(item: TodoItem) => (
                      <li
                        class="overview-todo-item"
                        data-status={normalizeStatus(item.status)}
                        title={item.evidence ?? item.title}
                        aria-label={`${item.title ?? "待办"}，${todoStatusLabel(normalizeStatus(item.status))}`}
                      >
                        <TodoStatusIcon status={item.status ?? "pending"} />
                        <span class="overview-todo-title">{item.title}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </aside>
  );
};
