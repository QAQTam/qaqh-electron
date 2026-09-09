// Electron main（spec §3/§4）：生命周期、frameless 窗口、IPC 注册。
// 红线：main 不持有协议逻辑；退出链仅在 spawnedByUs 时 stop-if-idle。
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import fs from "node:fs";
import crypto from "node:crypto";
import { DaemonManager } from "./daemon.js";

const daemon = new DaemonManager();
let mainWindow: BrowserWindow | null = null;
let appQuitting = false;

const isDev = !app.isPackaged;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "hidden",
    backgroundMaterial: process.platform === "win32" ? "mica" : undefined,
    vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
    backgroundColor: "#f1efe8",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // dev 形态：daemon 无 CORS 头，renderer 跨源访问需关 webSecurity。
      // 生产 loadFile(file://) 同源直连 daemon，安全边界不变（contextIsolation/sandbox 仍开）。
      webSecurity: isDev ? false : true,
    },
  });

  // 外链全部拦截，走 qaqh:openExternal（spec §3）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** clientInstanceId：userData/instance-id，首次 UUID v4 稳定复用（唯一允许落盘的非秘密标识）。 */
function loadInstanceId(): string {
  const file = path.join(app.getPath("userData"), "instance-id");
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    /* 首次 */
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, id, "utf8");
  return id;
}

let cachedConnConfig: {
  endpoint: string;
  token: string;
  clientInstanceId: string;
  adopted: boolean;
} | null = null;

function registerIpc(): void {
  ipcMain.handle("qaqh:getConnectionConfig", async () => {
    if (!cachedConnConfig) {
      const d = await daemon.ensure();
      cachedConnConfig = {
        endpoint: d.endpoint.replace(/\/+$/, ""),
        token: d.token,
        clientInstanceId: loadInstanceId(),
        adopted: !daemon.status().spawnedByUs,
      };
    }
    return cachedConnConfig;
  });

  ipcMain.handle("qaqh:daemonStatus", () => daemon.status());

  ipcMain.handle("qaqh:pickAttachments", async (_e, opts: { multiple: boolean }) => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: [opts.multiple ? "multiSelections" : "openFile", "openFile"],
    });
    if (result.canceled) return [];
    const files: Array<{ name: string; mime: string; bytes: ArrayBuffer }> = [];
    for (const filePath of result.filePaths.slice(0, 10)) {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 20 * 1024 * 1024) continue; // 上限 20MB/个
      const buf = await fs.promises.readFile(filePath);
      files.push({
        name: path.basename(filePath),
        mime: mimeOf(filePath),
        bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
    }
    return files;
  });

  ipcMain.handle("qaqh:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  ipcMain.handle("qaqh:win", (_e, action: "min" | "max" | "close") => {
    if (!mainWindow) return;
    if (action === "min") mainWindow.minimize();
    else if (action === "max") {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else mainWindow.close();
  });
}

function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
  };
  return table[ext] ?? "application/octet-stream";
}

app.whenReady().then(async () => {
  // daemon 确保失败不阻塞窗口（renderer 引导屏兜底）
  try {
    await daemon.ensure();
  } catch {
    /* missing → renderer 显示引导屏 */
  }
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (e) => {
  // 退出链：异步 stop-if-idle 期间阻止默认退出，完成后再退出
  if (daemon.status().spawnedByUs && !appQuitting) {
    e.preventDefault();
    void daemon.shutdown().finally(() => {
      appQuitting = true;
      app.quit();
    });
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
