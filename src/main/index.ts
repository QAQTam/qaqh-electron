import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, net, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readDiscovery } from "./daemon.js";
import { pathToFileURL } from "node:url";
import { DaemonManager } from "./daemon.js";
import { RingingClient } from "./ringing-client.js";
import { ChallengeManager } from "./challenges.js";
import { registerIpcHandlers, registerQuitIpcHandler, isTrustedRenderer } from "./ipc-handlers.js";
import { MODEL_PICKER_HTML, openModelPicker } from "./model-picker.js";

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

// 4. 彻底禁用无用的重量级模块（纯代码/文本客户端无需 3D/WebGL、语音与后台遥测）
app.commandLine.appendSwitch("disable-3d-apis");
app.commandLine.appendSwitch("disable-webgl");
app.commandLine.appendSwitch("disable-webgl2");
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

  // 0. 注册 app:// 协议处理器，使 /assets 等 SPA 绝对路径无缝映射到本地文件
  registerAppProtocol();

  // 1. Start/reuse daemon and establish the SDK client before the renderer loads,
  // so every IPC handler exists before frontend boot invokes anything.
  registerIpcHandlers(ensureClient, daemonMgr, challenges);
  try {
    await ensureClient();
  } catch (err) {
    console.error("[app] Failed to connect or start qaqh-daemon:", err);
  }

  // 2. Create renderer after IPC registration.
  createMainWindow();
  // 3. Install tray.
  setupTray();
}

function resolveRendererDir(): string {
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
      if (parsedUrl.pathname === "/model-picker") {
        return new Response(MODEL_PICKER_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
            "x-content-type-options": "nosniff",
          },
        });
      }
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "QAQ-Harness",
      submenu: [
        { label: "关于 QAQ-Harness", role: "about" },
        { type: "separator" },
        { label: "退出…", accelerator: "CommandOrControl+Q", click: () => requestRendererQuit() },
      ],
    },
    {
      label: "模型",
      submenu: [
        {
          label: "选择新会话默认模型…",
          accelerator: "CommandOrControl+Shift+M",
          click: () => { if (client) openModelPicker(client, null); },
        },
        {
          label: "更改当前会话模型…",
          click: () => {
            const seed = client?.getActiveSeed();
            if (client && seed) openModelPicker(client, seed);
            else console.info("[model-picker] no active session is attached");
          },
        },
      ],
    },
  ]));

  try {
    const iconPath = app.isPackaged
      ? join(app.getAppPath(), "build/icons/32x32.png")
      : join(app.getAppPath(), "build/icons/32x32.png");
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip("QAQ-Harness");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "选择新会话默认模型…",
        click: () => {
          if (client) openModelPicker(client, null);
        },
      },
      {
        label: "更改当前会话模型…",
        click: () => {
          const seed = client?.getActiveSeed();
          if (client && seed) openModelPicker(client, seed);
        },
      },
      { type: "separator" },
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
