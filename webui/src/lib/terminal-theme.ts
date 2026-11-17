/**
 * 模拟终端配色方案(ReadOnlyTerminal / 命令执行抽屉)。
 *
 * 色值逐字抄自 Windows Terminal(microsoft/terminal)内置配色 defaults.json
 * 的 `schemes` 段——WT 的 "purple" 即 xterm 的 "magenta",其余键一一对应。
 * "follow" 表示不接管:沿用应用表面色(旧行为,可读性跟随明暗主题)。
 * 偏好存 localStorage(与 theme.ts 的预设同一套本地纪律),不写 daemon 配置。
 */
import type { ITheme } from "@xterm/xterm";
import { createSignal } from "solid-js";

export type TerminalSchemeId =
  | "follow"
  | "campbell"
  | "campbell-powershell"
  | "tango-dark"
  | "vintage"
  | "one-half-dark"
  | "solarized-dark";

export interface TerminalSchemeOption {
  value: TerminalSchemeId;
  label: string;
  desc?: string;
}

export const TERMINAL_SCHEME_OPTIONS: readonly TerminalSchemeOption[] = [
  { value: "follow", label: "跟随应用（默认）", desc: "继承当前界面明暗的表面色" },
  { value: "campbell", label: "经典命令提示符 · Campbell（黑）", desc: "Windows Terminal 默认 cmd 配色，#0C0C0C 黑底" },
  { value: "campbell-powershell", label: "Windows PowerShell · Campbell Powershell（蓝）", desc: "经典 PowerShell 蓝底 #012456" },
  { value: "tango-dark", label: "经典 Linux/Bash · Tango Dark（纯黑）", desc: "GNOME/XTerm 传统 Tango 色板" },
  { value: "vintage", label: "复古 CRT · Vintage（荧光灰）", desc: "Windows Terminal 内置复古方案" },
  { value: "one-half-dark", label: "One Half Dark", desc: "Windows Terminal 内置现代深色" },
  { value: "solarized-dark", label: "Solarized Dark", desc: "Windows Terminal 内置经典护眼色" },
] as const;

/** WT defaults.json 原文照抄;selectionBackground WT 未给,按各方案亮蓝系取近似值。 */
const SCHEMES: Record<Exclude<TerminalSchemeId, "follow">, ITheme> = {
  campbell: {
    foreground: "#CCCCCC",
    background: "#0C0C0C",
    cursor: "#FFFFFF",
    selectionBackground: "rgba(59, 120, 255, 0.40)",
    black: "#0C0C0C",
    red: "#C50F1F",
    green: "#13A10E",
    yellow: "#C19C00",
    blue: "#0037DA",
    magenta: "#881798",
    cyan: "#3A96DD",
    white: "#CCCCCC",
    brightBlack: "#767676",
    brightRed: "#E74856",
    brightGreen: "#16C60C",
    brightYellow: "#F9F1A5",
    brightBlue: "#3B78FF",
    brightMagenta: "#B4009E",
    brightCyan: "#61D6D6",
    brightWhite: "#F2F2F2",
  },
  "campbell-powershell": {
    foreground: "#CCCCCC",
    background: "#012456",
    cursor: "#FFFFFF",
    selectionBackground: "rgba(59, 120, 255, 0.40)",
    black: "#0C0C0C",
    red: "#C50F1F",
    green: "#13A10E",
    yellow: "#C19C00",
    blue: "#0037DA",
    magenta: "#881798",
    cyan: "#3A96DD",
    white: "#CCCCCC",
    brightBlack: "#767676",
    brightRed: "#E74856",
    brightGreen: "#16C60C",
    brightYellow: "#F9F1A5",
    brightBlue: "#3B78FF",
    brightMagenta: "#B4009E",
    brightCyan: "#61D6D6",
    brightWhite: "#F2F2F2",
  },
  "tango-dark": {
    foreground: "#D3D7CF",
    background: "#000000",
    cursor: "#FFFFFF",
    selectionBackground: "rgba(114, 159, 207, 0.40)",
    black: "#000000",
    red: "#CC0000",
    green: "#4E9A06",
    yellow: "#C4A000",
    blue: "#3465A4",
    magenta: "#75507B",
    cyan: "#06989A",
    white: "#D3D7CF",
    brightBlack: "#555753",
    brightRed: "#EF2929",
    brightGreen: "#8AE234",
    brightYellow: "#FCE94F",
    brightBlue: "#729FCF",
    brightMagenta: "#AD7FA8",
    brightCyan: "#34E2E2",
    brightWhite: "#EEEEEC",
  },
  vintage: {
    foreground: "#C0C0C0",
    background: "#000000",
    cursor: "#FFFFFF",
    selectionBackground: "rgba(255, 255, 255, 0.30)",
    black: "#000000",
    red: "#800000",
    green: "#008000",
    yellow: "#808000",
    blue: "#000080",
    magenta: "#800080",
    cyan: "#008080",
    white: "#C0C0C0",
    brightBlack: "#808080",
    brightRed: "#FF0000",
    brightGreen: "#00FF00",
    brightYellow: "#FFFF00",
    brightBlue: "#0000FF",
    brightMagenta: "#FF00FF",
    brightCyan: "#00FFFF",
    brightWhite: "#FFFFFF",
  },
  "one-half-dark": {
    foreground: "#DCDFE4",
    background: "#282C34",
    cursor: "#FFFFFF",
    selectionBackground: "rgba(97, 175, 239, 0.35)",
    black: "#282C34",
    red: "#E06C75",
    green: "#98C379",
    yellow: "#E5C07B",
    blue: "#61AFEF",
    magenta: "#C678DD",
    cyan: "#56B6C2",
    white: "#DCDFE4",
    brightBlack: "#5A6374",
    brightRed: "#E06C75",
    brightGreen: "#98C379",
    brightYellow: "#E5C07B",
    brightBlue: "#61AFEF",
    brightMagenta: "#C678DD",
    brightCyan: "#56B6C2",
    brightWhite: "#DCDFE4",
  },
  "solarized-dark": {
    foreground: "#839496",
    background: "#002B36",
    cursor: "#FFFFFF",
    selectionBackground: "rgba(131, 148, 150, 0.35)",
    black: "#002B36",
    red: "#DC322F",
    green: "#859900",
    yellow: "#B58900",
    blue: "#268BD2",
    magenta: "#D33682",
    cyan: "#2AA198",
    white: "#EEE8D5",
    brightBlack: "#073642",
    brightRed: "#CB4B16",
    brightGreen: "#586E75",
    brightYellow: "#657B83",
    brightBlue: "#839496",
    brightMagenta: "#6C71C4",
    brightCyan: "#93A1A1",
    brightWhite: "#FDF6E3",
  },
};

/** 非法值一律回落 "follow"(localStorage 可能残留旧枚举)。 */
export function normalizeTerminalScheme(value: string | null | undefined): TerminalSchemeId {
  return value != null && (value === "follow" || value in SCHEMES) ? (value as TerminalSchemeId) : "follow";
}

/** 当前选中方案的 xterm 主题;follow 返回 null(调用方走继承逻辑)。 */
export function terminalThemeFor(id: TerminalSchemeId): ITheme | null {
  return id === "follow" ? null : (SCHEMES[id] ?? null);
}

const SCHEME_STORAGE_KEY = "qaqh.terminal-scheme";
import { prefGet, prefSet } from "./prefs";

export function storedTerminalScheme(): TerminalSchemeId {
  return normalizeTerminalScheme(prefGet(SCHEME_STORAGE_KEY));
}

const [currentScheme, setCurrentScheme] = createSignal<TerminalSchemeId>(storedTerminalScheme());

export function applyTerminalScheme(id: TerminalSchemeId): void {
  const normalized = normalizeTerminalScheme(id);
  prefSet(SCHEME_STORAGE_KEY, normalized);
  setCurrentScheme(normalized);
}

export const terminalScheme = currentScheme;
