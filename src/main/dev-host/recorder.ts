// 主窗口合成层录制：getMediaSourceId → 隐藏 recorder 页（独立 partition）→
// getUserMedia(desktop source) → MediaRecorder(webm) → 分块 base64 drain 回主进程
// 流式 append 落盘 <data_dir>/records/<ts>.webm。
// 口径（docs/browser-control-design.md Dev Surface 章节）：
// - 录的是窗口合成画面——renderer + 内嵌浏览器 pane 的所见即所得；
// - 短时录制（开发者模式临时功能），无音频，不做画质/内存限制；
// - 分块 drain 把驻留内存压在一个采样间隔的 chunk 量，5 分钟片子也不会打爆
//   recorder 页的堆（V8 --max-old-space-size 是全进程命令行，隐藏窗同样受 256MB 约束）。
// - 生命周期只有 start/stop/dispose 三个入口，与 dev-host engine 一一接线。

import { BrowserWindow } from "electron";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../daemon.js";
import type { ToolOutcome } from "../browser-host/dom-ops.js";

/** drain 节拍：2s 攒一批 chunk，内存上界 ≈ 2 秒码率。 */
const DRAIN_INTERVAL_MS = 2000;
/** stop 后等 MediaRecorder onstop 末块落进 chunks 数组的窗口。 */
const STOP_FLUSH_MS = 500;

const RECORDER_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.__qaqhRec = {
  chunks: [],
  recorder: null,
  stream: null,
  async start(sourceId) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
    });
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => { if (event.data.size > 0) this.chunks.push(event.data); };
    this.recorder.start(1000);
  },
  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
  },
  async drain() {
    const list = this.chunks.splice(0);
    const out = [];
    for (const blob of list) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      out.push(btoa(binary));
    }
    return out;
  },
};
</script></body></html>`;

const RECORDER_URL = `data:text/html;charset=utf-8,${encodeURIComponent(RECORDER_PAGE)}`;

interface RecordSession {
  window: BrowserWindow;
  filePath: string;
  startedAt: number;
  bytes: number;
  timer: NodeJS.Timeout | null;
}

export interface Recorder {
  start: () => Promise<ToolOutcome>;
  stop: () => Promise<ToolOutcome>;
  status: () => ToolOutcome;
  /** 壳退出时兜底关录制窗（尽力而为，不再等待末块）。 */
  dispose: () => void;
}

export function createRecorder(deps: { getMainWindow: () => BrowserWindow | null }): Recorder {
  let session: RecordSession | null = null;

  function targetWindow(): BrowserWindow {
    const win = deps.getMainWindow();
    if (win == null || win.isDestroyed()) throw new Error("主窗口未就绪，录屏不可用");
    return win;
  }

  async function drainInto(target: RecordSession): Promise<void> {
    if (target.window.webContents.isDestroyed()) return;
    const chunks = (await target.window.webContents.executeJavaScript("__qaqhRec.drain()", true)) as string[];
    for (const encoded of chunks) {
      const buffer = Buffer.from(encoded, "base64");
      appendFileSync(target.filePath, buffer);
      target.bytes += buffer.length;
    }
  }

  async function closeSession(): Promise<void> {
    const current = session;
    session = null;
    if (current == null) return;
    if (current.timer != null) clearInterval(current.timer);
    if (!current.window.isDestroyed()) current.window.destroy();
  }

  return {
    async start() {
      if (session != null) {
        return { content: `error: 已有录制在进行（${session.filePath}）；先 record_stop`, isError: true };
      }
      const win = targetWindow();
      if (win.isMinimized() || !win.isVisible()) {
        return { content: "error: 主窗口最小化/隐藏时窗口捕获全是黑帧；先把窗口显示出来再录制", isError: true };
      }
      const recordsDir = join(getDataDir(), "records");
      mkdirSync(recordsDir, { recursive: true });
      const filePath = join(recordsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.webm`);

      const recorderWindow = new BrowserWindow({
        show: false,
        width: 320,
        height: 180,
        webPreferences: {
          partition: "qaqh-recorder",
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      // 录制页是 data: URL（Electron 桌面捕获官方示例形态），origin 不可名状——
      // 权限按 session 域收紧：qaqh-recorder 这个独立分区只放 media，别的一概拒绝。
      recorderWindow.webContents.session.setPermissionCheckHandler(
        (_contents, permission) => permission === "media",
      );
      recorderWindow.webContents.session.setPermissionRequestHandler(
        (_contents, permission, callback) => callback(permission === "media"),
      );

      session = { window: recorderWindow, filePath, startedAt: Date.now(), bytes: 0, timer: null };
      try {
        await recorderWindow.loadURL(RECORDER_URL);
        await recorderWindow.webContents.executeJavaScript(
          `__qaqhRec.start(${JSON.stringify(win.getMediaSourceId())})`,
          true,
        );
      } catch (error) {
        await closeSession();
        if (existsSync(filePath)) rmSync(filePath, { force: true });
        throw error;
      }
      session.timer = setInterval(() => {
        if (session == null) return;
        void drainInto(session).catch(() => {
          void closeSession();
        });
      }, DRAIN_INTERVAL_MS);
      return { content: `开始录制主窗口（合成层，含浏览器面板；无音频）：${filePath}\n停止用 record_stop。` };
    },

    async stop() {
      if (session == null) return { content: "error: 当前没有进行中的录制", isError: true };
      const current = session;
      try {
        await current.window.webContents.executeJavaScript("__qaqhRec.stop()", true);
        await new Promise((resolveWait) => setTimeout(resolveWait, STOP_FLUSH_MS));
        // 末块 drain 必须在拆窗前、且仍持 current 引用时完成。
        await drainInto(current);
      } finally {
        await closeSession();
      }
      if (current.bytes === 0) {
        rmSync(current.filePath, { force: true });
        return { content: "error: 录制产物为空（首帧前窗口即被销毁？）；已删除空文件", isError: true };
      }
      const elapsedSec = Math.round((Date.now() - current.startedAt) / 1000);
      return {
        content: `录制完成：${current.filePath}\n时长约 ${elapsedSec}s，${(current.bytes / 1024 / 1024).toFixed(2)} MB，webm（无音频）。`,
      };
    },

    status() {
      if (session == null) return { content: "idle：当前没有进行中的录制" };
      const win = deps.getMainWindow();
      const warn = win != null && !win.isDestroyed() && (win.isMinimized() || !win.isVisible())
        ? "\n警告：主窗口当前最小化/隐藏——这段窗口捕获会是黑帧"
        : "";
      return {
        content: `recording：${session.filePath}\n已录 ${Math.round((Date.now() - session.startedAt) / 1000)}s，已落盘 ${(session.bytes / 1024).toFixed(0)} KB${warn}`,
      };
    },

    dispose() {
      if (session == null) return;
      const current = session;
      session = null;
      if (current.timer != null) clearInterval(current.timer);
      // 尽力而为：等一次最终 drain，再拆窗（退出路径不阻塞主进程）。
      void drainInto(current).finally(() => {
        if (!current.window.isDestroyed()) current.window.destroy();
      });
    },
  };
}
