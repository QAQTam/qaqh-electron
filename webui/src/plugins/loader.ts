/**
 * 插件热更装载器：接收 main 的 plugins://graph 帧，按 rev 差异
 * dispose → rev-bust reimport → 重挂载。
 *
 * 插件 bundle 走 app:// 同源动态 import（CSP 'self' 覆盖），不进 Vite 构建图；
 * revision 来自 main 的 stat-poll（mtime+size），因此任何写入者都是热更源。
 * release 墙：装载器只应用与首帧同 release 的图，换版本须整页 reload。
 */
import { desktopHost, requireDesktopHost } from "../lib/desktop-host.js";
import type { GitStatusView } from "../lib/git-status.js";
import { startGamepadRawFeed } from "../lib/gamepad.js";
import { createSignal } from "solid-js";

/** 插件宿主 facade：manifest 声明的 capability 决定拿到哪些键。 */
export interface PluginHost {
  /** 原生手柄原始帧（Gamepad API 直读，无导航节流）。 */
  gamepadRaw?: (onFrame: (pad: Gamepad | null) => void) => () => void;
  /** 活动会话工作区的只读 git 状态；main 侧解析 cwd 并跑 git，插件不碰会话注册表。 */
  gitStatus?: () => Promise<GitStatusView>;
}

/** 插件模块形状：default 导出，mount 返回可选 dispose。 */
export interface PluginModule {
  mount(container: HTMLElement, host: PluginHost): void | (() => void);
}

interface GraphEntry {
  id: string;
  rev: string;
  name: string;
  entry: string;
  css?: string;
  light?: string;
  dark?: string;
  slot: string;
  capabilities: string[];
}

interface Graph {
  release: string;
  entries: GraphEntry[];
}

interface LoadedState {
  rev: string;
  container: HTMLElement;
  dispose: (() => void) | null;
}

const loaded = new Map<string, LoadedState>();
let bootRelease: string | null = null;
let warnedRelease: string | null = null;

/* 装载器自述状态:工具页「前端插件」直接显示——图到了没、挂了谁、谁为什么失败,
   不再靠肉眼翻 console。 */
export interface PluginHostStatus {
  frames: number;
  entries: { id: string; name: string; slot: string }[];
  mounted: string[];
  failed: Record<string, string>;
  themeApplied: string | null;
}
let statusFrames = 0;
let statusEntries: PluginHostStatus["entries"] = [];
const statusFailures: Record<string, string> = {};
const [pluginStatus, setPluginStatus] = createSignal<PluginHostStatus>({
  frames: 0, entries: [], mounted: [], failed: {}, themeApplied: null,
});
function publishStatus(): void {
  setPluginStatus({
    frames: statusFrames,
    entries: statusEntries,
    mounted: [...loaded.keys()],
    failed: { ...statusFailures },
    themeApplied: appliedPack?.id ?? null,
  });
}

function facadeFor(entry: GraphEntry): PluginHost {
  const facade: PluginHost = {};
  if (entry.capabilities.includes("gamepad-raw")) facade.gamepadRaw = startGamepadRawFeed;
  if (entry.capabilities.includes("git-status")) {
    facade.gitStatus = () => requireDesktopHost().invoke<GitStatusView>("git_status");
  }
  return facade;
}

function makeContainer(id: string, slot: string): HTMLElement {
  const container = document.createElement("div");
  container.dataset.qaqhPlugin = id;
  if (slot === "overlay") {
    // overlay 插件自管层级与内部 pointer-events；宿主容器只兜底不越权。
    container.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000;";
  }
  document.body.append(container);
  return container;
}

/* ── theme slot:消息主题包(纯 CSS 插件)──────────────────────────────────
   graph 帧里的 theme 条目不 mount JS,只按用户选择挂一张 <link>——
   样式表走 app:// 同源 + rev-bust,和 JS bundle 共用同一套 stat-poll 热更语义。
   插件 CSS 不带 @layer,天然压过 tokens/components 各层(未分层 > 任何层)。 */
const THEME_PACK_KEY = "qaqh.theme-pack";

export interface ThemePackInfo { id: string; name: string; rev: string; css: string }

function readStoredPack(): string {
  try { return localStorage.getItem(THEME_PACK_KEY) ?? ""; } catch { return ""; }
}

const [themePacks, setThemePacks] = createSignal<ThemePackInfo[]>([]);
const [themePackSelection, setPackSelection] = createSignal<string>(readStoredPack());
let packCatalog = new Map<string, ThemePackInfo>();
let appliedPack: { id: string; rev: string } | null = null;

function syncPack(): void {
  const sel = themePackSelection();
  const want = sel !== "" ? (packCatalog.get(sel) ?? null) : null;
  if (appliedPack != null && (want == null || appliedPack.id !== want.id)) {
    document.querySelector("link[data-qaqh-theme-pack]")?.remove();
    appliedPack = null;
  }
  if (want == null || (appliedPack != null && appliedPack.id === want.id && appliedPack.rev === want.rev)) return;
  let link = document.querySelector<HTMLLinkElement>("link[data-qaqh-theme-pack]");
  if (link == null) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    document.head.append(link);
  }
  link.setAttribute("data-qaqh-theme-pack", want.id);
  link.href = `app://localhost/plugins/${want.id}/${want.css}?rev=${want.rev}`;
  appliedPack = { id: want.id, rev: want.rev };
  publishStatus();
}

/** 设置页入口:id="" = 经典(卸载 link)。选择是本窗口偏好,与主题深浅同走 localStorage。 */
export function setThemePackSelection(id: string): void {
  try { localStorage.setItem(THEME_PACK_KEY, id); } catch { /* 存不下不影响本次应用 */ }
  setPackSelection(id);
  syncPack();
}

/* ── syntax-theme slot:diff 语法主题包(纯 JSON 资产,无 JS 无 CSS)─────────
    manifest 带 light/dark 两份 shiki 主题 JSON;消费方是 diff/highlight.ts,
    按 mode 取一份经 app:// fetch 注册进 highlighter(注册名含 rev,热更即重载)。
    选择与主题包同纪律:本窗口偏好,localStorage,空串 = 内置 github 对。 */
const SYNTAX_PACK_KEY = "qaqh.syntax-pack";

export interface SyntaxThemePackInfo { id: string; name: string; rev: string; light: string; dark: string }
/** 交给高亮宿主的引用:两份主题的 rev-bust URL。 */
export interface SyntaxPackRef { id: string; rev: string; light: string; dark: string }

function readStoredSyntaxPack(): string {
  try { return localStorage.getItem(SYNTAX_PACK_KEY) ?? ""; } catch { return ""; }
}

const [syntaxThemes, setSyntaxThemes] = createSignal<SyntaxThemePackInfo[]>([]);
const [syntaxPackSelection, setSyntaxSelection] = createSignal<string>(readStoredSyntaxPack());

export function setSyntaxPackSelection(id: string): void {
  try { localStorage.setItem(SYNTAX_PACK_KEY, id); } catch { /* 存不下不影响本次应用 */ }
  setSyntaxSelection(id);
}

/** 当前选择的语法主题包引用;未选择或包已失配(被删/禁用)返回 null = 内置对。
 *  读 signal 保持反应式:graph 帧推进 rev 时消费方(diff effect)自动重算。 */
export function syntaxPackRef(): SyntaxPackRef | null {
  const sel = syntaxPackSelection();
  if (sel === "") return null;
  const pack = syntaxThemes().find((entry) => entry.id === sel);
  if (pack == null) return null;
  const base = `app://localhost/plugins/${pack.id}`;
  return {
    id: pack.id,
    rev: pack.rev,
    light: `${base}/${pack.light}?rev=${pack.rev}`,
    dark: `${base}/${pack.dark}?rev=${pack.rev}`,
  };
}

async function mount(entry: GraphEntry): Promise<void> {
  const url = `app://localhost/plugins/${entry.id}/${entry.entry}?rev=${entry.rev}`;
  const container = makeContainer(entry.id, entry.slot);
  const mod = (await import(/* @vite-ignore */ url)) as { default?: PluginModule };
  const plugin = mod.default;
  if (plugin == null || typeof plugin.mount !== "function") {
    container.remove();
    throw new Error(`插件 ${entry.id} 缺少 default.mount`);
  }
  const dispose = plugin.mount(container, facadeFor(entry));
  loaded.set(entry.id, {
    rev: entry.rev,
    container,
    dispose: typeof dispose === "function" ? dispose : null,
  });
}

function teardown(id: string): void {
  const state = loaded.get(id);
  if (state == null) return;
  loaded.delete(id);
  state.dispose?.();
  state.container.remove();
}

async function reconcile(graph: Graph): Promise<void> {
  if (bootRelease == null) bootRelease = graph.release;
  if (graph.release !== bootRelease) {
    if (warnedRelease !== graph.release) {
      warnedRelease = graph.release;
      console.warn(`[plugins] 宿主已切换到 ${graph.release}（页面 boot 于 ${bootRelease}），忽略本帧；整页刷新后生效`);
    }
    return;
  }
  // 只有 overlay 走 JS mount;theme/syntax-theme 是纯资产,各自走 link/fetch。
  const desired = new Map(graph.entries.filter((entry) => entry.slot === "overlay").map((entry) => [entry.id, entry]));
  for (const [id, state] of [...loaded]) {
    const next = desired.get(id);
    if (next != null && next.rev === state.rev) {
      desired.delete(id);
      continue;
    }
    teardown(id);
  }
  for (const entry of desired.values()) {
    try {
      await mount(entry);
      delete statusFailures[entry.id];
    } catch (error) {
      statusFailures[entry.id] = error instanceof Error ? error.message : String(error);
      console.error(`[plugins] ${entry.id} 装载失败（下次 graph 帧可重试）:`, error);
    }
  }
  // theme 目录整帧刷新:被删掉的主题包在这里自然失配,syncPack 会把 link 撤下。
  packCatalog = new Map(
    graph.entries
      .filter((entry): entry is GraphEntry & { css: string } => entry.slot === "theme" && typeof entry.css === "string")
      .map((entry) => [entry.id, { id: entry.id, name: entry.name, rev: entry.rev, css: entry.css }]),
  );
  setThemePacks([...packCatalog.values()]);
  syncPack();
  // syntax 目录整帧刷新:失配包自然出局,syntaxPackRef 随之回退内置对。
  setSyntaxThemes(
    graph.entries
      .filter((entry): entry is GraphEntry & { light: string; dark: string } =>
        entry.slot === "syntax-theme" && typeof entry.light === "string" && typeof entry.dark === "string")
      .map((entry) => ({ id: entry.id, name: entry.name, rev: entry.rev, light: entry.light, dark: entry.dark })),
  );
  statusFrames += 1;
  statusEntries = graph.entries.map((entry) => ({ id: entry.id, name: entry.name, slot: entry.slot }));
  publishStatus();
}

/** App 启动时调用一次；非 Electron 环境为 no-op。 */
export function startPluginHost(): void {
  const host = desktopHost();
  if (host == null) return;
  host.listen("plugins://graph", (payload) => {
    reconcile(payload as Graph);
  });
}

/** 当前图里可用的主题包/语法主题包目录(设置页消费);pluginStatus = 装载器自述状态(工具页消费)。 */
export { themePacks, themePackSelection, pluginStatus, syntaxThemes, syntaxPackSelection };
