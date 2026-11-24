import { contextBridge, ipcRenderer } from "electron";

const events = new Set([
  "projection://status", "projection://event", "projection://bootstrap", "projection://reset", "conn://incompatible",
  "conn://error", "conn://liveness", "conn://reconnect",
  "model-picker:changed", "app://window-state", "browser-view://state",
  "plugins://graph",
  "voice://status",
  "notify://handoff",
  "app://found-in-page",
  "app://shell-frame",
]);

contextBridge.exposeInMainWorld("qaqhHost", {
  platform: "electron",
  invoke: (command: string, args: Record<string, unknown> = {}) =>
    ipcRenderer.invoke("qaqh:invoke", command, args),
  listen: (eventName: string, callback: (payload: unknown) => void) => {
    if (!events.has(eventName)) throw new Error(`Unsupported QAQH event: ${eventName}`);
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(`qaqh:event:${eventName}`, listener);
    return () => ipcRenderer.removeListener(`qaqh:event:${eventName}`, listener);
  },
  windowControls: {
    state: () => ipcRenderer.invoke("qaqh:window-state"),
    hide: () => ipcRenderer.invoke("qaqh:window-hide"),
    show: () => ipcRenderer.invoke("qaqh:window-show"),
    setCloseToTray: (value: boolean) => ipcRenderer.invoke("qaqh:window-close-to-tray", value),
    setTrayStatus: (text: string) => ipcRenderer.invoke("qaqh:tray-status", text),
    setTitleBarOverlay: (options: { color?: string; symbolColor?: string }) => ipcRenderer.invoke("qaqh:titlebar-overlay", options),
  },
  devtools: {
    toggle: () => ipcRenderer.invoke("qaqh:devtools-toggle") as Promise<boolean>,
    blinkMemory: () => {
      const fn = (process as NodeJS.Process & { getBlinkMemoryInfo?: () => { allocated: number; total: number } }).getBlinkMemoryInfo;
      return typeof fn === "function" ? fn.call(process) : null;
    },
  },
  devmode: {
    /** 开发者模式开/关同步到主进程(Dev Surface 的 MCP 可见性门控,不落盘)。 */
    set: (enabled: boolean) => ipcRenderer.invoke("qaqh:devmode-set", { enabled }) as Promise<boolean>,
  },
  powerBlocker: {
    set: (mode: "off" | "keep-awake" | "keep-awake-bright") => ipcRenderer.invoke("qaqh:power-blocker", { mode }),
    state: () => ipcRenderer.invoke("qaqh:power-blocker-state"),
  },
  gpuPref: {
    state: () => ipcRenderer.invoke("qaqh:gpu-pref-state") as Promise<{ currentLaunchDisabled: boolean; nextLaunchDisabled: boolean }>,
    set: (disabled: boolean) => ipcRenderer.invoke("qaqh:gpu-pref-set", { disabled }) as Promise<{ currentLaunchDisabled: boolean; nextLaunchDisabled: boolean }>,
  },
  // 用户 shell 的 ws 数据面四条(ADR-0028 切片 5);形状真源在 desktop-host 的 ShellBridge。
  shell: {
    attach: (id: string) => ipcRenderer.invoke("qaqh:invoke", "shell_attach", { shell_id: id }),
    detach: (id: string) => ipcRenderer.invoke("qaqh:invoke", "shell_detach", { shell_id: id }),
    stdin: (id: string, data: string) => ipcRenderer.invoke("qaqh:invoke", "shell_stdin", { shell_id: id, data }),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke("qaqh:invoke", "shell_resize", { shell_id: id, cols, rows }),
  },
  find: {
    inPage: (text: string, options: { forward?: boolean; matchCase?: boolean } = {}) =>
      ipcRenderer.invoke("qaqh:find-in-page", { text, ...options }) as Promise<boolean>,
    stop: () => ipcRenderer.invoke("qaqh:find-stop") as Promise<void>,
  },
  prefs: {
    snapshot: () => ipcRenderer.invoke("qaqh:prefs-snapshot") as Promise<Record<string, string>>,
    set: (key: string, value: string | null) => ipcRenderer.invoke("qaqh:prefs-set", { key, value }) as Promise<void>,
  },
  relaunch: () => ipcRenderer.invoke("qaqh:relaunch"),
  popupMenu: (items: unknown[], pos?: { x?: number; y?: number }) =>
    ipcRenderer.invoke("qaqh:popup-menu", { items, ...(pos ?? {}) }) as Promise<string | null>,
  updates: {
    check: () => ipcRenderer.invoke("qaqh:update-check"),
    stage: () => ipcRenderer.invoke("qaqh:update-stage"),
    apply: () => ipcRenderer.invoke("qaqh:update-apply"),
  },
  requestQuit: () => ipcRenderer.invoke("qaqh:request-quit"),
});
