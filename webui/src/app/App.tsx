/**
 * 应用壳:标签栏 + 会话视图 + 授权卡 + 输入区(spec §4 布局);
 * 全局快捷键(§5.3)与后台会话轮询。
 *
 * Tauri 桌面壳:
 *  - 使用系统标题栏与窗口控制,不让 WebView 内的 Ask 遮罩覆盖窗口按钮;
 *  - 外链经宿主 `open_external` 走系统浏览器(webview 内不导航外站);
 *  - daemon 兼容性失败(D1)渲染明确文案 + 「停止旧实例并连接」动作,
 *    不静默杀旧 daemon(可能正在跑 TUI 的 Turn);
 *  - 设置独立页(spec 第二阶段):Ctrl+, 开关,读写 daemon 全局配置
 *    (`config.load`/`config.save`/`profile.*` 经宿主白名单)。
 */
import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconX from "~icons/lucide/x";
// TabBar is reserved for the future Goal capsule; session navigation lives in MessageSidebar.
import { MessageSidebar } from "./MessageSidebar";
import { GlobalNav, type GlobalSection } from "./GlobalNav";
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
import { isTauriRuntime, listenHostDiagnostics, openExternalUrl, transport, tauriHost } from "../lib/transport";
import { applyTheme, storedTheme } from "../lib/theme";
import { notifyConfigChanged } from "../lib/config-events";
import { toast, ToastHost } from "../ui/toast";
import { buildContextMenu, ContextMenuHost, openContextMenu } from "../ui/contextMenu";
import { DiffReviewDrawer } from "../diff/DiffReviewDrawer";
import "../styles/app.css";

const inTauri = isTauriRuntime();

/**
 * 应用内截图可用性(宿主形态 + 平台)。按钮出不出、快捷键响不响都读这一句,
 * 免得出现"按了没反应"那种最难查的坏控件。
 */
const shotSupported = screenshotSupported({
  inTauri,
  userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
});

/** D1 兼容性失败详情(conn://incompatible);null = 正常。 */
const [hostIncompatible, setHostIncompatible] = createSignal<Record<string, unknown> | null>(null);
const [hostActionNote, setHostActionNote] = createSignal<string | null>(null);
/** 「设置」刻意不在这个信号里：它是浮层页（见 `settings/store`）。 */
const [section, setSection] = createSignal<Exclude<GlobalSection, "settings">>("messages");
const [emptyDraft, setEmptyDraft] = createSignal("");

/** 一键停止旧 daemon(不静默杀:Busy 时给动作文案)→ 重启标签引导。 */
async function stopStaleAndReconnect(): Promise<void> {
  const host = tauriHost(transport);
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
  let quitCancelButton: HTMLButtonElement | undefined;

  /** 系统准星占着屏幕:一次只允许一个截图动作在飞。 */
  const [shotBusy, setShotBusy] = createSignal(false);

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

  onSettled(() => {
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
        .rpc<{ theme: string | null }>("config.load")
        .then((config) => applyTheme(config.theme, false))
        .catch(() => {});
    }

    // Tauri:外链一律走系统浏览器;宿主诊断事件(兼容性失败/宿主错误)。
    let unlistenHost: (() => void) | null = null;
    let unlistenQuit: UnlistenFn | null = null;
    let onClickCleanup: (() => void) | null = null;
    if (inTauri) {
      void listen<void>("app://quit-requested", () => {
        setQuitConfirmStop(false);
        setQuitError(null);
        void transport.rpc<Array<{ state?: string }>>("session.activity")
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
      }).then((unlisten) => {
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
      void listenHostDiagnostics({
        onIncompatible: (details) => {
          setHostActionNote(null);
          setHostIncompatible(details);
        },
        onHostError: (message) => setBootError(message),
      }).then((unlisten) => {
        unlistenHost = unlisten;
      });
    }

    // 全局快捷键(§5.3)。
    const onKey = (event: KeyboardEvent): void => {
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
      // 截图键放在设置浮层的分支**之前**:设置页正是最需要截图的地方(OAuth/BYOK
      // 那批字段都在那儿),浮层开着时也该能截。唯一让路的是上面的退出确认遮罩。
      if (isScreenshotShortcut(event)) {
        event.preventDefault();
        void screenshot();
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
      onClickCleanup?.();
      unlistenHost?.();
      unlistenQuit?.();
    };
  });

  const finishExit = async (stopDaemon: boolean, stopActiveWork = false): Promise<void> => {
    if (quitBusy()) return;
    setQuitBusy(true);
    setQuitError(null);
    try {
      await invoke("exit_app", { stopDaemon, stopActiveWork });
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

  const connectionNotice = (): string | null => {
    const error = bootError();
    if (error != null) return error;
    const tab = activeTab();
    if (tab == null) return null;
    const state = tab.store.connection[0]();
    if (state === "reconnecting") return STR.reconnecting;
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
    const tab = activeTab();
    if (tab != null) {
      tab.store.retry();
      return;
    }
    void bootTabs().catch((error: unknown) => {
      setBootError(String(error instanceof Error ? error.message : error));
    });
  };

  const navigateSection = (next: GlobalSection): void => {
    if (next === "settings") {
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

  return (
    <div id="app" class={{ "tauri-shell": inTauri }}>
      {/* 三页(消息/工具/设置)共用同一条 40px 标题栏:返回按钮只在非根页面出现。
          消息页此前在原生壳里整行塌掉,切页会让左侧导航与内容整体跳 40px。 */}
      <header id="top" data-tauri-drag-region>
        <Show when={settingsOpen() || section() !== "messages"}>
          <button type="button" class="titlebar-back" aria-label="返回消息" title="返回消息" onClick={() => navigateSection("messages")}>
            <IconArrowLeft />
          </button>
        </Show>
        <Show when={!inTauri}><div class="titlebar-brand">QAQH</div></Show>
        <div class="titlebar-session-title">{settingsOpen() ? "设置" : section() === "tools" ? "工具" : section() === "oauth" ? "接入" : "消息"}</div>
      </header>
      <GlobalNav
        active={settingsOpen() ? "settings" : section()}
        onNavigate={navigateSection}
      />
      <div class={settingsOpen() ? "workspace workspace-settings" : section() === "messages" ? "workspace workspace-messages" : "workspace"}>
        <Show when={settingsOpen()} fallback={
          <>
        <Show when={section() === "messages"}>
          <MessageSidebar
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
        </Show>
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
                        onStop={() => void tab.store.cancelTurn().catch(() => {})}
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
                      <WorkspacePanel store={tab.store} />
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
          <SettingsView />
        </Show>
      </div>
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
      <DiffReviewDrawer />
      <ContextMenuHost />
      <ToastHost />
    </div>
  );
};

export default App;
