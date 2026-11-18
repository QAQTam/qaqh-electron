/**
 * 壳层偏好存储:userData/prefs.json,渲染进程全部「本地偏好」的唯一落盘点。
 *
 * 取代散落在 12 个模块里的 localStorage 写入:缓存清理不再丢配置,文件可随
 * userData 整体备份/迁移。语义与 widget-states.ts 同一套路(单文件 kv、
 * 写串行),快照接口走 invoke——渲染层入口挂载前 await 水合(webui prefs.ts 门闩保序),
 * module-eval 期同步读的语义由「先水合后求值」保证;后续 set 全异步。
 *
 * 键值一律字符串;格式由各消费模块自定("1"/"0"、JSON、枚举)。坏数据
 * (非字符串值)读取时丢弃,不做半句信任。
 */
import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PrefMap = Record<string, string>;

let cache: PrefMap | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function prefsFile(): string {
  return join(app.getPath("userData"), "prefs.json");
}

/** 首调用读盘(同步,文件是 KB 级小表),之后全走缓存。 */
export function readPrefsSync(): PrefMap {
  if (cache !== null) return cache;
  const table: PrefMap = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefsFile(), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") table[key] = value;
      }
    }
  } catch {
    // 文件缺失/损坏都从空表继续(迁移会把 localStorage 存量补进来)。
  }
  cache = table;
  return table;
}

function flushSync(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (cache === null) return;
  const file = prefsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache), "utf8");
}

/** value=null 删除该键。200ms 尾沿合并(侧栏拖宽这类连写只落一次盘);
 *  before-quit 同步刷掉最后一窗,退出也不丢设置。 */
export function writePref(key: string, value: string | null): void {
  if (key === "") return;
  const table = readPrefsSync();
  if (value === null) delete table[key];
  else table[key] = value;
  if (flushTimer === null) flushTimer = setTimeout(() => { flushTimer = null; flushSync(); }, 200);
}

app.on("before-quit", () => flushSync());

