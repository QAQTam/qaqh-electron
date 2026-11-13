// BrowserEngine：内嵌浏览器（IAB）的宿主实现。
// 状态机（docs/browser-control-design.md）：
//   closed → creating → live(attached|detached) → closed
// attached = WebContentsView 挂在主窗口 contentView 上（可见或屏外隐藏）；
// detached = 用户隐藏后的形态：挪到屏外但保持挂载——保证 capturePage/输入
// 派发在"隐藏"状态下照常工作（不引入第二套离屏渲染路径）。
// 生命周期只有 browser_close / 壳退出两个销毁入口，无空闲回收（用户内存充足）。

import { WebContentsView, type BrowserWindow } from "electron";
import { join } from "node:path";
import { getDataDir } from "../daemon.js";
import {
  domClick,
  domPressKey,
  domScroll,
  domScreenshot,
  domSnapshot,
  domType,
} from "./dom-ops.js";
import type { BrowserToolHandlers } from "./mcp-server.js";

/** 隐藏形态：视图仍在合成器内（可截图/可收输入），只是移出可视区。 */
const OFFSCREEN_X = -32000;
const PANE_VIEW_WIDTH = 900;
const PANE_VIEW_HEIGHT = 700;
/** 默认面板矩形：主窗口右侧 45%（renderer 视口接管前的事实默认值）。 */
const PANE_WIDTH_RATIO = 0.45;

const CONSOLE_BUFFER_LIMIT = 200;

interface ConsoleEntry {
  level: string;
  text: string;
  atMs: number;
}

export interface PaneState {
  visible: boolean;
  url: string;
  title: string;
}

/** 面板视口（renderer 测量的 CSS 像素矩形，主窗口内容坐标系）。 */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** renderer 面（ipc-handlers）驱动的面板控制面。 */
export interface BrowserPaneControl {
  showPane: (rect?: PaneRect) => void;
  hidePane: () => void;
  /** 仅更新视口矩形（不改可见性；可见时立即重新落位）。 */
  setViewport: (rect: PaneRect) => void;
  state: () => PaneState;
  navigate: (url: string) => Promise<{ content: string; isError?: boolean }>;
}

interface EngineDeps {
  getMainWindow: () => BrowserWindow | null;
  notifyPaneState?: (state: PaneState) => void;
}

export function createBrowserEngine(deps: EngineDeps): { handlers: BrowserToolHandlers; control: BrowserPaneControl; destroy: () => void } {
  let view: WebContentsView | null = null;
  let paneVisible = false;
  /** renderer 上报的视口矩形；null = 用右侧 45% 默认值。 */
  let customRect: PaneRect | null = null;
  let sessionUrl = "";
  let sessionTitle = "";
  const consoleBuffer: ConsoleEntry[] = [];

  function mainWindow(): BrowserWindow {
    const win = deps.getMainWindow();
    if (win == null || win.isDestroyed()) throw new Error("主窗口未就绪，浏览器工具暂不可用");
    return win;
  }

  function defaultBounds(win: BrowserWindow): { x: number; y: number; width: number; height: number } {
    const [width, height] = win.getContentSize();
    const paneWidth = Math.max(320, Math.round(width * PANE_WIDTH_RATIO));
    return { x: width - paneWidth, y: 0, width: paneWidth, height };
  }

  function paneState(): PaneState {
    return { visible: paneVisible, url: sessionUrl, title: sessionTitle };
  }

  function notify(): void {
    deps.notifyPaneState?.(paneState());
  }

  function ensureView(): WebContentsView {
    if (view && !view.webContents.isDestroyed()) return view;
    const win = mainWindow();
    const created = new WebContentsView({
      webPreferences: {
        partition: "persist:qaqh-browser",
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 站点嗅探 Electron UA 会拒服务；去掉壳专属标记，保留真实 Chromium 版本信息。
    created.webContents.setUserAgent(stripShellTokens(created.webContents.getUserAgent()));
    created.webContents.setWindowOpenHandler(({ url }) => {
      // 单 tab 模型：弹窗改在同一视图内导航（IAB 口径），不开新窗口。
      created.webContents.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    // Electron 45 签名：Event<WebContentsConsoleMessageEventParams>，level 为语义字符串。
    created.webContents.on("console-message", (event) => {
      consoleBuffer.push({
        level: event.level,
        text: String(event.message).slice(0, 500),
        atMs: Date.now(),
      });
      if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_LIMIT);
    });
    created.webContents.on("did-navigate", (_event, url) => {
      sessionUrl = url;
      notify();
    });
    created.webContents.on("page-title-updated", (_event, title) => {
      sessionTitle = title;
      notify();
    });
    created.webContents.on("render-process-gone", () => {
      sessionUrl = "";
      sessionTitle = "";
      notify();
    });

    view = created;
    win.contentView.addChildView(created);
    created.setBounds(paneBounds());
    paneVisible = true;
    const onResize = () => {
      if (!view || view.webContents.isDestroyed() || !paneVisible) return;
      view.setBounds(paneBounds());
    };
    win.on("resize", onResize);
    return created;
  }

  function paneBounds(): PaneRect {
    if (customRect) return customRect;
    return defaultBounds(mainWindow());
  }

  function showPane(rect?: PaneRect): void {
    if (rect) customRect = rect;
    const current = ensureView();
    current.setBounds(paneBounds());
    paneVisible = true;
    notify();
  }

  function hidePane(): void {
    if (!view) return;
    view.setBounds({ x: OFFSCREEN_X, y: 0, width: PANE_VIEW_WIDTH, height: PANE_VIEW_HEIGHT });
    paneVisible = false;
    notify();
  }

  const rawHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>
  > = {
    async browser_navigate(args: Record<string, unknown>) {
      const raw = args.url;
      if (typeof raw !== "string" || raw.trim() === "") {
        return { content: "error: browser_navigate 需要 url 参数", isError: true };
      }
      const parsed = new URL(raw.trim());
      if (!["http:", "https:", "file:", "data:"].includes(parsed.protocol)) {
        return { content: `error: 仅支持 http(s)/file/data URL，收到 ${parsed.protocol}`, isError: true };
      }
      showPane();
      const current = ensureView();
      sessionUrl = parsed.toString();
      notify();
      await current.webContents.loadURL(sessionUrl);
      const title = current.webContents.getTitle();
      return { content: `已打开 ${sessionUrl}\ntitle: ${title}` };
    },

    async browser_snapshot() {
      if (!view) return { content: "error: 浏览器未打开；先调用 browser_navigate", isError: true };
      return domSnapshot(view.webContents);
    },

    async browser_click(args: Record<string, unknown>) {
      if (!view) return { content: "error: 浏览器未打开；先调用 browser_navigate", isError: true };
      return domClick(view.webContents, String(args.uid ?? ""));
    },

    async browser_type(args: Record<string, unknown>) {
      if (!view) return { content: "error: 浏览器未打开；先调用 browser_navigate", isError: true };
      return domType(view.webContents, String(args.uid ?? ""), args.text, args.submit === true);
    },

    async browser_press_key(args: Record<string, unknown>) {
      if (!view) return { content: "error: 浏览器未打开；先调用 browser_navigate", isError: true };
      return domPressKey(view.webContents, String(args.key ?? ""));
    },

    async browser_scroll(args: Record<string, unknown>) {
      if (!view) return { content: "error: 浏览器未打开；先调用 browser_navigate", isError: true };
      return domScroll(view.webContents, args.direction, args.amount);
    },

    async browser_screenshot() {
      if (!view) return { content: "error: 浏览器未打开；先调用 browser_navigate", isError: true };
      return domScreenshot(view.webContents, join(getDataDir(), "browser", "shots"));
    },

    async browser_console(args: Record<string, unknown>) {
      const level = typeof args.level === "string" ? args.level : null;
      const entries = consoleBuffer.filter((entry) => level == null || entry.level === level);
      if (entries.length === 0) return { content: "console 无消息" };
      const body = entries.slice(-100).map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
      return { content: `console ${entries.length} 条${level ? `（level=${level}）` : ""}：\n${body}` };
    },

    async browser_close() {
      destroy();
      return { content: "浏览器已关闭" };
    },
  };

  // 统一错误口径（设计 §工具面）：脚本/引擎层抛错一律转 isError 结果，
  // 不让异常穿透到 MCP server 之外的调用方。
  const handlers: BrowserToolHandlers = Object.fromEntries(
    Object.entries(rawHandlers).map(([name, run]) => [
      name,
      async (args: Record<string, unknown>) => {
        try {
          return await run(args);
        } catch (error) {
          return { content: `error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      },
    ]),
  );

  function destroy(): void {
    if (!view) return;
    const current = view;
    view = null;
    paneVisible = false;
    sessionUrl = "";
    sessionTitle = "";
    consoleBuffer.length = 0;
    try {
      mainWindow().contentView.removeChildView(current);
    } catch {
      // 主窗口可能已销毁；webContents 关闭由 app 退出兜底。
    }
    if (!current.webContents.isDestroyed()) current.webContents.close();
    notify();
  }

  // 面板控制面：renderer 经主机 IPC 驱动（browser_view_show/hide/viewport/navigate/state）。
  const control: BrowserPaneControl = {
    showPane: (rect) => showPane(rect),
    hidePane,
    setViewport: (rect) => {
      customRect = rect;
      if (paneVisible && view && !view.webContents.isDestroyed()) view.setBounds(paneBounds());
    },
    state: paneState,
    navigate: (url: string) => handlers.browser_navigate({ url }),
  };

  return { handlers, control, destroy };
}

/** 去 UA 里的壳专属 token：Electron/<ver> 与 QAQ-Harness/<ver>。 */
function stripShellTokens(userAgent: string): string {
  return userAgent
    .replace(/\s*Electron\/[\d.]+/, "")
    .replace(/\s*QAQ[-_]?H(?:arness)?\/[\S]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
