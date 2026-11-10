import { createSignal, For, onCleanup, Show, type Component } from "solid-js";
import IconKeyRound from "~icons/lucide/key-round";
import IconMessageSquare from "~icons/lucide/message-square";
import IconSettings from "~icons/lucide/settings";
import IconWrench from "~icons/lucide/wrench";
import { clampSidebarWidth, dragSidebarWidth, SIDEBAR_WIDTH_STEP } from "../lib/sidebar-resize";
import { MessageSidebar } from "./MessageSidebar";
import { createSelectionPill } from "./selection-pill";
import type { ApprovalView } from "../lib/transport";
import type { SidebarSession, SidebarWorkspace } from "../tabs/store";
import { SETTINGS_NAV, SETTINGS_NAV_GROUPS } from "../settings/navigation";

export type GlobalSection = "messages" | "tools" | "oauth" | "settings";

/** 导航 2×2(spec §6.1):取代 64px 图标 rail,带可见 label,不再依赖 tooltip。
 *  「接入」涵盖后续友商(不都是 OAuth),改词只改这里。 */
const NAV_ITEMS = [
  { id: "messages", label: "消息", Icon: IconMessageSquare },
  { id: "tools", label: "工具", Icon: IconWrench },
  { id: "oauth", label: "接入", Icon: IconKeyRound },
  { id: "settings", label: "设置", Icon: IconSettings },
] as const;

/**
 * 壳侧栏(spec §6.1,阶段 3):Nav 2×2 + 会话列表同占一列 288px。
 * 非消息页只显示 Nav,会话列表隐藏(§4.5);<720px 的抽屉化是阶段 5。
 */
export const Sidebar: Component<{
  section: GlobalSection;
  onNavigate: (section: GlobalSection) => void;
  settingsSection?: string;
  onSettingsSection?: (section: string) => void;
  /** 汉堡收展(用户侧需求):收起后只剩 48px 图标导航,会话列表隐藏。 */
  collapsed?: boolean;
  /** 阶段5:cols=1 时以抽屉呈现(288 覆盖 Main),App 控制开合。 */
  drawer?: boolean;
  drawerOpen?: boolean;
  sessions?: SidebarSession[];
  workspaces?: SidebarWorkspace[];
  activeSeed?: string | null;
  /** 活动会话当前的即时待人列表(fast path,无需等待 15s 轮询)。 */
  activePending?: () => ApprovalView[];
  onSelect?: (seed: string) => void;
  onCreate?: () => void;
  /** 在指定工作区新建会话(见 MessageSidebar.onCreateIn)。 */
  onCreateIn?: (path: string) => void;
  creating?: boolean;
  canCreate?: boolean;
  onRename?: (seed: string, title: string) => Promise<void>;
  onDelete?: (seed: string) => Promise<void>;
  /** 拖拽调宽:当前宽度(null = 默认,吃 --sidebar-width token)。App 持久化。 */
  width?: number | null;
  /** 松手/键盘提交;width=null 恢复默认;低于收回阈值由 App 判定(等效汉堡)。 */
  onWidthCommit?: (width: number | null) => void;
}> = (props) => {
  let asideEl: HTMLElement | undefined;
  /* 拖拽调宽(用户侧需求,卡顿防线):pointermove 不进 signal、不触发重渲染,
     rAF 合帧后直写 #app 的 --sidebar-width;html.sidebar-resizing 关掉轨道过渡
     (过渡会拖住光标产生橡皮筋感)。松手才提交,App 落盘并决定是否收回。 */
  let drag: { startX: number; startWidth: number; width: number; frame: number } | null = null;
  onCleanup(() => {
    if (drag != null && drag.frame !== 0) cancelAnimationFrame(drag.frame);
    drag = null;
    document.documentElement.classList.remove("sidebar-resizing");
  });
  const appEl = (): HTMLElement | null => asideEl?.closest("#app") ?? null;
  const commitResize = (): void => {
    if (drag == null) return;
    if (drag.frame !== 0) cancelAnimationFrame(drag.frame);
    const width = drag.width;
    drag = null;
    document.documentElement.classList.remove("sidebar-resizing");
    // pointerup 之后 lostpointercapture 还会来一次,drag 已置 null,自然幂等。
    props.onWidthCommit?.(width);
  };
  const onResizePointerDown = (event: PointerEvent): void => {
    if (props.onWidthCommit == null) return;
    const app = appEl();
    if (app == null) return;
    const computed = Number.parseFloat(getComputedStyle(app).getPropertyValue("--sidebar-width"));
    const startWidth = Number.isFinite(computed) ? computed : 288;
    drag = { startX: event.clientX, startWidth, width: startWidth, frame: 0 };
    document.documentElement.classList.add("sidebar-resizing");
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: PointerEvent): void => {
    if (drag == null) return;
    drag.width = dragSidebarWidth(drag.startX, drag.startWidth, event.clientX);
    if (drag.frame === 0) {
      drag.frame = requestAnimationFrame(() => {
        if (drag == null) return;
        drag.frame = 0;
        appEl()?.style.setProperty("--sidebar-width", `${drag.width}px`);
      });
    }
  };
  const onResizeKeyDown = (event: KeyboardEvent): void => {
    if (props.onWidthCommit == null) return;
    const base = props.width ?? 288;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      props.onWidthCommit(clampSidebarWidth(base + (event.key === "ArrowRight" ? SIDEBAR_WIDTH_STEP : -SIDEBAR_WIDTH_STEP)));
    } else if (event.key === "Home") {
      event.preventDefault();
      props.onWidthCommit(null);
    }
  };

  /* ── 2×2 主导航的 WinUI 选中指示器(共享 pill)─────────────────────────
   * 同一驱动器;网格里的换位分类:同列 = 同级滑动(拉伸-跳变-收回),
   * 跨列 = 跨层级交换(WinUI non-same-level:600ms 线性收缩/生长)。
   * 收起成图标列时所有项同列,自然退化为纯滑动。 */
  const [navGridEl, setNavGridEl] = createSignal<HTMLElement | undefined>();
  const [navGridPillEl, setNavGridPillEl] = createSignal<HTMLElement | undefined>();
  createSelectionPill({
    container: navGridEl,
    pill: navGridPillEl,
    selection: () => props.section,
    findTarget: (el) => el.querySelector<HTMLElement>('.sidebar-nav-item[aria-current="page"]'),
    observe: (el) => [...el.querySelectorAll(".sidebar-nav-item")],
    classify: (from, to) => (from.offsetLeft === to.offsetLeft ? "slide" : "swap"),
  });

  /* ── 设置分区导航的 WinUI 选中指示器(共享 pill)────────────────────────
   * 驱动逻辑在 ./selection-pill(设置导航与会话列表共用同一套 600ms
   * 拉伸-跳变-收回公式);这里只声明容器、选择键与目标定位。ref 走 signal
   * 而非裸变量:导航在 `<Show>` 里,离开设置页会卸载,裸变量赋值无响应性。 */
  const [settingsNavEl, setSettingsNavEl] = createSignal<HTMLElement | undefined>();
  const [settingsPillEl, setSettingsPillEl] = createSignal<HTMLElement | undefined>();
  createSelectionPill({
    container: settingsNavEl,
    pill: settingsPillEl,
    selection: () => props.settingsSection ?? SETTINGS_NAV[0].id,
    findTarget: (nav, sel) =>
      nav.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(sel)}"]`),
    observe: (nav) => [...nav.querySelectorAll(".settings-nav-item, .settings-nav-group")],
  });

  return (
  <aside
    id="app-sidebar"
    ref={asideEl}
    class={{
      "app-sidebar": true,
      collapsed: props.collapsed === true && props.drawer !== true,
      drawer: props.drawer === true,
      open: props.drawer === true && props.drawerOpen === true,
    }}
    aria-label="主导航与会话"
  >
    <nav class="sidebar-nav" aria-label="主导航" ref={setNavGridEl}>
      <span class="sidebar-nav-pill" aria-hidden="true" ref={setNavGridPillEl} />
      <For each={NAV_ITEMS}>
        {(item) => (
          <button
            type="button"
            class={`sidebar-nav-item${props.section === item.id ? " active" : ""}`}
            aria-current={props.section === item.id ? "page" : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => props.onNavigate(item.id)}
          >
            <item.Icon />
            <span>{item.label}</span>
          </button>
        )}
      </For>
    </nav>
    {/* 会话列表只在消息页挂载;props 全部可选透传,stress 夹具与产线共用一份。 */}
    <Show when={props.section === "messages" && props.onSelect != null}>
      <MessageSidebar
        sessions={props.sessions}
        workspaces={props.workspaces}
        activeSeed={props.activeSeed}
        activePending={props.activePending}
        onSelect={props.onSelect!}
        onCreate={props.onCreate}
        onCreateIn={props.onCreateIn}
        creating={props.creating}
        canCreate={props.canCreate}
        onRename={props.onRename}
        onDelete={props.onDelete}
      />
    </Show>
    <Show when={props.section === "settings" && props.onSettingsSection != null}>
      <nav class="sidebar-settings-nav" aria-label="设置分区" ref={setSettingsNavEl}>
        <span class="settings-nav-pill" aria-hidden="true" ref={setSettingsPillEl} />
        <For each={[...SETTINGS_NAV_GROUPS]}>{(group) => <>
          <div class="settings-nav-group">{group}</div>
          <For each={SETTINGS_NAV.filter((item) => item.group === group)}>{(item) =>
            <button type="button" class={`settings-nav-item${(props.settingsSection ?? SETTINGS_NAV[0].id) === item.id ? " active" : ""}`}
              aria-current={(props.settingsSection ?? SETTINGS_NAV[0].id) === item.id ? "page" : undefined}
              data-section-id={item.id} onClick={() => props.onSettingsSection?.(item.id)}>{item.label}</button>
          }</For>
        </>}</For>
      </nav>
    </Show>
    {/* 拖拽调宽把手(用户侧需求):dock 展开态才有(App 传 onWidthCommit);
        收起/抽屉态由 CSS 隐藏。键盘 ←/→ ±16px,Home 恢复默认。 */}
    <Show when={props.onWidthCommit != null}>
      <div
        class="app-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        tabindex={0}
        aria-label="调整侧栏宽度"
        title="拖动调整宽度;拖到最窄即收回。双击恢复默认"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={commitResize}
        onLostPointerCapture={commitResize}
        onDblClick={() => props.onWidthCommit?.(null)}
        onKeyDown={onResizeKeyDown}
      />
    </Show>
  </aside>
  );
};
