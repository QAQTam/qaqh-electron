/**
 * 工作区集合面板(待办是当前唯一数据分区):占会话右栏(真实分配列宽,不覆盖正文),
 * 展开 320px、收起为 40px 图标栏;有待办自动展开、清空自动收起,手动开合优先于自动。
 *
 * 工作区区域过窄时(容器宽度低于 NARROW_RAIL_MAX)自动收起为窄栏——仍占位、不覆盖正文;
 * 点图标仍可强制展开,占的是真实列宽,同样不会盖住消息。
 *
 * 状态视觉:空心圆=待办;spinner=进行中;勾选+次级文字=完成;红点=取消。
 * 无逐条错峰动画,避免快照更新时重复播放;数据单源 store.todos(todo.list RPC,
 * v2 资源变更/工具终态/回合结束/激活/重连/投影重置驱动刷新)。
 */
import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import autoAnimate from "@formkit/auto-animate";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconFolder from "~icons/lucide/folder";
import IconListTodo from "~icons/lucide/list-todo";
import IconLoader from "~icons/lucide/loader-circle";
import IconCheck from "~icons/lucide/check";
import { STR } from "../lib/strings";
import { normalizeStatus } from "../lib/todo";
import type { SessionStore } from "../session/store";

/** 会话列宽度低于此值时,右栏默认收起为窄栏(仍占位,不覆盖消息)。 */
const NARROW_RAIL_MAX = 720;

const TodoRow: Component<{ item: { title?: string; status?: string; evidence?: string } }> = (props) => {
  const status = () => normalizeStatus(props.item.status);
  const statusLabel = () => {
    switch (status()) {
      case "in_progress": return "进行中";
      case "completed": return "已完成";
      case "cancelled": return "已取消";
      default: return "待处理";
    }
  };
  return (
    <li
      class={{ "todo-row": true, [`st-${status()}`]: true }}
      aria-label={`${props.item.title ?? "待办"}，${statusLabel()}`}
    >
      <Show
        when={status() === "in_progress"}
        fallback={<span class="todo-dot" aria-hidden="true"><Show when={status() === "completed"}><IconCheck /></Show></span>}
      >
        <span class="todo-dot todo-spin" aria-hidden="true"><IconLoader /></span>
      </Show>
      <span class="todo-title" title={props.item.evidence ?? props.item.title}>
        {props.item.title}
      </span>
      <span class="sr-only">{statusLabel()}</span>
    </li>
  );
};

export const WorkspacePanel: Component<{ store: SessionStore;
  /** 阶段5:cols<3 时以抽屉呈现(固定 320,覆盖正文),App 控制挂载。 */
  drawer?: boolean;
  /** 抽屉开合(App 的 railDrawerOpen);抽屉态恒由外部驱动,不走 manual/auto 规则。 */
  drawerOpen?: boolean;
  /** 受控手动开合(BUG-2026-10-29 顶栏主动展开钮):App 持有并持久化;不传走内部信号。 */
  manualOpen?: boolean | null;
  onManualToggle?: (value: boolean | null) => void; }> = (props) => {
  const items = () => props.store.todos[0]();
  // null = 自动(有待办且右栏放得下时展开);true/false = 用户手动开合,清空后重置。
  const [manualSignal, setManualSignal] = createSignal<boolean | null>(null);
  // 受控优先:TopBar 的任务钮与面板头部按钮共享同一份手动态(App 持有,可持久化)。
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
      // 清空后重置为自动模式(下次有待办会再自动展开)。
      if (total === 0) setManual(null);
    },
  );
  // 抽屉态由 App 的 drawerOpen 驱动(面板常驻挂载,滑出画面后 display:none);
  // 列态沿用 narrow/manual 规则。
  const open = () => (props.drawer === true ? props.drawerOpen === true : (manual() ?? (items().length > 0 && !narrow())));

  // 量「#app 总宽 − 侧栏宽」(spec §4.7 允许量 #app):这个值与右栏自身宽度无关,
  // 不会形成「展开→挤压→收起→回弹」的反馈振荡;阈值语义仍是"主列可用宽度"。
  onSettled(() => {
    const host = root?.closest("#app");
    if (host == null) return;
    const sidebar = host.querySelector<HTMLElement>(".app-sidebar");
    // 注意:setter 返回被赋的布尔值,回调绝不能是表达式箭头体(会被当成 cleanup)。
    const measure = (): void => {
      const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 288;
      setNarrow(host.clientWidth - sidebarWidth < NARROW_RAIL_MAX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  });

  const doneCount = () => items().filter((item) => normalizeStatus(item.status) === "completed").length;

  return (
    <aside ref={root} id="right-rail" class={{
      "workspace-panel": true,
      drawer: props.drawer === true,
      open: props.drawer === true && open(),
      /* collapsed 只描述列态收窄;抽屉的出画交给 .drawer 的 transform,
         两者混用会让滑出过程同时叠一层 320→40 的宽度收缩。 */
      collapsed: props.drawer !== true && !open(),
    }} aria-label={STR.workspacePanelTitle}>
      <div class="workspace-panel-surface">
        <button
          type="button"
          class="workspace-panel-head"
          aria-label={open() ? "收起工作区面板" : "展开工作区面板"}
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setManual(!open())}
        >
          <IconFolder />
          <span>{STR.workspacePanelTitle}</span>
          <span class="workspace-panel-chevron">
            <IconChevronDown />
          </span>
        </button>
        <div class="workspace-panel-body" aria-hidden={open() ? "false" : "true"}>
          <div class="workspace-panel-body-inner" inert={!open()}>
            <div class="workspace-panel-section-head">
              <IconListTodo />
              <span>{STR.todoTitle}</span>
              <Show when={props.store.todosSyncPending[0]()}>
                <span class="todo-sync-pending" role="status" aria-live="polite">{STR.todoSyncPending}</span>
              </Show>
              <Show when={items().length > 0}>
                <b class="todo-count">{STR.todoDone(doneCount(), items().length)}</b>
              </Show>
            </div>
            <Show
              when={items().length > 0}
              fallback={<div class="todo-empty">{STR.todoEmpty}</div>}
            >
              <ul
                class="todo-list"
                ref={(el) => {
                  if (el) autoAnimate(el, { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
                }}
              >
                <For each={items()}>
                  {(item) => <TodoRow item={item} />}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </div>
    </aside>
  );
};
