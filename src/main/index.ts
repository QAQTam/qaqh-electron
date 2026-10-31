import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, net, ipcMain, powerSaveBlocker, type IpcMainInvokeEvent } from "electron";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readDiscovery } from "./daemon.js";
import { pathToFileURL } from "node:url";
import { DaemonManager } from "./daemon.js";
import { RingingClient } from "./ringing-client.js";
import { ChallengeManager } from "./challenges.js";
import { registerIpcHandlers, registerQuitIpcHandler, isTrustedRenderer } from "./ipc-handlers.js";

// 注册特权标准协议 app://，支持 SPA 静态资源的绝对路径与 Fetch API
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// 针对双核奔腾/弱硬件（如 G2020）的极致轻量化与低内存配置
// 1. Linux 平台 Ozone/Wayland 与 IME 优化
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}

// 2. 限制进程并发（只允许单个渲染进程，避免多核心软中断打满双核 CPU）
app.commandLine.appendSwitch("renderer-process-limit", "1");
app.commandLine.appendSwitch("disable-site-isolation-trials");

// 3. V8 堆内存约束与代码体积优化（限制最大 256MB，优先小内存占用）
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256 --optimize-for-size --expose-gc");
// performance.memory 精确化：不开的话 Chromium 对 JS 堆读数做量化且 ~20s 才刷新，
// 开发者面板看到的堆是"大约数"，500MB 尖峰会整个被抹掉（stress-cdp.mjs 同一前提）。
app.commandLine.appendSwitch("enable-precise-memory-info");

// 4. GPU/3D 开关(用户可调,渲染性能模式驱动):默认禁用(受限硬件极致省内存的
//    旧行为);设置页选 Quality 档时 renderer 会把偏好写进 shell-prefs.json,
//    **下次启动**不再追加禁用开关(命令行开关只能在进程启动前生效,改档须重启壳)。
//    纯内存类约束(V8 堆上限/进程数/缓存)与开关无关,恒定不动。
type ShellPrefs = { gpuDisabled?: boolean };
const SHELL_PREFS_FILE = join(app.getPath("userData"), "shell-prefs.json");
function readShellPrefs(): ShellPrefs {
  try {
    return JSON.parse(readFileSync(SHELL_PREFS_FILE, "utf8")) as ShellPrefs;
  } catch { return {}; }
}
function writeShellPrefs(prefs: ShellPrefs): void {
  try { writeFileSync(SHELL_PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
}
const shellPrefs = readShellPrefs();
// 缺省 = 禁用(与历史行为一致);只有 Quality 档明确写过 false 才启用 GPU。
const gpuDisabledNow = shellPrefs.gpuDisabled !== false;
if (gpuDisabledNow) {
  app.commandLine.appendSwitch("disable-3d-apis");
  app.commandLine.appendSwitch("disable-webgl");
  app.commandLine.appendSwitch("disable-webgl2");
}
app.commandLine.appendSwitch("disable-speech-api");
app.commandLine.appendSwitch("disable-breakpad");
app.commandLine.appendSwitch("disable-print-preview");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-sync");

// 5. 限制磁盘和多媒体缓存（16MB / 8MB），避免触发系统 Swap 颠簸
app.commandLine.appendSwitch("disk-cache-size", "16777216");
app.commandLine.appendSwitch("media-cache-size", "8388608");

// 6. 禁用后台不必要的重型功能
app.commandLine.appendSwitch(
  "disable-features",
  "Translate,AutofillServerCommunication,CalculateNativeWinOcclusion,InterestFeedContentSuggestions"
);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let client: RingingClient | null = null;
let allowWindowClose = false;
let closeToTray = true;
const daemonMgr = new DaemonManager();
const challenges = new ChallengeManager();
let connecting: Promise<RingingClient> | null = null;

function showMainWindow(): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// 单实例锁保护
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[app] Another instance is already running. Quitting.");
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    await bootstrapApp();
  });
}

registerQuitIpcHandler(() => client);

interface WindowState {
  visible: boolean;
  maximized: boolean;
  fullscreen: boolean;
  closeToTray: boolean;
  tray: boolean;
}

function currentWindowState(): WindowState {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return {
    visible: window?.isVisible() ?? false,
    maximized: window?.isMaximized() ?? false,
    fullscreen: window?.isFullScreen() ?? false,
    closeToTray,
    tray: tray != null,
  };
}

function sendWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("qaqh:event:app://window-state", currentWindowState());
}

function windowPrefsPath(): string {
  return join(app.getPath("userData"), "window-prefs.json");
}

function loadWindowPrefs(): void {
  try {
    const parsed = JSON.parse(readFileSync(windowPrefsPath(), "utf8")) as { closeToTray?: unknown };
    if (typeof parsed.closeToTray === "boolean") closeToTray = parsed.closeToTray;
  } catch {
    // first run / malformed prefs: keep the tray-friendly default.
  }
}

function persistWindowPrefs(): void {
  try {
    writeFileSync(windowPrefsPath(), JSON.stringify({ closeToTray }), "utf8");
  } catch (error) {
    console.warn("[window] failed to persist window prefs:", error);
  }
}

function canControlWindow(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame && isTrustedRenderer(event.senderFrame?.url ?? "");
}

ipcMain.handle("qaqh:window-state", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  return currentWindowState();
});

ipcMain.handle("qaqh:window-show", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  showMainWindow();
  return null;
});

// DevTools 开关(设置页·开发者模式):click 即 toggle,返回开关后的状态。
// 只暴露 toggle,不暴露 openDevTools/参数——renderer 不需要更多控制面。
ipcMain.handle("qaqh:devtools-toggle", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  const webContents = mainWindow?.webContents;
  if (webContents == null) return false;
  webContents.toggleDevTools();
  return webContents.isDevToolsOpened();
});

// ── 休眠限制(用户需求,Linux+Windows)────────────────────────────────────
// Electron 原生 powerSaveBlocker:prevent-app-suspension 阻止系统休眠(允许熄屏),
// prevent-display-sleep 连屏幕一起保持(演示/监控)。Linux 走 D-Bus inhibit,
// Windows 走 SetThreadExecutionState;单实例只持有一个 blocker,切模式先停旧。
// 设置页「桌面壳」面板是唯一入口;偏好存 renderer localStorage,启动时由
// renderer 重新 set(主进程不持久化——这是界面偏好,不是 daemon 配置)。
type PowerBlockerMode = "off" | "keep-awake" | "keep-awake-bright";
const POWER_MODES = new Set<string>(["off", "keep-awake", "keep-awake-bright"]);
let powerBlockerId: number | null = null;
let powerBlockerMode: PowerBlockerMode = "off";

function powerBlockerState(): { mode: PowerBlockerMode; active: boolean } {
  return {
    mode: powerBlockerMode,
    active: powerBlockerId != null && powerSaveBlocker.isStarted(powerBlockerId),
  };
}

ipcMain.handle("qaqh:power-blocker", (event, payload: unknown) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  const requested = (payload as { mode?: unknown } | null)?.mode;
  if (typeof requested !== "string" || !POWER_MODES.has(requested)) {
    throw new Error(`未知的休眠限制模式: ${String(requested)}`);
  }
  if (powerBlockerId != null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
  powerBlockerMode = requested as PowerBlockerMode;
  if (powerBlockerMode === "keep-awake") {
    powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (powerBlockerMode === "keep-awake-bright") {
    powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  }
  return powerBlockerState();
});

ipcMain.handle("qaqh:power-blocker-state", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  return powerBlockerState();
});

// ── GPU 加速偏好(渲染性能模式驱动,重启生效)────────────────────────────
// renderer 是档位事实源(auto/low/quality + 硬件/GPU 探针),这里只存偏好与回报
// 「本次启动实际是什么」。命令行开关在启动前定格,运行时改档只能下次生效。
function gpuPrefState(): { currentLaunchDisabled: boolean; nextLaunchDisabled: boolean } {
  return {
    currentLaunchDisabled: gpuDisabledNow,
    nextLaunchDisabled: readShellPrefs().gpuDisabled !== false,
  };
}

ipcMain.handle("qaqh:gpu-pref-state", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  return gpuPrefState();
});

ipcMain.handle("qaqh:gpu-pref-set", (event, payload: unknown) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  const requested = (payload as { disabled?: unknown } | null)?.disabled;
  if (typeof requested !== "boolean") throw new Error("gpu-pref-set 需要 boolean disabled");
  const prefs = readShellPrefs();
  prefs.gpuDisabled = requested;
  writeShellPrefs(prefs);
  return gpuPrefState();
});

// 重启壳(应用 GPU 偏好/加载新参数):**必须走 app.quit()**——app.exit() 会跳过
// before-quit,托盘的 StatusNotifier 不反注册,旧进程留下僵尸托盘项,面板上
// 新实例的图标被顶掉不显示(实测:重启后托盘 icon 消失)。quit 路径里
// before-quit 会拆托盘、断 client;daemon 是 detached 子进程,不受影响。
ipcMain.handle("qaqh:relaunch", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  app.relaunch();
  try { tray?.destroy(); } catch { /* 面板侧可能已先摘除 */ }
  tray = null;
  app.quit();
});

// WCO 配色跟随主题(阶段4):只改外观,不承担关窗职责——即使 IPC 全挂,原生
// 窗口控制仍然可用(绝对隔离的边界就在这里:控制画在原生层,不走 renderer)。
ipcMain.handle("qaqh:titlebar-overlay", (event, options: unknown) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  const overlay = (options ?? {}) as { color?: unknown; symbolColor?: unknown };
  try {
    mainWindow?.setTitleBarOverlay({
      ...(typeof overlay.color === "string" ? { color: overlay.color } : {}),
      ...(typeof overlay.symbolColor === "string" ? { symbolColor: overlay.symbolColor } : {}),
    });
    return true;
  } catch (error) {
    // 平台不支持(旧 Windows/部分 Linux WM)时静默降级:维持创建时的初值。
    console.warn("[app] setTitleBarOverlay unavailable:", error);
    return false;
  }
});

ipcMain.handle("qaqh:window-hide", (event) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  mainWindow?.hide();
  return null;
});

ipcMain.handle("qaqh:window-close-to-tray", (event, value: unknown) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  closeToTray = value !== false;
  persistWindowPrefs();
  sendWindowState();
  return currentWindowState();
});

ipcMain.handle("qaqh:tray-status", (event, text: unknown) => {
  if (!canControlWindow(event)) throw new Error("IPC sender is not the application renderer");
  tray?.setToolTip(String(text ?? "").slice(0, 160));
  return null;
});

function ensureClient(): Promise<RingingClient> {
  if (client) return Promise.resolve(client);
  if (connecting) return connecting;
  connecting = (async () => {
    const discovery = await daemonMgr.ensureDaemonRunning(15000);
    const next = new RingingClient(discovery, (eventName, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`qaqh:event:${eventName}`, payload);
    });
    try {
      await next.init();
    } catch (error) {
      next.destroy();
      throw error;
    }
    client = next;
    return next;
  })().finally(() => { connecting = null; });
  return connecting;
}

async function bootstrapApp(): Promise<void> {
  console.log("[app] Bootstrapping QAQ-Harness Electron shell...");
  loadWindowPrefs();
  const pendingOperation = process.env.QAQH_PENDING_OPERATION?.trim() || null;

  // 0. 注册 app:// 协议处理器，使 /assets 等 SPA 绝对路径无缝映射到本地文件
  registerAppProtocol();

  // 1. Start/reuse daemon and establish the SDK client before the renderer loads,
  // so every IPC handler exists before frontend boot invokes anything.
  registerIpcHandlers(ensureClient, daemonMgr, challenges);
  // System bootstrap already reconciled components before loading this main.
  try {
    await ensureClient();
  } catch (err) {
    console.error("[app] Failed to connect or start qaqh-daemon:", err);
  }

  // 2. Create renderer after IPC registration.
  createMainWindow();
  if (pendingOperation && process.platform === "linux" && process.resourcesPath && process.env.QAQH_COMPONENT_ROOT) {
    const ready = await new Promise<boolean>((resolveReady) => {
      const window = mainWindow;
      if (!window || window.isDestroyed()) return resolveReady(false);
      const timeout = setTimeout(() => resolveReady(false), 30_000);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timeout);
        resolveReady(true);
      });
      window.webContents.once("did-fail-load", () => {
        clearTimeout(timeout);
        resolveReady(false);
      });
    });
    if (!ready || !client) {
      try {
        execFileSync(
          join(process.resourcesPath, "bin", "qaqh-maint"),
          ["rollback", "--root", process.env.QAQH_COMPONENT_ROOT, "--json"],
          { stdio: "ignore", timeout: 5_000 },
        );
      } catch (error) {
        console.error("[app] timed-out generation rollback failed:", error);
      }
      app.quit();
      return;
    }
    try {
      execFileSync(
        join(process.resourcesPath, "bin", "qaqh-maint"),
        ["confirm", "--root", process.env.QAQH_COMPONENT_ROOT, "--operation", pendingOperation, "--json"],
        { stdio: "ignore", timeout: 5_000 },
      );
    } catch (error) {
      console.error("[app] generation confirmation failed:", error);
      app.quit();
      return;
    }
  }
  // 3. Install tray.
  setupTray();
}

function resolveRendererDir(): string {
  // 0. 组件根(bootstrap 选中:overlay 或 baseline)。dist 与 renderer 同根,
  //    保证壳与前端版本永远配对,不会出现"新壳带旧前端"。
  const componentRoot = process.env.QAQH_APP_DIR?.trim();
  if (componentRoot) {
    const componentRenderer = join(componentRoot, "renderer");
    if (existsSync(componentRenderer)) return componentRenderer;
  }

  // 1. 打包生产环境/asar 内部路径: join(app.getAppPath(), "renderer")
  const asarRenderer = join(app.getAppPath(), "renderer");
  if (existsSync(asarRenderer)) return asarRenderer;

  // 2. 本地项目 renderer 目录
  const localRenderer = resolve(process.cwd(), "renderer");
  if (existsSync(localRenderer)) return localRenderer;

  // 3. 本仓 webui 的开发构建产物
  const devRenderer = resolve(process.cwd(), "webui/out/renderer");
  if (existsSync(devRenderer)) return devRenderer;

  return asarRenderer;
}

function registerAppProtocol(): void {
  protocol.handle("app", async (request) => {
    try {
      const parsedUrl = new URL(request.url);
      let pathname = decodeURIComponent(parsedUrl.pathname);
      if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
      }

      const rendererDir = resolveRendererDir();
      const cleanPath = pathname.replace(/^\/+/, "");
      const filePath = resolve(rendererDir, cleanPath);
      const relativePath = relative(rendererDir, filePath);

      if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || !existsSync(filePath)) {
        console.warn(`[protocol] 404: ${pathname} (resolved: ${filePath})`);
        return new Response("Not Found", { status: 404 });
      }

      const response = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      console.error("[protocol] Failed to serve app request:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}

function createMainWindow(): BrowserWindow {
  const preloadPath = join(__dirname, "../preload/index.cjs");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "QAQ-Harness",
    show: false,
    backgroundColor: "#18181b",
    // 阶段4(spec §5):隐藏原生标题栏。Linux/Windows 用 WCO(titleBarOverlay):
    // 窗口控制由壳层原生绘制,renderer panic/挂死之后窗口仍然可拖动、缩放、
    // 关闭——「能否关窗」绝不依赖 renderer 存活。macOS 用 hiddenInset 交通灯。
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    // 阶段1(菜单迁 TopBar ⋯)完成前保留 application menu,但不占一整行 chrome;
    // Alt 仍可呼出,动作不丢失(spec §5.5 的「先迁移后移除」在此兑现一半)。
    autoHideMenuBar: true,
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: {
            color: "#17181b",
            symbolColor: "#edeef0",
            height: 48, // 与 TopBar(--topbar-height: 48px)同高
          },
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false, // 禁用拼写检查字典，直接节省 40MB+ 内存并消除打字 CPU 占用
      backgroundThrottling: true, // 后台深度挂起定时器与 CSS 动画，节约空闲 CPU
    },
  });

  // 窗口最小化时主动释放渲染缓存并触发垃圾回收
  mainWindow.on("minimize", () => {
    mainWindow?.webContents.session.clearCache().catch(() => {});
    if (typeof (global as any).gc === "function") {
      try {
        (global as any).gc();
      } catch {}
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // 可编辑区右键菜单:Tauri 时代 WebView2/WKWebView 自带原生编辑菜单,Electron
  // 不会自动弹任何菜单(Chromium 的默认菜单逻辑被壳替换),所以输入框右键是
  // 「无声无息」。这里只放编辑类角色(剪切/粘贴等走系统剪贴板与 IME 语义,
  // role 标签由 Electron 按系统语言本地化),不放 reload/后退等导航项——
  // reload 会丢未发送草稿与流式回合(见 webui/src/ui/contextMenu.tsx 的收口原则)。
  // 非编辑区仍由 renderer 应用内菜单负责:renderer preventDefault 后本事件
  // 不会到达主进程,两条链路天然互斥。
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    // role 的显示文案跟随系统 locale,英文系统上会冒出 Undo/Cut/Paste(用户反馈
    // 183557 截图);产品是中文优先,这里显式写中文 label,role 只保留行为与快捷键。
    Menu.buildFromTemplate([
      { label: "撤销", role: "undo" },
      { label: "重做", role: "redo" },
      { type: "separator" },
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { type: "separator" },
      { label: "全选", role: "selectAll" },
    ]).popup({ window: mainWindow ?? undefined });
  });

  mainWindow.on("close", (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closeToTray && tray != null) {
      mainWindow?.hide();
      return;
    }
    // The renderer owns the quit confirmation (stop daemon / stop active work).
    requestRendererQuit();
  });

  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);
  mainWindow.on("enter-full-screen", sendWindowState);
  mainWindow.on("leave-full-screen", sendWindowState);
  mainWindow.on("show", sendWindowState);
  mainWindow.on("hide", sendWindowState);

  if (process.env.QAQH_DEV_URL && process.env.QAQH_DEV_URL.trim() !== "") {
    console.log(`[app] Loading renderer from Dev URL: ${process.env.QAQH_DEV_URL}`);
    mainWindow.loadURL(process.env.QAQH_DEV_URL);
  } else {
    console.log("[app] Loading renderer via standard app:// protocol (app://localhost/index.html)");
    mainWindow.loadURL("app://localhost/index.html");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function setupTray(): void {
  // 阶段1(spec §5.5):Linux/Windows 摘除 application menu——模型/设置/关于/退出
  // 已全部迁入 TopBar ⋯ 菜单,Ctrl+Shift+M / Ctrl+Q 由 renderer 键盘接管
  // (webui App onKey),动作不丢失。macOS 保留系统菜单栏角色(关于/退出)。
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: "QAQ-Harness",
        submenu: [
          { label: "关于 QAQ-Harness", role: "about" },
          { type: "separator" },
          { label: "退出…", accelerator: "CommandOrControl+Q", click: () => requestRendererQuit() },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  try {
    const iconPath = app.isPackaged
      ? join(app.getAppPath(), "build/icons/32x32.png")
      : join(app.getAppPath(), "build/icons/32x32.png");
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip("QAQ-Harness");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "打开 QAQH",
        click: () => showMainWindow(),
      },
      { type: "separator" },
      {
        label: "退出 QAQH",
        click: () => {
          requestRendererQuit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("click", showMainWindow);
  } catch (err) {
    console.warn("[tray] Tray setup skipped or failed:", err);
  }
}

function requestRendererQuit(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    if (mainWindow) {
      const target = mainWindow;
      target.once("ready-to-show", () => {
        target.show();
        target.webContents.send("qaqh:event:app://quit-requested", null);
      });
    }
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("qaqh:event:app://quit-requested", null);
}

app.on("window-all-closed", () => {
  // Closing the window hides it on Linux/Windows; on macOS the app remains active.
});

app.on("before-quit", () => {
  allowWindowClose = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (client) {
    client.destroy();
    client = null;
  }
  // Daemon is intentionally detached and survives shell exit.
});

app.on("activate", () => {
  if (!mainWindow) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
});
