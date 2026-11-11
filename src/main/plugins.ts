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

/** 渲染层 graph 帧里的一条插件（manifest 摘要 + revision）。 */
export interface PluginGraphEntry {
  id: string;
  /** mtime+size 派生的 revision：任何产物改写都会推进它。 */
  rev: string;
  name: string;
  /** entry 相对路径（manifest.entry 原样）。 */
  entry: string;
  slot: "overlay";
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
  slot?: unknown;
  capabilities?: unknown;
}

/** 扫描一个插件目录；manifest 缺失/非法 → 告警跳过（与 dsh "broken bundle 不能启用" 同语义）。 */
function scanPlugin(dir: string, release: string): PluginGraphEntry | null {
  const root = pluginsRoot();
  const manifestPath = join(root, dir, "plugin.json");
  let manifest: ManifestFile;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestFile;
  } catch (error) {
    console.warn(`[plugins] ${dir}: plugin.json 不可读，跳过（${error instanceof Error ? error.message : String(error)}）`);
    return null;
  }
  if (manifest.id !== dir || typeof manifest.entry !== "string" || manifest.entry === "") {
    console.warn(`[plugins] ${dir}: manifest.id 必须等于目录名且 entry 必须存在，跳过`);
    return null;
  }
  if (manifest.slot !== "overlay") {
    console.warn(`[plugins] ${dir}: 未知 slot ${String(manifest.slot)}，跳过`);
    return null;
  }
  const entryPath = join(root, dir, manifest.entry);
  if (!existsSync(entryPath)) {
    console.warn(`[plugins] ${dir}: entry ${manifest.entry} 不存在（先跑构建），跳过`);
    return null;
  }
  const m = statSync(manifestPath);
  const e = statSync(entryPath);
  return {
    id: dir,
    rev: `${Math.max(m.mtimeMs, e.mtimeMs).toFixed(0)}:${e.size}:${m.size}`,
    name: typeof manifest.name === "string" ? manifest.name : dir,
    entry: manifest.entry,
    slot: "overlay",
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
  };
}

function scanGraph(release: string): PluginGraphEntry[] {
  let dirs: string[];
  try {
    dirs = readdirSync(pluginsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // 插件根不存在 = 空图（开发首跑常态），不是错误。
  }
  return dirs
    .map((dir) => scanPlugin(dir, release))
    .filter((entry): entry is PluginGraphEntry => entry != null)
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
    const key = JSON.stringify(scanGraph(release));
    if (key !== last) {
      last = key;
      push(JSON.parse(key) as PluginGraphEntry[]);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
