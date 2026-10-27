/**
 * 纯前端字体排版管理引擎 (Typography Engine)
 *
 * 职责:
 *  1. 全局字号比例等比缩放 (--font-scale: 0.9 ~ 1.2);
 *  2. 四大核心语义字体槽位解耦 (--font-ui, --font-prose, --font-code, --font-terminal);
 *  3. 纯前端本地持久化 (localStorage)，不与后端配置往返，启动首帧无闪烁生效。
 */
import { createSignal } from "solid-js";

export type FontScale = "compact" | "normal" | "comfortable" | "large";

export const FONT_SCALE_FACTORS: Record<FontScale, number> = {
  compact: 0.9,
  normal: 1.0,
  comfortable: 1.1,
  large: 1.2,
};

export const FONT_SCALE_OPTIONS: Array<{ value: FontScale; label: string; desc: string }> = [
  { value: "compact", label: "紧凑 (90%)", desc: "高密排版，适合宽屏多列并排" },
  { value: "normal", label: "标准 (100%)", desc: "默认视觉尺寸" },
  { value: "comfortable", label: "舒适 (110%)", desc: "字怀微扩，提升阅读舒适感" },
  { value: "large", label: "大号 (120%)", desc: "高清晰度，适合高 DPI 或远视距" },
];

export interface TypographyState {
  scale: FontScale;
  fontUi: string;
  fontProse: string;
  fontCode: string;
  fontTerminal: string;
}

export const DEFAULT_TYPOGRAPHY: TypographyState = {
  scale: "normal",
  fontUi: "",
  fontProse: "",
  fontCode: "",
  fontTerminal: "",
};

export const FONT_PRESETS = {
  ui: [
    { label: "系统默认 (推荐)", value: "" },
    { label: "苹方 (PingFang SC)", value: '"PingFang SC", system-ui, sans-serif' },
    { label: "鸿蒙黑体 (HarmonyOS Sans)", value: '"QAQH HarmonyOS Sans SC", system-ui, sans-serif' },
    { label: "Segoe UI Variable", value: '"Segoe UI Variable Text", system-ui, sans-serif' },
    { label: "微软雅黑 (Microsoft YaHei)", value: '"Microsoft YaHei UI", system-ui, sans-serif' },
  ],
  prose: [
    { label: "界面一致 (跟随 UI)", value: "" },
    { label: "清晰阅读 (苹方 / 西文比例)", value: '"PingFang SC", "Segoe UI Variable Text", system-ui, sans-serif' },
    { label: "鸿蒙阅读体", value: '"QAQH HarmonyOS Sans SC", system-ui, sans-serif' },
    { label: "霞鹜文楷 / 楷体 (LXGW WenKai)", value: '"LXGW WenKai", "Kaiti SC", "STKaiti", serif' },
    { label: "思源宋体 (Source Han Serif)", value: '"Source Han Serif SC", "Songti SC", "SimSun", serif' },
  ],
  code: [
    { label: "Cascadia Code (内置推荐)", value: "" },
    { label: "JetBrains Mono", value: '"JetBrains Mono", "QAQH Cascadia Code", ui-monospace, monospace' },
    { label: "Fira Code", value: '"Fira Code", "QAQH Cascadia Code", ui-monospace, monospace' },
    { label: "SF Mono", value: '"SF Mono", "Monaco", ui-monospace, monospace' },
    { label: "Consolas", value: '"Consolas", "QAQH Cascadia Code", ui-monospace, monospace' },
  ],
  terminal: [
    { label: "Menlo / Consolas (工业推荐)", value: "" },
    { label: "Cascadia Code (内置)", value: '"QAQH Cascadia Code", ui-monospace, monospace' },
    { label: "JetBrains Mono", value: '"JetBrains Mono", ui-monospace, monospace' },
    { label: "系统等宽 (System Monospace)", value: 'ui-monospace, monospace' },
  ],
};

const TYPOGRAPHY_STORAGE_KEY = "qaqh.typography";

export function loadStoredTypography(): TypographyState {
  if (typeof window === "undefined") return { ...DEFAULT_TYPOGRAPHY };
  try {
    const raw = localStorage.getItem(TYPOGRAPHY_STORAGE_KEY);
    if (raw == null) return { ...DEFAULT_TYPOGRAPHY };
    const parsed = JSON.parse(raw) as Partial<TypographyState>;
    return {
      scale: parsed.scale != null && parsed.scale in FONT_SCALE_FACTORS ? parsed.scale : DEFAULT_TYPOGRAPHY.scale,
      fontUi: typeof parsed.fontUi === "string" ? parsed.fontUi : "",
      fontProse: typeof parsed.fontProse === "string" ? parsed.fontProse : "",
      fontCode: typeof parsed.fontCode === "string" ? parsed.fontCode : "",
      fontTerminal: typeof parsed.fontTerminal === "string" ? parsed.fontTerminal : "",
    };
  } catch {
    return { ...DEFAULT_TYPOGRAPHY };
  }
}

const [typographySignal, setTypographySignal] = createSignal<TypographyState>(loadStoredTypography());

function applyDomTypography(state: TypographyState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  
  // 1. 字号缩放
  const factor = FONT_SCALE_FACTORS[state.scale] ?? 1.0;
  root.style.setProperty("--font-scale", String(factor));
  root.dataset.fontScale = state.scale;

  // 2. 四大字体槽位
  if (state.fontUi.trim()) {
    root.style.setProperty("--font-ui", state.fontUi);
  } else {
    root.style.removeProperty("--font-ui");
  }

  if (state.fontProse.trim()) {
    root.style.setProperty("--font-prose", state.fontProse);
  } else {
    root.style.removeProperty("--font-prose");
  }

  if (state.fontCode.trim()) {
    root.style.setProperty("--font-code", state.fontCode);
  } else {
    root.style.removeProperty("--font-code");
  }

  if (state.fontTerminal.trim()) {
    root.style.setProperty("--font-terminal", state.fontTerminal);
  } else {
    root.style.removeProperty("--font-terminal");
  }
}

export function updateTypography(patch: Partial<TypographyState>): void {
  const next = { ...typographySignal(), ...patch };
  try {
    localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  setTypographySignal(next);
  applyDomTypography(next);
}

export function resetTypography(): void {
  updateTypography(DEFAULT_TYPOGRAPHY);
}

export const typography = typographySignal;

// 首帧初始化激活
if (typeof document !== "undefined") {
  applyDomTypography(loadStoredTypography());
}
