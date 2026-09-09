// Preload：唯一桥面（spec §5）。全部经 ipcRenderer.invoke；事件订阅返回退订函数。
// 禁止把 ipcRenderer/process/Buffer/路径暴露进 bridge。token 仅内存转发。
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

function subscribe(channel: string, cb: () => void): () => void {
  const handler = (_e: IpcRendererEvent, _payload: unknown): void => cb();
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const bridge = {
  getConnectionConfig: () => ipcRenderer.invoke("qaqh:getConnectionConfig"),
  daemonStatus: () => ipcRenderer.invoke("qaqh:daemonStatus"),
  pickAttachments: (o: { multiple: boolean }) => ipcRenderer.invoke("qaqh:pickAttachments", o),
  openExternal: (url: string) => ipcRenderer.invoke("qaqh:openExternal", url),
  win: (action: "min" | "max" | "close") => ipcRenderer.invoke("qaqh:win", action),
  onDaemonDied: (cb: () => void) => subscribe("qaqh:daemonDied", cb),
  onConfigChanged: (cb: () => void) => subscribe("qaqh:configChanged", cb),
};

contextBridge.exposeInMainWorld("qaqh", bridge);
