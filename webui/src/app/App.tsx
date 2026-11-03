/**
 * 应用壳:标签栏 + 会话视图 + 授权卡 + 输入区(spec §4 布局);
 * 全局快捷键(§5.3)与后台会话轮询。
 *
 * Electron 桌面壳:
 *  - 使用系统标题栏与窗口控制,不让 WebView 内的 Ask 遮罩覆盖窗口按钮;
 *  - 外链经宿主 `open_external` 走系统浏览器(webview 内不导航外站);
 *  - daemon 兼容性失败(D1)渲染明确文案 + 「停止旧实例并连接」动作,
 *    不静默杀旧 daemon(可能正在跑 TUI 的 Turn);
 *  - 设置独立页(spec 第二阶段):Ctrl+, 开关,读写 daemon 全局配置
 *    (`config.load`/`config.save`/`profile.*` 经宿主白名单)。
 */
import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import { invoke, listen, type UnlistenFn } from "../lib/host";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconMenu from "~icons/lucide/menu";
import IconMoreHorizontal from "~icons/lucide/more-horizontal";
import IconListTodo from "~icons/lucide/list-todo";
import IconGamepad2 from "~icons/lucide/gamepad-2";
import { observeShellCols, type ShellCols } from "../lib/shell-cols";
import { restoreSidebarWidth, shouldCollapseSidebar } from "../lib/sidebar-resize";
import IconX from "~icons/lucide/x";
// TabBar is reserved for the future Goal capsule; session navigation lives in Sidebar.
import { Sidebar, type GlobalSection } from "./Sidebar";
import { SessionHeader } from "../session/SessionHeader";
import { ToolsPage } from "./ToolsPage";
import { OAuthPage } from "../oauth/OAuthPage";
import {
  activeId,
  activeTab,
  activateTab,
  boot as bootTabs,
  bootError,
  chooseNewSessionFolder,
  closeTab,
  createSession,
  creating,
  detachSessionFromWorkspace,
  draftOf,
  focusToken,
  isStartup,
  moveSessionToWorkspace,
  newSessionCwd,
  openSession,
  openStartup,
  pollSessions,
  setBootError,
  setDraftOf,
  setNewSessionCwd,
  sessionCatalog,
  stageStartupAttachments,
  tabs,
  type Tab,
  workspaceCatalog,
} from "../tabs/store";
import { SessionView } from "../session/SessionView";
import { StartupView } from "../session/StartupView";
import { WorkspacePanel } from "../workspace/WorkspacePanel";
import { Composer, type SendBlockReason } from "../composer/Composer";
import { bootModelConfig, refreshConfig } from "../composer/model-config";
import { lanActive, refreshLanStatus, sessionWorkspaceName } from "../composer/identity";
import { ApprovalStack } from "../approval/ApprovalCards";
import { SettingsView } from "../settings/SettingsView";
import { OnboardingView } from "../onboarding/OnboardingView";
import { onboardingVisible, refreshOnboarding } from "../onboarding/state";
import { closeDevConsole, devConsoleOpen } from "../lib/devmode";
import {
  cancelReload,
  confirmDiscard as settingsDiscardPending,
  open as settingsOpen,
  reloadPending as settingsReloadPending,
  requestClose as requestSettingsClose,
  save as saveSettings,
  setConfirmDiscard as setSettingsDiscardPending,
  toggleSettings,
} from "../settings/store";
import { STR } from "../lib/strings";
import { isScreenshotShortcut, screenshotSupported, takeScreenshot } from "../lib/screenshot";
import { isDesktopRuntime, openExternalUrl, transport, desktopHostSurface } from "../lib/transport";
import { desktopHost } from "../lib/desktop-host";
import {
  hostActionNote,
  hostError,
  hostIncompatible,
  initHostStatus,
  setHostActionNote,
  setHostError,
  setHostIncompatible,
} from "../lib/host-status";
import { applyTheme, storedTheme } from "../lib/theme";
import { applyGpuPerfHint } from "../lib/visual";
import {
  dispatchGamepadAction,
  GamepadController,
  gamepadPrompts,
  supportsGamepadActions,
  type GamepadAction,
  type GamepadDeviceState,
} from "../lib/gamepad";
import { notifyConfigChanged, onConfigChanged } from "../lib/config-events";
import { toast, ToastHost } from "../ui/toast";
import { buildContextMenu, ContextMenuHost, openContextMenu, type ContextMenuItem } from "../ui/contextMenu";
import { DiffReviewDrawer } from "../diff/DiffReviewDrawer";
import "../styles/app.css";

const isDesktop = isDesktopRuntime();

/**
 * 应用内截图可用性(宿主形态 + 平台)。按钮出不出、快捷键响不响都读这一句,
 * 免得出现"按了没反应"那种最难查的坏控件。
 */
const shotSupported = screenshotSupported({
  desktop: isDesktop,
  userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
});

/** 「设置」刻意不在这个信号里：它是浮层页（见 `settings/store`）。 */
const [section, setSection] = createSignal<Exclude<GlobalSection, "settings">>("messages");

/* 侧栏收展(汉堡):记忆到 localStorage,与 MessageSidebar 的工作区分组折叠键分开。 */
const SIDEBAR_COLLAPSED_KEY = "qaqh.app-sidebar.collapsed";
const readSidebarCollapsed = (): boolean => {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
};
const [sidebarCollapsed, setSidebarCollapsed] = createSignal<boolean>(readSidebarCollapsed());
/* 侧栏拖拽调宽(用户侧需求):宽度记忆在 localStorage;拖拽路径不进 signal
   (Sidebar 直写 #app 内联变量),松手才 commit——低于收回阈值等效汉堡收回,
   收拢动画由 #app 的 grid 轨道过渡播出。 */
const SIDEBAR_WIDTH_KEY = "qaqh.app-sidebar.width";
const readSidebarWidth = (): number | null => {
  try { return restoreSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY)); } catch { return null; }
};
const [sidebarWidth, setSidebarWidth] = createSignal<number | null>(readSidebarWidth());
const commitSidebarWidth = (width: number | null): void => {
  if (width != null && shouldCollapseSidebar(width)) {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch {}
    setSidebarWidth(width);
    setSidebarCollapsed(true);
    return;
  }
  try {
    if (width == null) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {}
  setSidebarWidth(width);
  if (width != null) setSidebarCollapsed(false);
};
/* 阶段5 断点与抽屉(spec §4.6):cols 由 #app 实宽 ResizeObserver 驱动;
   抽屉是会话级状态(不落盘),Esc/遮罩/触发钮三路可关。 */
const [appCols, setAppCols] = createSignal<ShellCols>(3);
const [sidebarDrawerOpen, setSidebarDrawerOpen] = createSignal(false);
const [railDrawerOpen, setRailDrawerOpen] = createSignal(false);
/* 右栏手动开合(BUG-2026-10-29 顶栏主动展开钮):TopBar 任务钮与面板头部按钮
   共享这一份,null=回自动(有待办自动展开);持久化,跨会话记忆用户偏好。 */
const RAIL_MANUAL_KEY = "qaqh.rail.manual";
const readRailManual = (): boolean | null => {
  try {
    const raw = localStorage.getItem(RAIL_MANUAL_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch { return null; }
};
const [railManual, setRailManualSignal] = createSignal<boolean | null>(readRailManual());
const setRailManual = (value: boolean | null): void => {
  setRailManualSignal(value);
  try {
    if (value == null) localStorage.removeItem(RAIL_MANUAL_KEY);
    else localStorage.setItem(RAIL_MANUAL_KEY, value ? "1" : "0");
  } catch {}
};
/* docked 态右栏当前是否展开(手动优先,否则按自动规则:有待办就展开)。 */
const railDockedOpen = (): boolean => railManual() ?? (activeTab()?.store.todos[0]().length ?? 0) > 0;
const toggleRail = (): void => setRailManual(!railDockedOpen());
const toggleSidebar = (): void => {
  setSidebarCollapsed((value) => {
    const next = !value;
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0"); } catch {}
    return next;
  });
};
const [emptyDraft, setEmptyDraft] = createSignal("");

/** 一键停止旧 daemon(不静默杀:Busy 时给动作文案)→ 重启标签引导。 */
async function stopStaleAndReconnect(): Promise<void> {
  const host = desktopHostSurface(transport);
  if (host == null) return;
  setHostActionNote(STR.incompatibleStopping);
  try {
    const status = await host.stopStaleDaemon();
    if (status === "busy") {
      setHostActionNote(STR.incompatibleBusy);
      return;
    }
    setHostIncompatible(null);
    setHostActionNote(null);
    // 停止是异步收敛:稍候让 boot 重新走 discovery(旧记录已消失 → 拉起 sidecar)。
    setTimeout(() => void bootTabs().catch(() => setBootError(STR.bootFailed)), 800);
  } catch (error) {
    setHostActionNote(`${STR.hostError}:${String(error instanceof Error ? error.message : error)}`);
  }
}

const App: Component = () => {
  const [quitPrompt, setQuitPrompt] = createSignal<number | null | undefined>(undefined);
  const [quitConfirmStop, setQuitConfirmStop] = createSignal(false);
  const [quitBusy, setQuitBusy] = createSignal(false);
  const [quitError, setQuitError] = createSignal<string | null>(null);
  /** 打开设置时要落的导航分区；`undefined` = 用设置页自己的默认分区。 */
  const [settingsSection, setSettingsSection] = createSignal<string | undefined>(undefined);
  /** 同一个分区再次被请求时也要能切回去（设置页已打开、用户手动导航过）。 */
  const [settingsSectionNonce, setSettingsSectionNonce] = createSignal(0);
  /** 重连倒计时的每秒心跳:仅在活动标签 reconnecting 期间运转(见 connectionNotice)。 */
  const [reconnectTick, setReconnectTick] = createSignal(0);
  let reconnectTickTimer: number | null = null;
  let quitCancelButton: HTMLButtonElement | undefined;

  /** 系统准星占着屏幕:一次只允许一个截图动作在飞。 */
  const [shotBusy, setShotBusy] = createSignal(false);
  const [gamepadMode, setGamepadMode] = createSignal(false);
  const [gamepadDevice, setGamepadDevice] = createSignal<GamepadDeviceState>({
    connected: false, id: "", mapping: "", family: "generic",
  });
  const gamepadHints = () => gamepadPrompts(gamepadDevice().family);
  const toggleGamepadMode = (): void => { setGamepadMode((value) => !value); };
  const approvalOpen = (): boolean => (activeTab()?.store.pending[0]().length ?? 0) > 0;

  /**
   * 截一张图,落到**当前正在用的那个输入区**:
   *  - Startup(会话还没建)→ 暂存路径,随首条消息一起上传(`submitStartupSession`);
   *  - 有活动会话 → 直接走附件面,变成输入区里的 chip。
   *
   * 三种结局分开说话:取消不该弹错误,失败不该静默,成功要说清挂上了哪一张——
   * 用户按完键需要立刻知道图到手了没有。
   */
  const screenshot = async (): Promise<void> => {
    if (!shotSupported || shotBusy()) return;
    setShotBusy(true);
    try {
      const outcome = await takeScreenshot("selection");
      if (outcome.kind === "cancelled") {
        toast(STR.shotCancelled, "info", { dedupeKey: "screenshot" });
        return;
      }
      if (outcome.kind === "permission") {
        // 直接把「屏幕录制」设置面板送到用户面前(opener 对 x-apple. 深链走系统打开)。
        void openExternalUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        toast(STR.shotPermission, "info", { dedupeKey: "screenshot" });
        return;
      }
      if (outcome.kind === "failed") {
        toast(`${STR.shotFailed}:${outcome.message}`, "err", { dedupeKey: "screenshot" });
        return;
      }
      const path = outcome.shot.path;
      const tab = activeTab();
      try {
        if (isStartup() || tab == null) stageStartupAttachments([path]);
        else await tab.store.attachPaths([path]);
      } catch (cause) {
        // 挂不上(离线/seed 没了)要出声:图已经在临时目录里,丢了用户不知道。
        toast(`${STR.shotFailed}:${cause instanceof Error ? cause.message : String(cause)}`, "err", {
          dedupeKey: "screenshot",
        });
        return;
      }
      toast(STR.shotAttached(outcome.shot.name), "ok", { dedupeKey: "screenshot" });
    } finally {
      setShotBusy(false);
    }
  };

  const moveGamepadFocus = (direction: "up" | "down" | "left" | "right"): void => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
    const area = document.getElementById("messages");
    if (area == null) return;
    const items = Array.from(area.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], [role="button"], [tabindex]:not([tabindex="-1"])',
    )).filter((item) =>
      item.getClientRects().length > 0 &&
      item.getAttribute("aria-hidden") !== "true" &&
      item.closest("[inert]") == null,
    );
    if (items.length === 0) return;
    const current = items.indexOf(active as HTMLElement);
    const delta = direction === "up" || direction === "left" ? -1 : 1;
    const nextIndex = current < 0 ? (delta > 0 ? 0 : items.length - 1) : current + delta;
    items[Math.min(items.length - 1, Math.max(0, nextIndex))]?.focus();
  };

  const handleGamepadAction = (action: GamepadAction): void => {
    if (action.kind === "toggle-mode") {
      toggleGamepadMode();
      return;
    }
    if (!gamepadMode()) return;
    if (action.kind === "move") {
      if (approvalOpen()) {
        dispatchGamepadAction(action); // AskCard owns option navigation while the modal is open.
        return;
      }
      moveGamepadFocus(action.direction);
      return;
    }
    if (approvalOpen()) {
      if (action.kind === "confirm" || action.kind === "cancel") {
        dispatchGamepadAction(action); // Modal card gives A/B their scoped semantics.
      }
      return; // Never send/focus/toggle the underlying composer or panel under a modal.
    }
    if (settingsOpen() || onboardingVisible() || quitPrompt() !== undefined) return;
    if (action.kind === "toggle-panel") {
      if (section() === "messages" && !isStartup()) {
        if (appCols() < 3) setRailDrawerOpen((value) => !value);
        else toggleRail();
      }
    } else if (action.kind === "focus-composer") {
      dispatchGamepadAction(action);
    } else if (action.kind === "send") {
      dispatchGamepadAction(action); // Composer only sends while its text area owns focus.
    } else if (action.kind === "confirm") {
      const target = document.activeElement;
      if (target instanceof HTMLButtonElement && !target.disabled) target.click();
    } else if (action.kind === "cancel") {
      if (railDrawerOpen() || sidebarDrawerOpen()) closeDrawers();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  };

  onSettled(() => {
    const gamepad = new GamepadController(
      () => gamepadMode() && !settingsOpen() && !onboardingVisible() && quitPrompt() === undefined,
      (action) => handleGamepadAction(action),
      setGamepadDevice,
    );
    const stopGamepad = gamepad.start();
    void bootTabs().catch((error: unknown) => {
      // boot() 只对「没有可用会话」写 bootError;bootstrap/网络异常在此兜底,
      // 给出可执行的下一步(§16 错误文案),而不是静默空屏。
      console.error(error);
      setBootError(STR.bootFailed);
    });
    // 后台标签状态点(§5.2):轮询 sessions 列表(turn_count/running/title)。
    const poll = setInterval(() => void pollSessions(), 15_000);
    // 身份行的局域网判据读一次就够:开/关局域网都要重启 daemon,那是设置页的动作。
    void refreshLanStatus();
    // 模型与推理强度是**全局配置**的投影:不预读,输入区那颗强度 chip 首帧就只能按
    // "档位表第一档"画——把"还没读到"冒充成「轻度」。旧行为是等用户点开卡片才读,
    // 于是"默认轻度、点进去才变真值"。配置是 daemon 全局态,读它不该等一次点击。
    void bootModelConfig();
    // 首次引导读的是同一份 profiles.toml：没有可用默认存档就弹全屏引导。
    void refreshOnboarding();
    // 设置页 / 接入页 / 引导自身的写成功后都会广播；配置一落地，引导门自己消失。
    const unlistenConfig = onConfigChanged(() => {
      void refreshConfig();
      void refreshOnboarding();
    });
    const onFocus = (): void => {
      void pollSessions();
      // 窗口重新聚焦时重读一次配置:别的端(TUI / 手改 config.toml / 设置页另一台)
      // 可能刚改过 model 与强度,chip 不该继续显示上次那一份。
      void refreshConfig();
      // 同一份配置还有第二个镜像:上下文百分比的分母(`SessionStore.contextLength`)。
      // 它没有自己的轮询,靠这条广播跟着刷新——否则手改 config.toml 里的
      // context_length 要等下一轮结束才反映到百分比上。
      notifyConfigChanged();
      const tab = activeTab();
      // reconnecting 也重试:状态可能因事件竞态/退避中卡在中间态,
      // 聚焦触发宿主重建流(activate_timeline 会发新 open 事件自愈)。
      if (tab != null && tab.store.connection[0]() !== "connected") tab.store.retry();
    };
    window.addEventListener("focus", onFocus);

    // 主题:本地偏好优先(即时生效,不闪);从未设置过才取一次 daemon 现值
    // 做迁移——老用户的主题存在 daemon 配置里,不能因为搬迁丢掉。
    const stored = storedTheme();
    if (stored != null) {
      applyTheme(stored, false);
    } else {
      void transport
        .query<{ theme: string | null }>({ type: "config.load" })
        .then((config) => applyTheme(config.theme, false))
        .catch(() => {});
    }

    // Electron:外链一律走系统浏览器;宿主诊断事件(兼容性失败/宿主错误/liveness)。
    let unlistenHost: (() => void) | null = null;
    let unlistenQuit: UnlistenFn | null = null;
    let onClickCleanup: (() => void) | null = null;
    let stopCols: (() => void) | null = null;
    {
      // 阶段5:壳断点按 #app 实宽切 3/2/1 列(spec §4.6),列态进信号。
      const appEl = document.getElementById("app");
      if (appEl != null) stopCols = observeShellCols(appEl, { withClasses: false, onChange: setAppCols });
    }
    if (isDesktop) {
      void listen<void>("app://quit-requested", () => openQuitDialog()).then((unlisten) => {
        unlistenQuit = unlisten;
      });

      const onClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        const anchor = target?.closest("a[href]");
        const href = anchor?.getAttribute("href") ?? "";
        if (!/^https?:\/\//i.test(href)) return;
        event.preventDefault();
        void openExternalUrl(href);
      };
      document.addEventListener("click", onClick, true);
      onClickCleanup = () => document.removeEventListener("click", onClick);
      void initHostStatus().then((unlisten) => {
        unlistenHost = unlisten;
      }).catch((error: unknown) => {
        console.warn("[qaqh-webui] failed to subscribe host diagnostics", error);
      });
      // GPU 后端探针:软渲染时 auto 性能档自动降档(见 lib/visual.ts)。
      void applyGpuPerfHint();
    }

    // 全局快捷键(§5.3)。
    const onKey = (event: KeyboardEvent): void => {
      // 首次引导遮罩在最高层：应用快捷键全部让路（不 preventDefault，输入框照常打字）。
      if (onboardingVisible()) return;
      if (quitPrompt() !== undefined && event.key === "Escape") {
        event.preventDefault();
        setQuitPrompt(undefined);
        setQuitConfirmStop(false);
        return;
      }
      // 控制台在设置浮层之上:ESC 先退一层,而不是连设置一起关掉。
      if (event.key === "Escape" && devConsoleOpen()) {
        event.preventDefault();
        closeDevConsole();
        return;
      }
      // 阶段5:抽屉 Esc 只关一层,优先级在设置浮层之前(抽屉开着时设置必然是关的)。
      if (event.key === "Escape" && (railDrawerOpen() || sidebarDrawerOpen())) {
        event.preventDefault();
        closeDrawers();
        return;
      }
      // 截图键放在设置浮层的分支**之前**:设置页正是最需要截图的地方(OAuth/BYOK
      // 那批字段都在那儿),浮层开着时也该能截。唯一让路的是上面的退出确认遮罩。
      if (isScreenshotShortcut(event)) {
        event.preventDefault();
        void screenshot();
        return;
      }
      // 阶段1(spec §5.5):application menu 已摘除,这两个加速键由 renderer 键盘
      // 接管,与 ⋯ 菜单的 hint 同源。放在设置分支之前:picker/退出是全局动作。
      const accel = event.ctrlKey || event.metaKey;
      if (accel && event.shiftKey && (event.key === "M" || event.key === "m")) {
        event.preventDefault();
        openProfilesSettings();
        return;
      }
      if (accel && !event.shiftKey && (event.key === "q" || event.key === "Q")) {
        event.preventDefault();
        openQuitDialog();
        return;
      }
      // 浮层开着时快捷键归浮层:Ctrl+T/W/Tab/1-9 不该在遮罩背后建会话、切标签。
      if (settingsOpen()) {
        const modKey = event.ctrlKey || event.metaKey;
        if (event.key === "Escape") {
          event.preventDefault();
          // 先退一层：重新读取确认 → 放弃确认 → 整页关闭。
          if (settingsReloadPending()) cancelReload();
          else if (settingsDiscardPending()) setSettingsDiscardPending(false);
          else requestSettingsClose();
          return;
        }
        if (modKey && (event.key === "," || event.key === "s" || event.key === "S")) {
          event.preventDefault();
          if (event.key === ",") requestSettingsClose();
          else void saveSettings();
          return;
        }
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === ",") {
        event.preventDefault();
        setSettingsSection(undefined);
        toggleSettings();
        return;
      }
      if (!mod) return;
      if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        setSection("messages");
        void createSession();
      } else if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        setSection("messages");
        const id = activeId();
        if (id != null) {
          void closeTab(id);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".message-session-item.active")?.focus());
        }
      } else if (event.key === "Tab") {
        event.preventDefault();
        const list = tabs();
        if (list.length < 2) return;
        setSection("messages");
        const index = list.findIndex((tab) => tab.id === activeId());
        const next = event.shiftKey
          ? list[(index - 1 + list.length) % list.length]!
          : list[(index + 1) % list.length]!;
        void activateTab(next);
      } else if (/^[1-9]$/.test(event.key)) {
        const list = tabs();
        const target = list[Number(event.key) - 1];
        if (target != null) {
          event.preventDefault();
          setSection("messages");
          void activateTab(target);
        }
      }
    };
    // 全局右键：原生「重新加载 / 后退 / 检查元素」菜单必须干掉（Reload 会丢未发送
    // 草稿与流式回合），但一刀切会把「复制」也一起删掉——选中文字后只剩 Ctrl+C
    // 一条暗路。所以改成：能给出编辑动作就拦下来弹**应用内**菜单（见
    // ui/contextMenu.tsx），给不出（空白处、可编辑区、已被更具体组件接走）就不拦。
    const onContextMenu = (event: MouseEvent): void => {
      const menu = buildContextMenu(event);
      if (menu == null) return;
      event.preventDefault();
      openContextMenu(menu);
    };
    window.addEventListener("contextmenu", onContextMenu);

    window.addEventListener("keydown", onKey);
    // onSettled 作用域禁止 onCleanup(rc.13:CLEANUP_IN_FORBIDDEN_SCOPE)——
    // 返回清理函数,由 owner disposal 调用。
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKey);
      stopGamepad();
      stopCols?.();
      onClickCleanup?.();
      unlistenConfig();
      unlistenHost?.();
      unlistenQuit?.();
    };
  });

  const finishExit = async (stopDaemon: boolean, stopActiveWork = false): Promise<void> => {
    if (quitBusy()) return;
    setQuitBusy(true);
    setQuitError(null);
    try {
      const host = desktopHost();
      if (host != null) {
        await host.requestQuit({ stopDaemon, stopActiveWork });
      } else {
        await invoke("exit_app", { stopDaemon, stopActiveWork });
      }
    } catch (cause) {
      setQuitError(cause instanceof Error ? cause.message : String(cause));
      setQuitBusy(false);
    }
  };

  const active = (): ReturnType<typeof activeTab> => activeTab();

  const blockedReason = (tab: Tab | null = active()): SendBlockReason => {
    if (tab == null) return "offline";
    if (tab.store.connection[0]() !== "connected") return "offline";
    if (tab.store.pending[0]().length > 0) return "pending";
    // 运行态读 reducer 维护的计数与乐观发送态:遍历 turns 会让输入区订阅每一个回合,
    // 于是每帧流式写入都重算一次发送按钮(高吞吐下的卡顿放大器)。
    if (tab.store.isSending[0]() || tab.store.state[0].runningTurns > 0 || tab.store.activity[0]() === "working") return "running";
    return null;
  };

  const runningNow = (tab: Tab | null = active()): boolean => {
    if (tab == null) return false;
    return tab.store.isSending[0]() || tab.store.state[0].runningTurns > 0 || tab.store.activity[0]() === "working";
  };

  // 倒计时心跳:只在活动标签 reconnecting 时运转,其余时间零定时器。
  createEffect(
    () => activeTab()?.store.connection[0]() === "reconnecting",
    (reconnecting) => {
      if (reconnecting && reconnectTickTimer == null) {
        reconnectTickTimer = window.setInterval(() => setReconnectTick((value) => value + 1), 1000);
      } else if (!reconnecting && reconnectTickTimer != null) {
        clearInterval(reconnectTickTimer);
        reconnectTickTimer = null;
      }
    },
  );

  const connectionNotice = (): string | null => {
    const error = bootError() ?? hostError();
    if (error != null) return error;
    const tab = activeTab();
    if (tab == null) return null;
    const state = tab.store.connection[0]();
    if (state === "reconnecting") {
      const info = tab.store.reconnect[0]();
      if (info != null) {
        void reconnectTick();
        // 宿主 `at` 是调度时刻(types.ts 注释即"renderer can age the notice"):
        // 倒计时按 at+delayMs 与本机钟实时递减,而不是冻结在调度值;已到期按 1 秒显示。
        const remainingMs = info.at + info.delayMs - Date.now();
        return STR.networkReconnecting(info.attempt, Math.max(1, Math.ceil(remainingMs / 1000)));
      }
      return STR.reconnecting;
    }
    return state === "connected" ? null : STR.disconnected;
  };

  createEffect(
    () => [activeTab(), emptyDraft()] as const,
    ([tab, pendingDraft]) => {
      if (tab != null && pendingDraft !== "") {
        setDraftOf(tab.seed, pendingDraft);
        setEmptyDraft("");
      }
    },
  );

  const retryConnection = (): void => {
    setBootError(null);
    setHostError(null);
    const tab = activeTab();
    if (tab != null) {
      tab.store.retry();
      return;
    }
    void bootTabs().catch((error: unknown) => {
      setBootError(String(error instanceof Error ? error.message : error));
    });
  };

  const openSettingsAt = (sectionId: string): void => {
    setSettingsSection(sectionId);
    setSettingsSectionNonce((value) => value + 1);
    if (!settingsOpen()) toggleSettings();
  };

  const openProfilesSettings = (): void => {
    openSettingsAt("section-profiles");
  };

  /** 退出确认对话框:⋯菜单、Ctrl+Q、主进程 quit-requested 三条入口共用这一份。 */
  const openQuitDialog = (): void => {
    setQuitConfirmStop(false);
    setQuitError(null);
    void transport.query<Array<{ state?: string }>>({ type: "session.activity" })
      .then((activities) => {
        const activeCount = activities.filter((item) =>
          item.state === "starting" || item.state === "working" || item.state === "waiting_user",
        ).length;
        setQuitPrompt(activeCount);
        requestAnimationFrame(() => quitCancelButton?.focus());
      })
      .catch(() => {
        setQuitPrompt(null);
        requestAnimationFrame(() => quitCancelButton?.focus());
      });
  };

  /**
   * 壳层 ⋯ 菜单(spec §5.5 阶段1):application menu 的动作在此全部可达,
   * 复用应用内右键菜单宿主(定位/键盘/外点关闭都已有行为)。
   */
  const openShellMenu = (anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      { kind: "action", label: "管理存档…", hint: "Ctrl+Shift+M", onSelect: () => openProfilesSettings() },
      { kind: "separator" },
      {
        kind: "action",
        label: "设置…",
        hint: "Ctrl+,",
        onSelect: () => { setSettingsSection(undefined); if (!settingsOpen()) toggleSettings(); },
      },
      {
        kind: "action",
        label: "关于 QAQ-Harness",
        onSelect: () => openSettingsAt("section-about"),
      },
      { kind: "separator" },
      { kind: "action", label: "退出…", hint: "Ctrl+Q", onSelect: () => openQuitDialog() },
    ];
    openContextMenu({ x: rect.right - 220, y: rect.bottom + 6, items });
  };

  /* 阶段5 抽屉:触发钮引用(关闭后回焦),汉堡在 cols=1 时开抽屉而非收窄。 */
  let hamburgerButton: HTMLButtonElement | undefined;
  let railTriggerButton: HTMLButtonElement | undefined;
  const closeDrawers = (): void => {
    if (railDrawerOpen()) {
      setRailDrawerOpen(false);
      railTriggerButton?.focus();
      return;
    }
    if (sidebarDrawerOpen()) {
      setSidebarDrawerOpen(false);
      hamburgerButton?.focus();
    }
  };
  const sidebarButtonTitle = (): string =>
    appCols() === 1
      ? (sidebarDrawerOpen() ? "关闭菜单" : "打开菜单")
      : (sidebarCollapsed() ? "展开侧栏" : "收起侧栏");
  const onHamburger = (): void => {
    if (appCols() === 1) {
      setSidebarDrawerOpen((value) => !value);
      return;
    }
    toggleSidebar();
  };

  // Keep the tray tooltip in sync with the active tab's connection / retry
  // state. This is intentionally best-effort; a missing tray is not an error.
  createEffect(
    () => [activeTab(), connectionNotice(), activeTab()?.store.providerRetry[0]()] as const,
    () => {
      const controls = desktopHost()?.windowControls;
      if (controls == null) return;
      const retry = activeTab()?.store.providerRetry[0]();
      const text = retry != null
        ? `上游重试 ${retry.attempt}/${retry.maxRetries}`
        : connectionNotice() ?? "就绪";
      void controls.setTrayStatus(`QAQ-Harness · ${text}`).catch(() => {});
    },
  );

  const navigateSection = (next: GlobalSection): void => {
    if (next === "settings") {
      setSettingsSection(undefined);
      if (settingsOpen()) requestSettingsClose();
      else toggleSettings();
      return;
    }
    if (settingsOpen()) requestSettingsClose();
    setSection(next);
  };

  const send = async (tab: Tab, text: string): Promise<void> => {
    try {
      await tab.store.sendMessage(text);
      // A slow acknowledgement must not erase text typed for the next message.
      if (draftOf(tab.seed) === text) setDraftOf(tab.seed, "");
    } catch (error) {
      toast(`${STR.sendFailed}：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  /**
   * 会话级换 profile(§1.5)。失败必须出声:菜单已关、控件回到旧值,
   * 不提示就等于「点了没反应」。
   */
  const switchProfile = async (tab: Tab, name: string | null): Promise<void> => {
    try {
      await tab.store.setSessionProfile(name);
    } catch (error) {
      toast(`${STR.profileSwitchFailed}：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  const switchEffort = async (tab: Tab, effort: string | null): Promise<void> => {
    try {
      await tab.store.setSessionEffort(effort);
    } catch (error) {
      toast(`切换思考强度失败：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  const switchModel = async (tab: Tab, model: string | null): Promise<void> => {
    try {
      await tab.store.setSessionModel(model);
    } catch (error) {
      toast(`切换模型失败：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  const switchMaxTokens = async (tab: Tab, maxTokens: number | null): Promise<void> => {
    try {
      await tab.store.setSessionMaxTokens(maxTokens);
    } catch (error) {
      toast(`切换最大输出失败：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  const switchContextLength = async (tab: Tab, contextLength: number | null): Promise<void> => {
    try {
      await tab.store.setSessionContextLength(contextLength);
    } catch (error) {
      toast(`切换上下文窗口失败：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  /** 会话级换工具模式;失败时 store 已重读 meta 回滚,这里只负责出声。 */
  const switchToolMode = async (tab: Tab, mode: string, customTools: string[]): Promise<void> => {
    try {
      await tab.store.setSessionToolMode(mode, customTools);
    } catch (error) {
      toast(`切换工具模式失败：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  return (
    <div id="app" class={{ "desktop-shell": isDesktop, "sidebar-collapsed": sidebarCollapsed() && appCols() > 1, "cols-3": appCols() === 3, "cols-2": appCols() === 2, "cols-1": appCols() === 1 }}
      style={{ "--sidebar-width": appCols() > 1 && sidebarWidth() != null ? `${sidebarWidth()}px` : undefined }}>
      {/* 三页(消息/工具/设置)共用同一条 48px TopBar:返回按钮只在非根页面出现。 */}
      <header id="top" role="banner" data-desktop-drag-region>
        <div class="topbar-left">
          {/* 汉堡必须在 #top 内:放在 #app 层会被 grid 自动放置丢进空列(曾飘到右上角)。
              cols=1 时它是菜单按钮(开侧栏抽屉),否则是收展开关。 */}
          <button
            type="button"
            class="titlebar-menu"
            ref={hamburgerButton}
            aria-label={sidebarButtonTitle()}
            aria-expanded={appCols() === 1 ? (sidebarDrawerOpen() ? "true" : "false") : (sidebarCollapsed() ? "false" : "true")}
            aria-controls="app-sidebar"
            title={sidebarButtonTitle()}
            onClick={onHamburger}
          >
            <IconMenu />
          </button>
          <Show when={settingsOpen() || section() !== "messages"}>
            <button type="button" class="titlebar-back" aria-label="返回消息" title="返回消息" onClick={() => navigateSection("messages")}>
              <IconArrowLeft />
            </button>
          </Show>
          <Show when={!isDesktop}><div class="titlebar-brand">QAQH</div></Show>
        </div>
        <div class="topbar-center">
          <Show
            when={section() === "messages" && !settingsOpen() && !isStartup() && activeTab() != null}
            fallback={
              <div class="titlebar-session-title">
                {settingsOpen() ? "设置" : section() === "tools" ? "工具" : section() === "oauth" ? "接入" : "新会话"}
              </div>
            }
          >
            {/* 会话标题(双击重命名/⋯菜单)随会话入驻 TopBar(spec §6.4),会话页不再有 40px 标题行。 */}
            <SessionHeader tab={activeTab()!} />
          </Show>
        </div>
        <div class="topbar-right">
          {/* 任务面板开关(BUG-2026-10-29 主动展开钮):全列态可见——cols<3 唤起抽屉,
              cols≥3 直接开合 docked 右栏(与面板头部按钮同态,持久化);badge=待办数。 */}
          <Show when={section() === "messages" && !settingsOpen() && !isStartup() && activeTab() != null}>
            <button
              type="button"
              class={{ "titlebar-menu rail-trigger": true, active: appCols() < 3 ? railDrawerOpen() : railDockedOpen() }}
              ref={railTriggerButton}
              aria-label="任务面板"
              aria-haspopup={appCols() < 3 ? "dialog" : undefined}
              aria-pressed={appCols() < 3 ? undefined : railDockedOpen() ? "true" : "false"}
              title="任务"
              onClick={() => { if (appCols() < 3) setRailDrawerOpen(true); else toggleRail(); }}
            >
              <IconListTodo />
              <Show when={activeTab()!.store.todos[0]().length > 0}>
                <span class="rail-badge">{activeTab()!.store.todos[0]().length}</span>
              </Show>
            </button>
          </Show>
          <button
            type="button"
            class={`titlebar-menu gamepad-mode-button${gamepadMode() ? " active" : ""}`}
            aria-label={gamepadMode() ? "退出手柄模式" : "启用手柄模式"}
            aria-pressed={gamepadMode() ? "true" : "false"}
            title={gamepadMode() ? "退出手柄模式" : "手柄模式"}
            onClick={toggleGamepadMode}
          >
            <IconGamepad2 />
          </button>
          <button
            type="button"
            class="titlebar-menu titlebar-more"
            aria-label="更多应用菜单"
            aria-haspopup="menu"
            title="更多应用菜单"
            onClick={(event) => openShellMenu(event.currentTarget)}
          >
            <IconMoreHorizontal />
          </button>
        </div>
      </header>
      <Sidebar
        section={settingsOpen() ? "settings" : section()}
        onNavigate={navigateSection}
        collapsed={sidebarCollapsed()}
        drawer={appCols() === 1}
        drawerOpen={appCols() === 1 && sidebarDrawerOpen()}
        width={sidebarWidth()}
        onWidthCommit={commitSidebarWidth}
        sessions={sessionCatalog()}
        activeSeed={isStartup() ? null : (activeTab()?.seed ?? null)}
        activePending={() => activeTab()?.store.pending[0]() ?? []}
        onSelect={(seed) => { setSection("messages"); void openSession(seed); }}
        onCreate={() => { setSection("messages"); openStartup(); }}
        creating={creating()}
        canCreate={hostIncompatible() == null}
        onMove={(seed, workspaceId) => { void moveSessionToWorkspace(seed, workspaceId); }}
        onDetach={(seed) => { void detachSessionFromWorkspace(seed); }}
      />
      <div class={settingsOpen() ? "workspace workspace-settings" : "workspace"}>
        <Show when={settingsOpen()} fallback={
          <>
        <div class="workspace-content">
        {/* Reserved for Goal. Do not render the old session capsule for now.
        <div class="session-tabs-region">
        <TabBar
          tabs={tabs()}
          activeId={activeId()}
          creating={creating()}
          canCreate={hostIncompatible() == null}
          onSelect={(id) => {
            setSection("messages");
            const tab = tabs().find((item) => item.id === id);
            if (tab != null) void activateTab(tab);
          }}
          onClose={(id) => void closeTab(id)}
          onCreate={() => {
            setSection("messages");
            void createSession();
          }}
        />
        </div>
        */}
        <main id="main">
          <Show when={hostIncompatible() != null}>
            <div class="host-banner" role="alert">
              <span>
                {STR.incompatibleDaemon(
                  typeof hostIncompatible()!.detail === "string" ? (hostIncompatible()!.detail as string) : "版本/协议不匹配",
                )}
              </span>
              <Show when={hostActionNote() != null}>
                <span class="host-banner-note">{hostActionNote()}</span>
              </Show>
              <span class="host-banner-actions">
                <button type="button" class="ghost-mini" onClick={() => void stopStaleAndReconnect()}>
                  {STR.incompatibleStopAndConnect}
                </button>
                <button type="button" class="ghost-mini" onClick={() => void bootTabs()}>
                  {STR.retry}
                </button>
              </span>
            </div>
          </Show>
          <Show when={section() === "messages"}>
            <Show
              when={!isStartup() && activeTab() != null}
              fallback={
                <div class="session-column">
                  <StartupView
                    onScreenshot={shotSupported ? () => void screenshot() : undefined}
                    onManageProfiles={openProfilesSettings}
                  />
                </div>
              }
            >
              <For each={tabs()}>
                {(tab) => (
                  // 非活动标签卸载 DOM(§5.3),store 数据保留。
                  <Show when={tab.id === activeId()}>
                    <div
                      class="session-column"
                      id={`panel-${tab.id}`}
                      role="region"
                      aria-label={tab.store.title[0]() ?? STR.newTab}
                    >
                      <SessionView tab={tab} />
                      <Show when={tab.store.pending[0]().length > 0}>
                        <ApprovalStack
                          pending={tab.store.pending[0]()}
                          respond={(challengeId, decision, payload) => tab.store.respondApproval(challengeId, decision, payload)}
                          refresh={() => tab.store.refreshApprovals()}
                        />
                      </Show>
                      <Composer
                        draft={() => draftOf(tab.seed)}
                        onDraft={(value) => setDraftOf(tab.seed, value)}
                        blocked={() => blockedReason(tab)}
                        running={() => runningNow(tab)}
                        onSend={(text) => send(tab, text)}
                        /* 返回 promise:Composer 失败时会复位「正在停止」,
                           否则一次投递异常就让停止按钮永久禁用(BUG-2026-10-28)。 */
                        onStop={() => tab.store.cancelTurn()}
                        focusToken={focusToken()}
                        metrics={() => tab.store.composerMetrics[0]()}
                        onCompact={() => void tab.store.compactContext().catch(() => {})}
                        compactPhase={() => tab.store.compact[0]().phase}
                        onPickAttachments={() => void tab.store.addAttachments().catch((error) => {
                          toast(`${STR.attachmentFailed}：${String(error instanceof Error ? error.message : error)}`, "err");
                        })}
                        onScreenshot={shotSupported ? () => void screenshot() : undefined}
                        attachments={() => tab.store.pendingAttachments[0]()}
                        onRemoveAttachment={(id) => tab.store.removeAttachment(id)}
                        profileView={() => tab.store.composerProfile[0]()}
                        onProfile={(name) => void switchProfile(tab, name)}
                        onManageProfiles={openProfilesSettings}
                        modelView={() => tab.store.composerModel[0]()}
                        modelOverridden={() => tab.store.composerModelOverride[0]()}
                        onModel={(model) => switchModel(tab, model)}
                        providerKind={() => tab.store.composerProfile[0]().providerKind}
                        effortView={() => tab.store.composerEffort[0]()}
                        effortOverridden={() => tab.store.composerEffortOverride[0]()}
                        onEffort={(effort) => switchEffort(tab, effort)}
                        maxTokensView={() => tab.store.composerMaxTokens[0]()}
                        onMaxTokens={(maxTokens) => switchMaxTokens(tab, maxTokens)}
                        contextLengthView={() => tab.store.composerContextLength[0]()}
                        onContextLength={(contextLength) => switchContextLength(tab, contextLength)}
                        toolModeView={() => tab.store.composerToolMode[0]()}
                        onToolMode={(mode, customTools) => void switchToolMode(tab, mode, customTools)}
                        /* 新建会话的目标工作区(§1.5):只改「下一条会话落在哪」,
                           当前会话的 cwd 钉在 SessionMeta 上,不在这里动——
                           身份行(下面那行只读文字)说的才是本会话的工作区。 */
                        workspaces={() => workspaceCatalog()}
                        workspacePath={() => newSessionCwd()}
                        onWorkspace={(path) => setNewSessionCwd(path)}
                        onBrowseWorkspace={() => void chooseNewSessionFolder()}
                        sessionWorkspace={() => sessionWorkspaceName(tab.seed)}
                        lanActive={lanActive}
                      />
                    </div>
                  </Show>
                )}
              </For>
            </Show>
          </Show>
          <Show when={section() === "tools"}><ToolsPage /></Show>
          <Show when={section() === "oauth"}><OAuthPage onOpenSettings={() => navigateSection("settings")} /></Show>
        </main>
        </div>
          </>
        }>
          <SettingsView
            initialSection={settingsSection()}
            sectionNonce={settingsSectionNonce()}
            onOpenOAuth={() => navigateSection("oauth")}
          />
        </Show>
      </div>
      {/* 任务右栏(spec §6.3):≥1280 第三列(dock);<1280 常驻挂载为覆盖层抽屉。 */}
      {/* 抽屉面板常驻挂载(cols<3 时为覆盖层):开关由 class 驱动,
          关闭时滑出画面再 display:none(motion kit),退出动画播得出来。 */}
      <Show when={!settingsOpen() && section() === "messages" && !isStartup() && activeTab() != null}>
        <WorkspacePanel store={activeTab()!.store} drawer={appCols() < 3} drawerOpen={railDrawerOpen()} manualOpen={railManual()} onManualToggle={setRailManual} />
      </Show>
      {/* 抽屉遮罩:盖 body 行,点击关闭;TopBar 不被盖住(关闭入口常在)。
          常驻 DOM 只切 .open:开合都有淡入淡出,不用 Show 硬切。 */}
      <div
        class={{ "drawer-mask": true, open: (appCols() === 1 && sidebarDrawerOpen()) || (appCols() < 3 && railDrawerOpen()) }}
        onClick={closeDrawers}
      />
      <Show when={connectionNotice() != null}>
        <div class="connection-notice" role="status" aria-live="polite">
          <span>{connectionNotice()}</span>
          <button type="button" class="ghost-mini" onClick={retryConnection}>{STR.retry}</button>
        </div>
      </Show>
      <Show when={quitPrompt() !== undefined}>
        <div class="quit-overlay" role="presentation">
          <section class="quit-dialog" role="dialog" aria-modal="true" aria-labelledby="quit-dialog-title">
            <header class="quit-dialog-head">
              <strong id="quit-dialog-title">退出 QAQH</strong>
              <button type="button" class="icon-btn" aria-label="取消退出" onClick={() => { setQuitPrompt(undefined); setQuitConfirmStop(false); }} disabled={quitBusy()}>
                <IconX />
              </button>
            </header>
            <div class="quit-dialog-body">
              <Show when={quitPrompt() === null} fallback={
                <Show when={(quitPrompt() ?? 0) > 0} fallback={
                  <>
                    <p>当前没有运行中或等待处理的会话。</p>
                    <p class="quit-dialog-note">停止 daemon 会断开其他客户端；也可以退出 QAQH 并让服务留在后台。</p>
                  </>
                }>
                  <p>有 <b>{quitPrompt()}</b> 个会话正在运行或等待处理。</p>
                  <p class="quit-dialog-note">退出界面会让后台任务继续运行。停止 daemon 会中断所有客户端连接中的会话。</p>
                </Show>
              }>
                <p>暂时无法确认 daemon 的活动状态。为保护后台任务，建议退出界面并让 daemon 继续运行。</p>
                <p class="quit-dialog-note">停止服务选项会保持禁用，直到活动状态可查询。</p>
              </Show>
              <Show when={quitError() != null}><p class="quit-dialog-error" role="alert">{quitError()}</p></Show>
              <Show when={quitConfirmStop()}>
                <div class="quit-stop-confirm" role="alert">
                  <b>确认停止所有后台任务？</b>
                  <p>这会优雅关闭共享 daemon，并中断运行中或等待授权的会话。其他客户端也会断开。</p>
                </div>
              </Show>
            </div>
            <footer class="quit-dialog-actions">
              <Show when={quitConfirmStop()} fallback={
                <>
                  <button ref={quitCancelButton} type="button" class="button-secondary" onClick={() => { setQuitPrompt(undefined); setQuitConfirmStop(false); }} disabled={quitBusy()}>取消</button>
                  <button type="button" class="button-secondary" onClick={() => void finishExit(false)} disabled={quitBusy()}>
                    退出并保留后台任务
                  </button>
                  <Show when={quitPrompt() !== null}>
                    <button type="button" class="button-danger" onClick={() => {
                      if ((quitPrompt() ?? 0) > 0) setQuitConfirmStop(true);
                      else void finishExit(true);
                    }} disabled={quitBusy()}>
                      {(quitPrompt() ?? 0) > 0 ? "停止任务并退出…" : "退出并停止空闲服务"}
                    </button>
                  </Show>
                </>
              }>
                <button ref={quitCancelButton} type="button" class="button-secondary" onClick={() => setQuitConfirmStop(false)} disabled={quitBusy()}>返回</button>
                <button type="button" class="button-danger" onClick={() => void finishExit(true, true)} disabled={quitBusy()}>
                  {quitBusy() ? "正在停止…" : "确认停止并退出"}
                </button>
              </Show>
            </footer>
          </section>
        </div>
      </Show>
      <Show when={gamepadMode()}>
        <div class="gamepad-mode-status" role="status" aria-live="polite">
          <IconGamepad2 />
          <span>{!gamepadDevice().connected ? "等待连接手柄" : supportsGamepadActions(gamepadDevice()) ? "手柄模式" : "手柄已连接 · 控制布局不受支持"}</span>
          <span class="gamepad-mode-hints">
            ↑↓ 导航 · {gamepadHints().confirm} 确认 · {gamepadHints().cancel} 取消 · {gamepadHints().send} 发送 · {gamepadHints().panel} 任务 · {gamepadHints().focus} 输入
          </span>
          <button type="button" aria-label="退出手柄模式" onClick={toggleGamepadMode}>退出</button>
        </div>
      </Show>
      <DiffReviewDrawer />
      <ContextMenuHost />
      <ToastHost />
      <Show when={onboardingVisible()}>
        <OnboardingView onOpenSettings={() => openSettingsAt("section-profiles")} />
      </Show>
    </div>
  );
};

export default App;
