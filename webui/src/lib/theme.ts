/**
 * 主题解析:config 的 theme 字段("" = 跟随系统 / light / dark)→
 * `documentElement[data-theme]`。CSS 侧以 `:root[data-theme="dark"]` 消费,
 * 首帧(pre-JS)由 `prefers-color-scheme` 媒体查询兜底;diff 的 shiki 高亮
 * 从 `resolvedTheme()` 读解析结果选配色。
 */
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type ResolvedTheme = "light" | "dark";

const systemDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

const [resolved, setResolved] = createSignal<ResolvedTheme>(systemDark?.matches ? "dark" : "light");

/** config.theme 的现值;null = 尚未从 config.load 拿到(按跟随系统处理)。 */
let configTheme: string | null = null;
let themeTransitionTimer: number | undefined;
let backdropSyncRevision = 0;
let backdropSyncQueue: Promise<unknown> = Promise.resolve();

const prefersReducedMotion = typeof matchMedia === "function"
  ? matchMedia("(prefers-reduced-motion: reduce)")
  : null;

function syncNativeBackdrop(theme: ResolvedTheme): void {
  if (typeof window === "undefined" || (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ == null) return;
  const revision = ++backdropSyncRevision;
  backdropSyncQueue = backdropSyncQueue
    .then(() => {
      if (revision !== backdropSyncRevision) return;
      return invoke<boolean>("set_window_theme", { dark: theme === "dark" }).then((applied) => {
        // Win10 / 旧系统拿不到 Mica：撤掉透明层，让 CSS 退回实底。
        document.documentElement.classList.toggle("has-mica", applied === true);
      });
    })
    .catch((error: unknown) => {
      document.documentElement.classList.remove("has-mica");
      console.warn("[qaqh-webui] failed to sync native Mica theme", error);
    });
}

function recompute(animate = true): void {
  const root = document.documentElement;
  const next: ResolvedTheme =
    configTheme === "light" || configTheme === "dark"
      ? configTheme
      : systemDark?.matches
        ? "dark"
        : "light";
  const previous = root.dataset.theme;
  if (animate && previous != null && previous !== next && !prefersReducedMotion?.matches) {
    root.classList.add("theme-transition");
    if (themeTransitionTimer != null) window.clearTimeout(themeTransitionTimer);
    themeTransitionTimer = window.setTimeout(() => {
      root.classList.remove("theme-transition");
      themeTransitionTimer = undefined;
    }, 220);
  } else if (!animate || prefersReducedMotion?.matches) {
    root.classList.remove("theme-transition");
    if (themeTransitionTimer != null) window.clearTimeout(themeTransitionTimer);
    themeTransitionTimer = undefined;
  }
  setResolved(next);
  root.dataset.theme = next;
  syncNativeBackdrop(next);
}

/** config 的 theme 值进来(空串 = 跟随系统);config.load 与每次改动都会调用。 */
/**
 * 主题是**本应用窗口的本地偏好**(localStorage),不写 daemon 配置:
 * 桌面壳是唯一消费方(daemon 的 `theme` 字段只服务其它客户端,见
 * `qaqh-config-api` 的 ConfigDto 注释),把它放进后端只会让「改外观」触发
 * 一次无谓的 config.save 热载广播。
 */
const THEME_STORAGE_KEY = "qaqh.theme";

/** 本地主题偏好;null = 从未设置过(冷启动以 daemon 现值为初值做一次性迁移)。 */
export function storedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // 隐私模式等禁用 localStorage:按未设置处理。
    return null;
  }
}

export function applyTheme(value: string | null | undefined, animate = true): void {
  configTheme = value ?? "";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, configTheme);
  } catch {
    // 存不下不影响本次应用。
  }
  recompute(animate);
}

if (systemDark != null) {
  systemDark.addEventListener("change", () => recompute());
  recompute();
}

export const resolvedTheme = resolved;

export type ThemePreset = "default" | "lite" | "liquid-glass" | "zen-console";

export interface ThemePresetOption {
  value: ThemePreset;
  label: string;
  desc?: string;
}

export const THEME_PRESET_OPTIONS: readonly ThemePresetOption[] = [
  { value: "default", label: "跟随系统 / 经典工作台", desc: "原生平台材质与标准缓动动效" },
  { value: "lite", label: "Lite 极简纯净 (纯低配 · 零动效 · 实底)", desc: "专为低配受限硬件打造：彻底停用毛玻璃与循环动效，纯净实色，CPU 零自旋" },
  { value: "liquid-glass", label: "macOS 26 水感流体玻璃 (Liquid Glass)", desc: "大圆角、水感折射浮岛与通透光泽" },
  { value: "zen-console", label: "Zen Console 极简工业终端 (零动效 · 显式指示流)", desc: "无动效瞬切、硬朗线框、闪动圆点状态指示灯" },
] as const;

const PRESET_STORAGE_KEY = "qaqh.theme-preset";

export function storedThemePreset(): ThemePreset {
  try {
    const val = localStorage.getItem(PRESET_STORAGE_KEY) as ThemePreset | null;
    if (val && THEME_PRESET_OPTIONS.some((opt) => opt.value === val)) {
      return val;
    }
    return "default";
  } catch {
    return "default";
  }
}

const [currentPreset, setCurrentPreset] = createSignal<ThemePreset>(storedThemePreset());

/**
 * 应用并切换主题预设。
 * 纯解耦机制：切换时自动清空所有既有 `theme-*` class，并同步设置 `data-theme-preset`，
 * 保证切换到任何主题（包括切回 default）时 100% 干净、无任何历史类名或属性残留。
 */
export function applyThemePreset(preset: ThemePreset): void {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, preset);
  } catch {}
  setCurrentPreset(preset);
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // 1. 彻底清除所有历史主题预设类名，杜绝残留与层叠污染
  for (const cls of Array.from(root.classList)) {
    if (cls.startsWith("theme-")) root.classList.remove(cls);
  }

  // 2. 挂载新预设标识
  if (preset !== "default") {
    root.dataset.themePreset = preset;
    root.classList.add(`theme-${preset}`);
  } else {
    delete root.dataset.themePreset;
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("qaqh:theme-preset", { detail: preset }));
  }
}

export const themePreset = currentPreset;

if (typeof document !== "undefined") {
  const initialPreset = storedThemePreset();
  if (initialPreset !== "default") {
    document.documentElement.dataset.themePreset = initialPreset;
    document.documentElement.classList.add(`theme-${initialPreset}`);
  }
}
