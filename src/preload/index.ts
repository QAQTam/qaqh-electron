import { contextBridge, ipcRenderer } from "electron";

// 回调表
let nextCallbackId = 1;
const callbacks = new Map<number, (payload: any) => void>();

// 事件监听表：eventName -> Set<callbackId>
const eventListeners = new Map<string, Set<number>>();

function transformCallback(callback: (payload: any) => void, once = false): number {
  const id = nextCallbackId++;
  if (once) {
    callbacks.set(id, (payload: any) => {
      callbacks.delete(id);
      callback(payload);
    });
  } else {
    callbacks.set(id, callback);
  }
  return id;
}

function unregisterCallback(id: number): void {
  callbacks.delete(id);
}

// 接收来自主进程的事件并路由到前端的 listen 回调
ipcRenderer.on("tauri:event", (_event, { eventName, payload }) => {
  const listenerIds = eventListeners.get(eventName);
  if (!listenerIds || listenerIds.size === 0) return;

  for (const id of Array.from(listenerIds)) {
    const cb = callbacks.get(id);
    if (cb) {
      try {
        // Tauri 2 规范的 Event 对象结构：{ event, id, payload }
        cb({
          event: eventName,
          id,
          payload,
        });
      } catch (err) {
        console.error(`[preload] Error in event listener for ${eventName}:`, err);
      }
    }
  }
});

// 实现 Tauri 2 的 invoke 机制
async function invokeTauri(cmd: string, args: Record<string, any> = {}, _options?: any): Promise<any> {
  // 拦截 plugin:event|listen
  if (cmd === "plugin:event|listen") {
    const { event, handler } = args;
    if (typeof event === "string" && typeof handler === "number") {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
      }
      eventListeners.get(event)!.add(handler);
      return handler;
    }
    return 0;
  }

  // 拦截 plugin:event|unlisten
  if (cmd === "plugin:event|unlisten") {
    const { event, eventId } = args;
    if (typeof event === "string" && typeof eventId === "number") {
      const set = eventListeners.get(event);
      if (set) {
        set.delete(eventId);
        callbacks.delete(eventId);
      }
    }
    return null;
  }

  // 其余命令走主进程 IPC
  return ipcRenderer.invoke("tauri:invoke", cmd, args);
}

// 构建 __TAURI_INTERNALS__ 对象
const tauriInternals = {
  invoke: invokeTauri,
  transformCallback,
  unregisterCallback,
  ipc(message: any) {
    console.debug("[preload] Tauri raw ipc called:", message);
  },
  metadata: {
    currentWindow: { label: "main" },
    webviews: [{ label: "main" }],
  },
};

const tauriEventPluginInternals = {
  unregisterListener(event: string, eventId: number) {
    const set = eventListeners.get(event);
    if (set) {
      set.delete(eventId);
      callbacks.delete(eventId);
    }
  },
};

// 暴露到 window 全局（兼容 contextIsolation = true/false）
try {
  contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", tauriInternals);
  contextBridge.exposeInMainWorld("__TAURI_EVENT_PLUGIN_INTERNALS__", tauriEventPluginInternals);
  contextBridge.exposeInMainWorld("electronAPI", {
    invoke: (cmd: string, ...args: any[]) => ipcRenderer.invoke(cmd, ...args),
    on: (channel: string, listener: (...args: any[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => listener(...args));
    },
  });
} catch {
  // contextIsolation: false 时的兜底
  (window as any).__TAURI_INTERNALS__ = tauriInternals;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = tauriEventPluginInternals;
}
