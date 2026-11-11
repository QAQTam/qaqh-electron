/**
 * 工作区集合面板(到站屏形态):占会话右栏(真实分配列宽,不覆盖正文),
 * 展开 320px、收起=零宽完全收回(开合入口在顶栏任务钮);有待办自动展开、
 * 清空自动收起,手动开合优先于自动。
 *
 * 视觉语言取自伦敦 Overground 站台到发屏:
 *   hero 区  = 当前承服务任务(大号窄体)+ LED 状态词(BOARDING 闪烁);
 *   色带     = 线路色(状态映射 accent/ok/err),出血到列边;
 *   圆点     = 每任务一枚(●登车/○待发/✓到达/✕不停靠),上限 12;
 *   next 区  = 后续任务,虚线分隔,单行截断(收矮文字区域)。
 * has-mica 桌面下 surface 全透明——文字直接站在 Mica 上(见 fluent.css)。
 *
 * 工作区区域过窄时(容器宽度低于 NARROW_RAIL_MAX)自动收起为零宽——不占列、不覆盖正文;
 * 顶栏任务钮强制展开时占回真实列宽,同样不会盖住消息。
 * 数据单源 store.todos(todo.list RPC,v2 资源变更/工具终态/回合结束/激活/重连/投影重置驱动刷新)。
 */
import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import autoAnimate from "@formkit/auto-animate";
import IconListTodo from "~icons/lucide/list-todo";
import { STR } from "../lib/strings";
import { normalizeStatus, todoStatusLabel, type TodoStatus } from "../lib/todo";
import type { SessionStore } from "../session/store";

/** 会话列宽度低于此值时,右栏默认收起为窄栏(仍占位,不覆盖消息)。 */
const NARROW_RAIL_MAX = 720;
/** 登车圆点上限:到发屏不挂一整面墙的灯。 */
const DOTS_MAX = 12;

type TodoItem = { title?: string; status?: string; evidence?: string };

/** 当前承服务 = in_progress 优先;否则最早的 pending;都没有则最后一行(全完成的 ARRIVED 场景)。 */
function heroOf(list: TodoItem[]): TodoItem | null {
  return list.find((item) => normalizeStatus(item.status) === "in_progress")
    ?? list.find((item) => normalizeStatus(item.status) === "pending")
    ?? list[list.length - 1]
    ?? null;
}

const BoardRow: Component<{ item: TodoItem }> = (props) => {
  const status = () => normalizeStatus(props.item.status);
  return (
    <li
      class="todo-next-row"
      data-status={status()}
      aria-label={`${props.item.title ?? "待办"}，${todoStatusLabel(status())}`}
    >
      <span class="todo-next-title" title={props.item.evidence ?? props.item.title}>
        {props.item.title}
      </span>
      <span class="todo-next-status" aria-hidden="true">{STR.todoBoardWords[status()]}</span>
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
    // 注意:setter 无返回值,箭头体绝不能是表达式(会被当成 cleanup)。
    const apply = (hostWidth: number): void => {
      const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 288;
      setNarrow(hostWidth - sidebarWidth < NARROW_RAIL_MAX);
    };
    // RO 回调在布局后运行:host 宽用入参 contentRect,不再自读 clientWidth
    // (拖宽卡顿根因之一:回调里读几何触发强制同步布局乒乓)。
    apply(host.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect != null) apply(rect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  });

  const hero = () => heroOf(items());
  const heroStatus = (): TodoStatus => (hero() == null ? "pending" : normalizeStatus(hero()!.status));
  /** Now Serving 位次(1 基):到发屏右上角报"第几班",不是完成数——完成数由登车圆点表达。 */
  const heroPos = () => {
    const h = hero();
    return h == null ? 0 : items().indexOf(h) + 1;
  };
  const rest = () => items().filter((item) => item !== hero());
  const dots = () => items().slice(0, DOTS_MAX);

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
        <div class="workspace-panel-body" aria-hidden={open() ? "false" : "true"}>
          <div class="workspace-panel-body-inner" inert={!open()}>
            {/* 面板开合唯一入口在顶栏任务钮(App 的 railManual);面板内不再有头部行,
                「待办」区头直接顶到首行。 */}
            <div class="workspace-panel-section-head">
              <IconListTodo />
              <span>{STR.todoTitle}</span>
              <Show when={props.store.todosSyncPending[0]()}>
                <span class="todo-sync-pending" role="status" aria-live="polite">{STR.todoSyncPending}</span>
              </Show>
            </div>
            <Show
              when={items().length > 0}
              fallback={<div class="todo-empty">{STR.todoEmpty}</div>}
            >
              <div class="todo-board">
                <div class="todo-hero" data-status={heroStatus()}>
                  <div class="todo-hero-top">
                    <span class="todo-hero-label">Now Serving</span>
                    <b class="todo-hero-count">{STR.todoDone(heroPos(), items().length)}</b>
                  </div>
                  <div class="todo-hero-main">
                    <span class="todo-hero-title" title={hero()?.evidence ?? hero()?.title}>
                      {hero()?.title}
                    </span>
                    <span class="todo-hero-status" aria-hidden="true">{STR.todoBoardWords[heroStatus()]}</span>
                  </div>
                  <div class="todo-hero-band" aria-hidden="true" />
                  <div class="todo-dots" aria-hidden="true">
                    <For each={dots()}>
                      {(item) => <span class="todo-dot2" data-status={normalizeStatus(item.status)} />}
                    </For>
                  </div>
                </div>
                <ul
                  class="todo-next"
                  ref={(el) => {
                    if (el) autoAnimate(el, { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
                  }}
                >
                  <For each={rest()}>
                    {(item) => <BoardRow item={item} />}
                  </For>
                </ul>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </aside>
  );
};
