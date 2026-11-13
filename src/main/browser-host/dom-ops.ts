// DOM 操作机械层：对任意 WebContents 执行 snapshot → uid → act 口径
// （docs/browser-control-design.md）。browser engine（IAB pane）与 dev-host
// engine（主窗口 UI，开发者模式）共用这一份实现——注入脚本本就是纯 DOM 逻辑，
// 不存在第二套"离屏/在屏"路径，差异只在 handler 层的前置条件与截屏落盘目录。

import type { WebContents } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOCUS_SCRIPT_PREFIX,
  LOCATE_SCRIPT_PREFIX,
  SCROLL_SCRIPT_PREFIX,
  SNAPSHOT_SCRIPT,
  serializeSnapshot,
} from "./snapshot-script.js";

export interface ScriptTarget {
  error?: string;
  x?: number;
  y?: number;
  tag?: string;
  type?: string;
  editable?: boolean;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

function runScript<T>(wc: WebContents, script: string, args: unknown[] = []): Promise<T> {
  const code = `(${script})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
  return wc.executeJavaScript(code, true) as Promise<T>;
}

function sendMouseEvent(wc: WebContents, type: "mouseMove" | "mouseDown" | "mouseUp", x: number, y: number): void {
  wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 } as never);
}

const KEY_CODES: Record<string, string> = {
  Enter: "Return", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End",
};

export async function domSnapshot(wc: WebContents): Promise<ToolOutcome> {
  const result = await runScript<{ url: string; title: string; lines: string[]; truncated: boolean }>(wc, SNAPSHOT_SCRIPT);
  return { content: serializeSnapshot(result) };
}

export async function domClick(wc: WebContents, uid: string): Promise<ToolOutcome> {
  if (!uid) return { content: "error: click 需要 uid 参数", isError: true };
  const target = await runScript<ScriptTarget>(wc, LOCATE_SCRIPT_PREFIX, [uid]);
  if (target.error != null) return { content: `error: ${target.error}`, isError: true };
  if (target.x == null || target.y == null) return { content: "error: 定位结果缺失坐标", isError: true };
  sendMouseEvent(wc, "mouseMove", target.x, target.y);
  sendMouseEvent(wc, "mouseDown", target.x, target.y);
  sendMouseEvent(wc, "mouseUp", target.x, target.y);
  return { content: `已点击 [${uid}] ${target.tag}${target.type ? `(${target.type})` : ""} @ ${Math.round(target.x)},${Math.round(target.y)}` };
}

export async function domType(wc: WebContents, uid: string, text: unknown, submit: boolean): Promise<ToolOutcome> {
  if (!uid || typeof text !== "string") return { content: "error: type 需要 uid 与 text 参数", isError: true };
  const target = await runScript<ScriptTarget>(wc, FOCUS_SCRIPT_PREFIX, [uid]);
  if (target.error != null) return { content: `error: ${target.error}`, isError: true };
  if (!target.editable) return { content: `error: [${uid}] ${target.tag} 不是可输入元素`, isError: true };
  for (const char of text) {
    wc.sendInputEvent({ type: "char", keyCode: char } as never);
  }
  if (submit) {
    wc.sendInputEvent({ type: "keyDown", keyCode: "Return" } as never);
    wc.sendInputEvent({ type: "keyUp", keyCode: "Return" } as never);
  }
  return { content: `已输入 ${text.length} 字符到 [${uid}]${submit ? " 并回车" : ""}` };
}

export function domPressKey(wc: WebContents, key: string): ToolOutcome {
  const keyCode = KEY_CODES[key];
  if (!keyCode) {
    return { content: `error: 不支持的按键 ${key}；支持 Enter/Tab/Escape/Backspace/Delete/Arrow*/PageUp/PageDown/Home/End`, isError: true };
  }
  wc.sendInputEvent({ type: "keyDown", keyCode } as never);
  wc.sendInputEvent({ type: "keyUp", keyCode } as never);
  return { content: `已按键 ${key}` };
}

export async function domScroll(wc: WebContents, direction: unknown, amount: unknown): Promise<ToolOutcome> {
  const dir = direction === "up" || direction === "down" ? direction : null;
  if (dir == null) return { content: "error: direction 必须是 up 或 down", isError: true };
  const pixels = typeof amount === "number" ? Math.round(amount) : 600;
  const scrollY = await runScript<number>(wc, SCROLL_SCRIPT_PREFIX, [dir, pixels]);
  return { content: `已${dir === "up" ? "上" : "下"}滚 ${pixels}px（scrollY=${scrollY}）` };
}

/** capturePage → PNG 落盘，返回文件路径文本（bridge.rs 丢二进制的既定绕行口径）。 */
export async function domScreenshot(wc: WebContents, shotsDir: string): Promise<ToolOutcome> {
  const image = await wc.capturePage();
  const png = image.toPNG();
  if (png.length === 0) {
    return { content: "error: 截图为空（页面尚未完成首帧渲染）；等待页面加载后重试", isError: true };
  }
  mkdirSync(shotsDir, { recursive: true });
  const filePath = join(shotsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  writeFileSync(filePath, png);
  return { content: `截图已保存：${filePath}\n用 read_image 工具查看该路径。` };
}

/** 在目标页面执行任意表达式并把结果转成文本（dev surface 专用）。 */
export async function domEvaluate(wc: WebContents, expression: unknown): Promise<ToolOutcome> {
  if (typeof expression !== "string" || expression.trim() === "") {
    return { content: "error: evaluate 需要 expression 参数（JS 表达式或函数）", isError: true };
  }
  const value = await wc.executeJavaScript(`(async () => { return eval(${JSON.stringify(expression)}); })()`, true);
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 1) ?? String(value); }
    catch { text = String(value); }
  }
  if (text.length > 8000) text = `${text.slice(0, 8000)}\n…（截断，共 ${text.length} 字符）`;
  return { content: text };
}
