/**
 * 插件注册表：扫描插件根目录 → 计算 revision → 向渲染层推送 graph 帧。
 *
 * 可移植件来自 dsh client-hmr 的验证结论：stat-poll 产物（mtime+size 即
 * revision，不 hash 内容）、单向帧推送、任何写入者（bun/vite/esbuild）都是
 * 合法热更源。main 自身就是 Node，帧经 webContents.send 直达渲染层，无需 SSE。
 */
import { app, type BrowserWindow } from "electron";
import { join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isPluginDisabled, userPluginsRoot } from "./frontend-plugins.js";

/** 管理动作（导入/启停/删除）后立刻重扫推送，不等下一个 1s tick。 */
let pluginTickNotify: (() => void) | null = null;
export function notifyPluginsChanged(): void { pluginTickNotify?.(); }

/** 渲染层 graph 帧里的一条插件（manifest 摘要 + revision）。 */
export interface PluginGraphEntry {
  id: string;
  /** mtime+size 派生的 revision：任何产物改写都会推进它。 */
  rev: string;
  name: string;
  /** JS 入口相对路径（manifest.entry 原样）；theme 包无 JS 时为空串。 */
  entry: string;
  /** theme 包的样式表相对路径（manifest.css 原样）；其余 slot 无。 */
  css?: string;
  /** syntax-theme 包的两份 shiki 主题 JSON 相对路径（manifest.light/dark 原样）。 */
  light?: string;
  dark?: string;
  slot: "overlay" | "theme" | "syntax-theme";
  capabilities: string[];
}

export interface PluginGraph {
  /** 宿主 release 标识：渲染层只应用同 release 的帧（release 墙）。 */
  release: string;
  entries: PluginGraphEntry[];
}

/** 插件根目录：打包=resources/plugins，开发=仓库根 plugins/。 */
export function pluginsRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, "plugins") : resolve(process.cwd(), "plugins");
}

interface ManifestFile {
  id?: unknown;
  name?: unknown;
  entry?: unknown;
  css?: unknown;
  light?: unknown;
  dark?: unknown;
  slot?: unknown;
  capabilities?: unknown;
}

/** 扫描一个插件目录；manifest 缺失/非法 → 告警跳过（与 dsh "broken bundle 不能启用" 同语义）。 */
function scanPlugin(root: string, dir: string): PluginGraphEntry | null {
  const manifestPath = join(root, dir, "plugin.json");
  let manifest: ManifestFile;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestFile;
  } catch (error) {
    console.warn(`[plugins] ${dir}: plugin.json 不可读，跳过（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
  if (manifest.id !== dir) {
    console.warn(`[plugins] ${dir}: manifest.id 必须等于目录名，跳过`);
    return null;
  }
  // theme slot = 纯 CSS 主题包:只带 manifest.css,无 JS 入口也要能进图——
  // 导入一个文件夹即热应用,渲染层按用户选择挂 <link>(rev-bust 走 app:// 同源)。
  const isTheme = manifest.slot === "theme";
  const isOverlay = manifest.slot === "overlay";
  const isSyntax = manifest.slot === "syntax-theme";
  if (!isTheme && !isOverlay && !isSyntax) {
    console.warn(`[plugins] ${dir}: 未知 slot ${String(manifest.slot)}，跳过`);
    return null;
  }
  // syntax-theme = diff 语法主题包:light/dark 两份 shiki 主题 JSON 缺一不可,
  // 渲染层按界面明暗取一份注册进 highlighter。纯资产,无 JS 入口。
  if (isSyntax) {
    const light = typeof manifest.light === "string" && manifest.light !== "" ? manifest.light : null;
    const dark = typeof manifest.dark === "string" && manifest.dark !== "" ? manifest.dark : null;
    if (light == null || dark == null) {
      console.warn(`[plugins] ${dir}: syntax-theme 须同时带 light 与 dark 字段，跳过`);
      return null;
    }
    const lightPath = join(root, dir, light);
    const darkPath = join(root, dir, dark);
    if (!existsSync(lightPath) || !existsSync(darkPath)) {
      console.warn(`[plugins] ${dir}: ${light} / ${dark} 缺失，跳过`);
      return null;
    }
    const m = statSync(manifestPath);
    const l = statSync(lightPath);
    const k = statSync(darkPath);
    return {
      id: dir,
      rev: `${Math.max(m.mtimeMs, l.mtimeMs, k.mtimeMs).toFixed(0)}:${l.size + k.size}:${m.size}`,
      name: typeof manifest.name === "string" ? manifest.name : dir,
      entry: "",
      light,
      dark,
      slot: "syntax-theme",
      capabilities: [],
    };
  }
  const assetRel = isTheme
    ? (typeof manifest.css === "string" && manifest.css !== "" ? manifest.css : null)
    : (typeof manifest.entry === "string" && manifest.entry !== "" ? manifest.entry : null);
  if (assetRel == null) {
    console.warn(`[plugins] ${dir}: theme 须带 css 字段、overlay 须带 entry 字段，跳过`);
    return null;
  }
  const assetPath = join(root, dir, assetRel);
  if (!existsSync(assetPath)) {
    console.warn(`[plugins] ${dir}: ${assetRel} 不存在（先跑构建），跳过`);
    return null;
  }
  const m = statSync(manifestPath);
  const e = statSync(assetPath);
  return {
    id: dir,
    rev: `${Math.max(m.mtimeMs, e.mtimeMs).toFixed(0)}:${e.size}:${m.size}`,
    name: typeof manifest.name === "string" ? manifest.name : dir,
    entry: isTheme ? "" : assetRel,
    ...(isTheme ? { css: assetRel } : {}),
    slot: isTheme ? "theme" : "overlay",
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
  };
}

/** 双根合并：bundled（缺省件，只读）+ 用户根（~/.qaqh/frontend-plugin，导入与管理面）。
 *  同名 id 用户覆盖 bundled；禁用名单里的条目不进图（graph 是"生效面"，管理页另走 IPC 全量）。 */
function scanGraph(): PluginGraphEntry[] {
  const byId = new Map<string, PluginGraphEntry>();
  for (const root of [pluginsRoot(), userPluginsRoot()]) {
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
    } catch {
      continue; // 根不存在 = 空贡献，不是错误。
    }
    for (const dir of dirs) {
      const entry = scanPlugin(root, dir);
      if (entry != null) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()]
    .filter((entry) => !isPluginDisabled(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 启动 stat-poll（1s 周期，每插件 2 次 stat，开销可忽略）。
 * 图变化才发帧；返回停止函数。
 */
export function startPluginRegistry(getWindow: () => BrowserWindow | null): () => void {
  const release = app.getVersion();
  let last = "";
  const push = (entries: PluginGraphEntry[]): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("qaqh:event:plugins://graph", { release, entries } satisfies PluginGraph);
    }
  };
  const tick = (): void => {
    const win = getWindow();
    if (win == null || win.isDestroyed()) return; // 窗口未就绪:不消费变化签名,留给下一帧
    const key = JSON.stringify(scanGraph());
    if (key !== last) {
      last = key;
      push(JSON.parse(key) as PluginGraphEntry[]);
    }
  };
  // 强发语义:渲染层监听器是随页面/重载注册的,错过首发就永远静默——
  // did-finish-load 与本地管理动作都走这里清空签名、当帧重发。
  pluginTickNotify = () => {
    last = "";
    tick();
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    if (pluginTickNotify === tick) pluginTickNotify = null;
  };
}
