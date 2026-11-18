/**
 * 启动 splash（壳层首窗）。
 *
 * Electron 没有 splash API——这里就是标准做法：`whenReady` 后第一件事弹一个
 * 无边框静态窗，把 `ensureClient()`（冷启动 daemon 最长 15s）**之前**的窗口
 * 空窗期盖住；主窗口 `ready-to-show` 并 show 之后交棒关闭。
 *
 * 页面本体是 `splash.html`，经 esbuild 的 text loader 编进主进程 bundle，以
 * data: URL 加载——不新增打包管道、asar 内外/开发模式同一份。页面零特权：
 * sandbox、无 preload、无 node；状态更新走 executeJavaScript 单向推送。
 *
 * 时序纪律：
 *  - `setSplashStatus` 在页面就绪前来调只记录最新值，`did-finish-load` 后
 *    统一补投（启动阶段的状态本来就允许合并）；
 *  - 关闭带最短驻留（防快启动时闪一下更难看）与 25s 保险丝（主窗 ready-to-show
 *    永不触发时 splash 绝不比应用活得久）；
 *  - `close()` 走 destroy 语义前先试 close；此窗无 close 拦截者，托盘逻辑
 *    只挂在主窗上，不会把 splash 收进托盘。
 */
import { BrowserWindow, app } from "electron";
// esbuild text loader 的注入件；类型声明见 splash-html.d.ts。
import splashHtml from "./splash.html";

const SPLASH_WIDTH = 460;
const SPLASH_HEIGHT = 300;
/** 最短驻留：真机快启动（daemon 已热）从弹出到交棒可能 <1s，闪屏比没屏更糟。 */
const MIN_VISIBLE_MS = 800;
/** 交棒后到真正销毁之间的叠化间隙：主窗 show 与 splash 关闭之间留一点重叠。 */
const HANDOFF_LINGER_MS = 220;
/** 保险丝：主窗迟迟不 ready（加载失败等），splash 不许挂死在屏幕上。 */
const SAFETY_MS = 25_000;

let splash: BrowserWindow | null = null;
let pageReady = false;
let openedAt = 0;
let statusText = "";
let metaText = "";
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

function push(script: string): void {
  const win = splash;
  if (win == null || win.isDestroyed() || win.webContents.isDestroyed()) return;
  // 页面脚本自己的事：加载失败/被替换时这里只会静默 reject，不影响启动。
  void win.webContents.executeJavaScript(script).catch(() => {});
}

function syncStatus(): void {
  if (statusText !== "") push(`window.__splash(${JSON.stringify(statusText)})`);
  if (metaText !== "") push(`window.__splashMeta(${JSON.stringify(metaText)})`);
}

/** 弹出 splash（幂等）。version 缺省用 app.getVersion()。 */
export function showSplash(version?: string): void {
  if (splash != null && !splash.isDestroyed()) return;
  pageReady = false;
  metaText = `${version ?? app.getVersion()} · QAQ-Harness`;
  splash = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    useContentSize: true,
    title: "Overcoder",
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: "#17181b",
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: false,
      backgroundThrottling: false, // 弹出前若被节流，交棒时刻会多黑几十毫秒
    },
  });
  splash.setMenuBarVisibility(false);
  splash.webContents.on("did-finish-load", () => {
    pageReady = true;
    syncStatus();
  });
  // 静态 data: 页首帧极快；等 ready-to-show 再亮，避免白/黑底一闪。
  splash.once("ready-to-show", () => {
    if (splash != null && !splash.isDestroyed()) splash.show();
  });
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  openedAt = Date.now();
  if (safetyTimer != null) clearTimeout(safetyTimer);
  safetyTimer = setTimeout(() => closeSplash(), SAFETY_MS);
}

/** 更新状态行（未弹出时调用是无操作）。 */
export function setSplashStatus(text: string): void {
  statusText = text;
  if (pageReady) syncStatus();
}

/** 交棒关闭：补足最短驻留后销毁；重复调用安全。 */
export function closeSplash(): void {
  const win = splash;
  splash = null;
  pageReady = false;
  if (safetyTimer != null) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
  if (win == null || win.isDestroyed()) return;
  const waited = Date.now() - openedAt;
  const linger = Math.max(HANDOFF_LINGER_MS, MIN_VISIBLE_MS - waited + HANDOFF_LINGER_MS);
  setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, linger);
}

/** 交棒时刻由主窗事件驱动，导出查询仅供调试与测试断言。 */
export function splashVisible(): boolean {
  return splash != null && !splash.isDestroyed() && splash.isVisible();
}
