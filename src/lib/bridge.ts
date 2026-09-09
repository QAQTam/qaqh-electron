// window.qaqh 类型化访问器 — preload 契约的 renderer 侧镜像（spec §5）。
// 浏览器/dev 形态下 window.qaqh 不存在，返回 null；由 mock 层接管。

export interface AttachmentPayload {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

export interface QaqhBridge {
  getConnectionConfig(): Promise<{
    endpoint: string;
    token: string;
    clientInstanceId: string;
    adopted: boolean;
  }>;
  daemonStatus(): Promise<{ running: boolean; pid?: number; spawnedByUs: boolean }>;
  pickAttachments(o: { multiple: boolean }): Promise<AttachmentPayload[]>;
  openExternal(url: string): Promise<void>;
  win(action: "min" | "max" | "close"): Promise<void>;
  onDaemonDied(cb: () => void): () => void;
  onConfigChanged(cb: () => void): () => void;
}

declare global {
  interface Window {
    qaqh?: QaqhBridge;
  }
}

/** Electron 形态有桥；浏览器 /debug/ 形态没有。 */
export function bridge(): QaqhBridge | null {
  return typeof window !== "undefined" && window.qaqh ? window.qaqh : null;
}
