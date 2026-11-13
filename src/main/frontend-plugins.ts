/**
 * 前端插件管理（用户根 `~/.qaqh/frontend-plugin`）。
 *
 * 两个来源根：
 *   - bundled：打包 = resources/plugins，开发 = 仓库 plugins/（只读缺省件）；
 *   - user：导入与管理根（zip / 文件夹都落在这里），同名 id 覆盖 bundled。
 * 禁用态写 user 根 state.json（只存 id 名单）。插件是纯数据：
 * plugins.ts 的 1s stat-poll 本就是热更源，导入/启停/删除都无需重启。
 */
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export type PluginSource = "bundled" | "user";

export interface ManagedPlugin {
  id: string;
  name: string;
  version: string;
  slot: string;
  source: PluginSource;
  enabled: boolean;
  path: string;
}

/** 用户根：不存在则创建（导入是它的唯一写入者；state.json 也住这里）。 */
export function userPluginsRoot(): string {
  const root = join(homedir(), ".qaqh", "frontend-plugin");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

const STATE_FILE = "state.json";

function statePath(): string { return join(userPluginsRoot(), STATE_FILE); }

function loadDisabled(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as { disabled?: unknown };
    return new Set(Array.isArray(raw.disabled) ? raw.disabled.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveDisabled(disabled: Set<string>): void {
  writeFileSync(statePath(), JSON.stringify({ disabled: [...disabled] }, null, 2), "utf8");
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface RawManifest { id?: unknown; name?: unknown; version?: unknown; slot?: unknown }

/** 读目录里的 plugin.json；非法 manifest / 非法 id → null（管理页与扫描共用同一判据）。 */
function readManifest(dir: string): RawManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) as RawManifest;
    if (typeof manifest.id !== "string" || !ID_RE.test(manifest.id)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function toManaged(dir: string, source: PluginSource, disabled: Set<string>): ManagedPlugin | null {
  const manifest = readManifest(dir);
  if (manifest == null) return null;
  return {
    id: String(manifest.id),
    name: typeof manifest.name === "string" ? manifest.name : String(manifest.id),
    version: typeof manifest.version === "string" ? manifest.version : "",
    slot: typeof manifest.slot === "string" ? manifest.slot : "",
    source,
    enabled: !disabled.has(String(manifest.id)),
    path: dir,
  };
}

function listRoot(root: string, source: PluginSource, disabled: Set<string>): ManagedPlugin[] {
  let dirs: string[];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return []; }
  return dirs
    .map((dir) => toManaged(join(root, dir), source, disabled))
    .filter((p): p is ManagedPlugin => p != null);
}

/** 管理页数据源：两个根合并，user 覆盖 bundled 同名，含禁用条目（graph 只发启用的）。 */
export function listManagedPlugins(bundledRoot: string): ManagedPlugin[] {
  const disabled = loadDisabled();
  const byId = new Map<string, ManagedPlugin>();
  for (const plugin of [...listRoot(bundledRoot, "bundled", disabled), ...listRoot(userPluginsRoot(), "user", disabled)]) {
    byId.set(plugin.id, plugin);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function isPluginDisabled(id: string): boolean { return loadDisabled().has(id); }

export function setPluginEnabled(bundledRoot: string, id: string, enabled: boolean): void {
  if (!existsSync(join(bundledRoot, id)) && !existsSync(join(userPluginsRoot(), id))) {
    throw new Error(`插件 ${id} 不存在`);
  }
  const disabled = loadDisabled();
  if (enabled) disabled.delete(id); else disabled.add(id);
  saveDisabled(disabled);
}

export function removePlugin(id: string): void {
  const dir = join(userPluginsRoot(), id);
  if (!existsSync(dir)) throw new Error(`仅用户导入的插件可删除（${id} 不在用户根）`);
  rmSync(dir, { recursive: true, force: true });
  const disabled = loadDisabled();
  if (disabled.delete(id)) saveDisabled(disabled);
}

/**
 * 导入：sourcePath = 插件文件夹 或 .zip 包（zip 顶层可多一层目录）。
 * 落位规则：以 manifest.id 命名，写进用户根；重复导入 = 覆盖同 id。
 * 返回管理视图；manifest 非法 / 缺 plugin.json 抛错给 UI 直接显示。
 */
export function importPlugin(sourcePath: string): ManagedPlugin {
  let staging = sourcePath;
  let cleanup: string | null = null;
  try {
    const st = statSync(sourcePath);
    if (st.isFile()) {
      if (!sourcePath.toLowerCase().endsWith(".zip")) throw new Error("只支持 .zip 包或裸露插件文件夹");
      cleanup = join(tmpdir(), `qaqh-plugin-import-${Date.now()}`);
      mkdirSync(cleanup, { recursive: true });
      new AdmZip(sourcePath).extractAllTo(cleanup, true);
      // zip 常见形态是套一层同名目录:plugin.json 不在顶层就下探一级。
      if (readManifest(cleanup) == null) {
        const children = readdirSync(cleanup, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(cleanup!, d.name));
        const found = children.find((child) => readManifest(child) != null);
        if (found == null) throw new Error("zip 内未找到含合法 plugin.json 的插件目录");
        staging = found;
      } else {
        staging = cleanup;
      }
    }
    const manifest = readManifest(staging);
    if (manifest == null) throw new Error(`未找到合法 plugin.json（id 需匹配 ${ID_RE.source}）`);
    const id = String(manifest.id);
    const target = join(userPluginsRoot(), id);
    if (staging === target) return toManaged(target, "user", loadDisabled())!; // 就地导入:不自我复制
    cpSync(staging, target, { recursive: true, force: true });
    const disabled = loadDisabled();
    if (disabled.delete(id)) saveDisabled(disabled); // 导入即启用
    return toManaged(target, "user", disabled)!;
  } finally {
    if (cleanup != null) rmSync(cleanup, { recursive: true, force: true });
  }
}

export function pluginPath(id: string): string {
  const user = join(userPluginsRoot(), id);
  return existsSync(user) ? user : join(userPluginsRoot(), basename(id));
}
