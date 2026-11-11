/**
 * 插件热更装载器：接收 main 的 plugins://graph 帧，按 rev 差异
 * dispose → rev-bust reimport → 重挂载。
 *
 * 插件 bundle 走 app:// 同源动态 import（CSP 'self' 覆盖），不进 Vite 构建图；
 * revision 来自 main 的 stat-poll（mtime+size），因此任何写入者都是热更源。
 * release 墙：装载器只应用与首帧同 release 的图，换版本须整页 reload。
 */
import { desktopHost } from "../lib/desktop-host.js";
import { startGamepadRawFeed } from "../lib/gamepad.js";

/** 插件宿主 facade：manifest 声明的 capability 决定拿到哪些键。 */
export interface PluginHost {
  /** 原生手柄原始帧（Gamepad API 直读，无导航节流）。 */
  gamepadRaw?: (onFrame: (pad: Gamepad | null) => void) => () => void;
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

function facadeFor(entry: GraphEntry): PluginHost {
  const facade: PluginHost = {};
  if (entry.capabilities.includes("gamepad-raw")) facade.gamepadRaw = startGamepadRawFeed;
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
  const desired = new Map(graph.entries.map((entry) => [entry.id, entry]));
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
    } catch (error) {
      console.error(`[plugins] ${entry.id} 装载失败（下次 graph 帧可重试）:`, error);
    }
  }
}

/** App 启动时调用一次；非 Electron 环境为 no-op。 */
export function startPluginHost(): void {
  const host = desktopHost();
  if (host == null) return;
  host.listen("plugins://graph", (payload) => {
    reconcile(payload as Graph);
  });
}
