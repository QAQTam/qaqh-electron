/**
 * 渲染层偏好唯一通道。webui 已是 Electron 渲染层,偏好不该再散写 localStorage
 * (缓存清理即丢、无法随 userData 备份):桌面壳下全部走主进程 prefs.json。
 *
 * - 桌面(host.prefs 存在):入口 await ensurePrefs() 拍一次快照进内存表,读全同步
 *   ——module-eval 期同步读的语义由「先水合后求值」门闩保序;写乐观
 *   更新内存表 + 异步落盘,失败只出声不回滚(下次写会带全值)。
 * - 无宿主(vitest/headless harness 的 mock 里没 prefs):直接读写 localStorage,
 *   测试与开发页零改动。这是宿主探测(profile),不是每个调用点套一层兼容。
 * - 一次性迁移:桌面首启把 localStorage 里的 `qaqh.*` 存量偏好搬进 prefs.json
 *   并删除原键;会话数据前缀(草稿/标题)不搬——它们是高频大体积的工作数据,
 *   不是偏好。
 */
import { desktopHost } from "./desktop-host";

const SESSION_DATA_PREFIXES = ["qaqh.draft.", "qaqh.session.title."];

const host = desktopHost();
const table = new Map<string, string | null>();
let localStorageAvailable = true;
try {
  void localStorage.length;
} catch {
  localStorageAvailable = false;
}

function migrateLegacy(snapshot: Record<string, string>): void {
  if (!localStorageAvailable) return;
  const legacy: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key == null || !key.startsWith("qaqh.") || key in snapshot) continue;
      if (SESSION_DATA_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      legacy.push(key);
    }
  } catch {
    return;
  }
  for (const key of legacy) {
    const value = localStorage.getItem(key);
    if (value == null) continue;
    table.set(key, value);
    const prefs = host?.prefs;
    if (prefs == null) continue;
    void prefs.set(key, value).then(() => {
      try { localStorage.removeItem(key); } catch { /* 删不掉只是多留一份旧值,快照优先 */ }
    }).catch(() => { /* 迁移失败下次启动重试:快照里还没有这个键 */ });
  }
}

let hydratePromise: Promise<void> | null = null;

/**
 * 入口门闩:水合快照到位后才放行应用模块求值(index.tsx await 这里)。
 * module-eval 期同步读(prefGet)的语义由「先水合后求值」保序,读侧零 await;
 * 无宿主环境(vitest/headless)立即完成。模块求值期即自发启动,非门闩入口
 * 的 QA 检查页也能最终拿到水合表(仅初始默认可能短暂回退,QA 面)。
 */
export function ensurePrefs(): Promise<void> {
  if (hydratePromise != null) return hydratePromise;
  hydratePromise = (async () => {
    if (host?.prefs == null) return; // 无宿主:localStorage 直读,无水合步骤
    const snapshot = await host.prefs.snapshot();
    for (const [key, value] of Object.entries(snapshot)) table.set(key, value);
    migrateLegacy(snapshot);
  })();
  return hydratePromise;
}

void ensurePrefs();

export const prefGet = (key: string): string | null => {
  if (host?.prefs != null) return table.get(key) ?? null;
  if (!localStorageAvailable) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const prefSet = (key: string, value: string | null): void => {
  if (host?.prefs != null) {
    table.set(key, value);
    void host.prefs.set(key, value).catch(() => {
      console.warn(`[prefs] 落盘失败: ${key}`);
    });
    return;
  }
  if (!localStorageAvailable) return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 隐私模式等写入失败:本次会话内内存值不回滚。
  }
};
