import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { DaemonManager } from "./daemon.js";
import { RingingClient } from "./ringing-client.js";
import { ChallengeManager } from "./challenges.js";
import { registerIpcHandlers } from "./ipc-handlers.js";

// Linux 平台 Chromium 调优：自动检测 Wayland 与 IME 输入法支持
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}

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

function resolveFrontendEntry(): string {
  if (process.env.QAQH_DEV_URL && process.env.QAQH_DEV_URL.trim() !== "") {
    return process.env.QAQH_DEV_URL;
  }

  // 打包后的生产路径
  const prodRenderer = join(__dirname, "../../renderer/index.html");
  if (existsSync(prodRenderer)) return prodRenderer;

  // 开发期本地相对路径（读取同级 qaqh-desktop-app 产物）
  const devRenderer = resolve(process.cwd(), "../qaqh-desktop-app/out/renderer/index.html");
  if (existsSync(devRenderer)) return devRenderer;

  return prodRenderer;
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
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const entry = resolveFrontendEntry();
  if (entry.startsWith("http://") || entry.startsWith("https://")) {
    console.log(`[app] Loading renderer from Dev URL: ${entry}`);
    mainWindow.loadURL(entry);
  } else {
    console.log(`[app] Loading renderer from file: ${entry}`);
    mainWindow.loadFile(entry);
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
