import { contextBridge, ipcRenderer } from "electron";

const events = new Set([
  "timeline://entry", "timeline://status", "timeline://snapshot",
  "projection://event", "projection://reset", "conn://incompatible",
  "conn://error", "conn://liveness", "conn://reconnect",
  "model-picker:changed", "app://window-state", "app://quit-requested",
]);
const pendingQuitEvents: unknown[] = [];
const quitCallbacks = new Set<(payload: unknown) => void>();
ipcRenderer.on("qaqh:event:app://quit-requested", (_event, payload) => {
  if (quitCallbacks.size === 0) pendingQuitEvents.push(payload);
  else for (const callback of [...quitCallbacks]) callback(payload);
});

contextBridge.exposeInMainWorld("qaqhHost", {
  platform: "electron",
  invoke: (command: string, args: Record<string, unknown> = {}) =>
    ipcRenderer.invoke("qaqh:invoke", command, args),
  listen: (eventName: string, callback: (payload: unknown) => void) => {
    if (!events.has(eventName)) throw new Error(`Unsupported QAQH event: ${eventName}`);
    if (eventName === "app://quit-requested") {
      quitCallbacks.add(callback);
      for (const payload of pendingQuitEvents.splice(0)) callback(payload);
      return () => quitCallbacks.delete(callback);
    }
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(`qaqh:event:${eventName}`, listener);
    return () => ipcRenderer.removeListener(`qaqh:event:${eventName}`, listener);
  },
  modelPicker: {
    load: (args: { sessionId?: string | null } = {}) => ipcRenderer.invoke("model-picker:load", args),
    save: (args: { sessionId?: string | null; selection: unknown; alsoDefault?: boolean }) => ipcRenderer.invoke("model-picker:save", args),
    open: (args: { sessionId?: string | null } = {}) => ipcRenderer.invoke("model-picker:open", args),
  },
  windowControls: {
    state: () => ipcRenderer.invoke("qaqh:window-state"),
    hide: () => ipcRenderer.invoke("qaqh:window-hide"),
    show: () => ipcRenderer.invoke("qaqh:window-show"),
    setCloseToTray: (value: boolean) => ipcRenderer.invoke("qaqh:window-close-to-tray", value),
    setTrayStatus: (text: string) => ipcRenderer.invoke("qaqh:tray-status", text),
  },
  requestQuit: (options: { stopDaemon: boolean; stopActiveWork: boolean }) => ipcRenderer.invoke("qaqh:request-quit", options),
});
