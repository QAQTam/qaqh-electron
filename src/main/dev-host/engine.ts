// Dev Surface（docs/browser-control-design.md「Dev Surface」章节）：
// 开发者模式开启时经同一 qaqh-browser MCP server 暴露的「壳自身」操作面——
// 对主窗口 renderer 的 DOM 操控/观察 + 窗口合成层录制。
//
// 门控语义 = **可见性**，不是执行权限：tools/list 只在开发者模式开着时列出
// ui_*/record_*；handler 表恒定可解析（否则收回开关会锁死进行中的 record_stop）。
// 真正的边界是回环绑定 + per-boot token（与 browser 工具同一信任域）。
//
// 与 browser engine 的分工：browser_* 操作 IAB pane 里的**别人的页面**；
// ui_* 操作**自家 UI**（capturePage 不含子视图合成，全窗口合成画面归 record）。

import type { BrowserWindow } from "electron";
import { join } from "node:path";
import { getDataDir } from "../daemon.js";
import {
  domClick,
  domEvaluate,
  domPressKey,
  domScroll,
  domScreenshot,
  domSnapshot,
  domType,
} from "../browser-host/dom-ops.js";
import type { BrowserToolHandlers } from "../browser-host/mcp-server.js";
import { devToolDefs } from "./tool-defs.js";
import { createRecorder, type Recorder } from "./recorder.js";

export { devToolDefs };

interface EngineDeps {
  getMainWindow: () => BrowserWindow | null;
}

export function createDevHostEngine(deps: EngineDeps): {
  handlers: BrowserToolHandlers;
  recorder: Recorder;
} {
  const recorder = createRecorder(deps);

  /** 就绪校验：返回主窗口；未就绪抛错由统一口径转 isError。 */
  function uiContents(): BrowserWindow {
    const win = deps.getMainWindow();
    if (win == null || win.isDestroyed()) throw new Error("主窗口未就绪，UI 工具不可用");
    return win;
  }

  const rawHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>
  > = {
    async ui_snapshot() {
      return domSnapshot(uiContents().webContents);
    },
    async ui_click(args) {
      return domClick(uiContents().webContents, String(args.uid ?? ""));
    },
    async ui_type(args) {
      return domType(uiContents().webContents, String(args.uid ?? ""), args.text, args.submit === true);
    },
    async ui_press_key(args) {
      return domPressKey(uiContents().webContents, String(args.key ?? ""));
    },
    async ui_scroll(args) {
      return domScroll(uiContents().webContents, args.direction, args.amount);
    },
    async ui_screenshot() {
      return domScreenshot(uiContents().webContents, join(getDataDir(), "ui", "shots"));
    },
    async ui_evaluate(args) {
      return domEvaluate(uiContents().webContents, args.expression);
    },
    async record_start() {
      return recorder.start();
    },
    async record_stop() {
      return recorder.stop();
    },
    async record_status() {
      return recorder.status();
    },
  };

  // 与 browser engine 同一错误口径：引擎层抛错一律转 isError，不穿透到 MCP server。
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

  return { handlers, recorder };
}
