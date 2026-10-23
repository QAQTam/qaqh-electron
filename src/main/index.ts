import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, net } from "electron";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DaemonManager } from "./daemon.js";
import { RingingClient } from "./ringing-client.js";
import { ChallengeManager } from "./challenges.js";
import { registerIpcHandlers } from "./ipc-handlers.js";

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
const daemonMgr = new DaemonManager();
const challenges = new ChallengeManager();

// 单实例锁保护
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[app] Another instance is already running. Quitting.");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await bootstrapApp();
  });
}

async function bootstrapApp(): Promise<void> {
  console.log("[app] Bootstrapping QAQ-Harness Electron shell...");

  // 0. 注册 app:// 协议处理器，使 /assets 等 SPA 绝对路径无缝映射到本地文件
  registerAppProtocol();

  // 1. 确保 daemon 在运行
  let discovery;
  try {
    discovery = await daemonMgr.ensureDaemonRunning(15000);
  } catch (err) {
    console.error("[app] Failed to connect or start qaqh-daemon:", err);
  }

  // 2. 创建主窗口
  createMainWindow();

  // 3. 初始化 Ringing 客户端并建立连接
  if (discovery) {
    client = new RingingClient(discovery, (eventName, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("tauri:event", { eventName, payload });
      }
    });

    try {
      await client.init();
      console.log("[app] Ringing v2 client connected successfully.");
    } catch (err) {
      console.warn("[app] Ringing client init failed:", err);
    }

    registerIpcHandlers(client, daemonMgr, challenges);
  }

  // 4. 创建系统托盘
  setupTray();
}

function resolveRendererDir(): string {
  // 1. 打包生产环境/asar 内部路径: join(app.getAppPath(), "renderer")
  const asarRenderer = join(app.getAppPath(), "renderer");
  if (existsSync(asarRenderer)) return asarRenderer;

  // 2. 本地项目 renderer 目录
  const localRenderer = resolve(process.cwd(), "renderer");
  if (existsSync(localRenderer)) return localRenderer;

  // 3. 同级开发项目 qaqh-desktop-app 产物
  const devRenderer = resolve(process.cwd(), "../qaqh-desktop-app/out/renderer");
  if (existsSync(devRenderer)) return devRenderer;

  return asarRenderer;
}

function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    try {
      const parsedUrl = new URL(request.url);
      let pathname = decodeURIComponent(parsedUrl.pathname);
      if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
      }

      const rendererDir = resolveRendererDir();
      const cleanPath = pathname.replace(/^\/+/, "");
      const filePath = resolve(rendererDir, cleanPath);

      if (!filePath.startsWith(rendererDir) || !existsSync(filePath)) {
        console.warn(`[protocol] 404: ${pathname} (resolved: ${filePath})`);
        return new Response("Not Found", { status: 404 });
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      console.error("[protocol] Failed to serve app request:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}

function createMainWindow(): void {
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
}

function setupTray(): void {
  try {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip("QAQ-Harness");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "打开 QAQH",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createMainWindow();
          }
        },
      },
      { type: "separator" },
      {
        label: "退出 QAQH",
        click: () => {
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
        }
      }
    });
  } catch (err) {
    console.warn("[tray] Tray setup skipped or failed:", err);
  }
}

app.on("window-all-closed", () => {
  // 遵循契约：Linux / Windows 窗口全部关闭时退出主程序，但后台 daemon 保留存活
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (client) {
    client.destroy();
    client = null;
  }
});
