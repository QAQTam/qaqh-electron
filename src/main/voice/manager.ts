/**
 * 语音输入/输出宿主：模型按需下载(SHA-256 校验,镜像优先)与托管推理子进程的生命周期。
 * 接线模式取自 DeepSeek Harness (MIT) 的 speech-to-text-sensevoice Provider：
 * 启用≠下载≠加载；首次调用唤醒 worker；空闲 300s 释放进程、保留磁盘缓存；
 * 推理传输失败回收 worker，不信任被污染的进程。
 */
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const VOICE_EVENT = "voice://status";
const IDLE_MS = 300_000;
const WORKER_GRACE_MS = 1_000;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const THREADS = 2;

/** 固定 URL + 字节数 + SHA-256。VAD 曾因钉 revision 而 404(rev 腐烂),改钉 main + 哈希为权威。 */
type Asset = {
  file: string;
  origins: string[];
  path: string;
  bytes: number;
  sha256: string;
};

const HF_ORIGINS = ["https://hf-mirror.com", "https://huggingface.co"];
const ASR_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
const ASR_REV = "2365baeacb507f821a0c8120fcee3d484dba7a07";

const ASSET_ASR_MODEL: Asset = {
  file: "asr/model.int8.onnx",
  origins: HF_ORIGINS,
  path: `${ASR_REPO}/resolve/${ASR_REV}/model.int8.onnx`,
  bytes: 239_233_841,
  sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
};
const ASSET_ASR_TOKENS: Asset = {
  file: "asr/tokens.txt",
  origins: HF_ORIGINS,
  path: `${ASR_REPO}/resolve/${ASR_REV}/tokens.txt`,
  bytes: 315_894,
  sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
};
const ASSET_VAD: Asset = {
  file: "asr/silero_vad.onnx",
  origins: HF_ORIGINS,
  path: "csukuangfj/vad/resolve/main/silero_vad.onnx",
  bytes: 1_807_522,
  sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28",
};
/** TTS 以官方 release tar.bz2 分发(espeak-ng-data 是目录,平铺文件无法整搬)。 */
const ASSET_TTS_TAR: Asset = {
  file: "tts-piper.tar.bz2",
  origins: ["https://github.com"],
  path: "k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-huayan-medium.tar.bz2",
  bytes: 67_255_926,
  sha256: "dbdfec42b91d9cee31cce9ff4b3e9c305eb6fbf60546d071f7e46273554cce6b",
};
const TTS_DIR = "vits-piper-zh_CN-huayan-medium";
const ALL_ASSETS = [ASSET_ASR_MODEL, ASSET_ASR_TOKENS, ASSET_VAD, ASSET_TTS_TAR];

export type VoiceStatus = {
  root: string;
  asrReady: boolean;
  ttsReady: boolean;
  worker: "absent" | "ready";
  prepare: { file: string; receivedBytes: number; totalBytes: number } | null;
  error: string | null;
};

function fileOk(path: string, bytes: number): boolean {
  try {
    return statSync(path).size === bytes;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

class VoiceManager {
  private root = "";
  private worker: { child: ChildProcess; port: number; token: string } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private preparing: Promise<void> | null = null;
  private prepareState: VoiceStatus["prepare"] = null;
  private lastError: string | null = null;

  private ensureRoot(): string {
    if (this.root === "") this.root = join(app.getPath("userData"), "voice-models");
    return this.root;
  }

  status(): VoiceStatus {
    const root = this.ensureRoot();
    return {
      root,
      asrReady: [ASSET_ASR_MODEL, ASSET_ASR_TOKENS, ASSET_VAD].every((a) => fileOk(join(root, a.file), a.bytes)),
      ttsReady: existsSync(join(root, TTS_DIR, "zh_CN-huayan-medium.onnx"))
        && existsSync(join(root, TTS_DIR, "tokens.txt")),
      worker: this.worker ? "ready" : "absent",
      prepare: this.prepareState,
      error: this.lastError,
    };
  }

  private emit(): void {
    const payload = this.status();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(`qaqh:event:${VOICE_EVENT}`, payload);
    }
  }

  /** 下载缺件 + 校验 + 解包 tar；已完成并通过校验的文件在重试时复用。 */
  prepare(): Promise<void> {
    if (this.preparing != null) return this.preparing;
    this.lastError = null;
    this.preparing = this.runPrepare().finally(() => {
      this.preparing = null;
      this.prepareState = null;
      this.emit();
    });
    return this.preparing;
  }

  private async runPrepare(): Promise<void> {
    const root = this.ensureRoot();
    await mkdir(join(root, "asr"), { recursive: true });
    for (const asset of ALL_ASSETS) {
      const target = join(root, asset.file);
      if (await this.verified(target, asset)) continue;
      await this.download(asset, target, root);
      if (!(await this.verified(target, asset))) throw new Error(`校验失败: ${asset.file}`);
    }
    const ttsDir = join(root, TTS_DIR);
    if (!existsSync(join(ttsDir, "zh_CN-huayan-medium.onnx"))) {
      this.prepareState = { file: `解压 ${TTS_DIR}`, receivedBytes: 0, totalBytes: 0 };
      this.emit();
      await new Promise<void>((resolve, reject) => {
        const child = spawn("tar", ["-xjf", join(root, ASSET_TTS_TAR.file), "-C", root], { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
      });
      await rm(join(root, ASSET_TTS_TAR.file), { force: true });
    }
  }

  private async verified(target: string, asset: Asset): Promise<boolean> {
    if (!fileOk(target, asset.bytes)) return false;
    return (await hashFile(target)) === asset.sha256;
  }

  private async download(asset: Asset, target: string, root: string): Promise<void> {
    const part = `${target}.part`;
    let lastFailure = "";
    for (const origin of asset.origins) {
      this.prepareState = { file: `${asset.file} ← ${new URL(origin).hostname}`, receivedBytes: 0, totalBytes: asset.bytes };
      this.emit();
      try {
        const response = await fetch(`${origin}/${asset.path}`, { redirect: "follow" });
        if (!response.ok || response.body == null) throw new Error(`HTTP ${response.status}`);
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let received = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          chunks.push(Buffer.from(value));
          received += value.length;
          this.prepareState = { file: this.prepareState?.file ?? asset.file, receivedBytes: received, totalBytes: asset.bytes };
          if (received % (1024 * 1024) < value.length) this.emit();
        }
        const buf = Buffer.concat(chunks);
        if (buf.length !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("尺寸或哈希不符");
        await writeFile(part, buf);
        await mkdir(dirname(target), { recursive: true });
        await rename(part, target);
        return;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        await rm(part, { force: true });
      }
    }
    throw new Error(`下载失败 ${asset.file}: ${lastFailure}`);
  }

  private workerConfig(): string {
    const root = this.ensureRoot();
    return JSON.stringify({
      root,
      threads: THREADS,
      asr: {
        model: join(root, ASSET_ASR_MODEL.file),
        tokens: join(root, ASSET_ASR_TOKENS.file),
        vad: join(root, ASSET_VAD.file),
      },
      tts: {
        model: join(root, TTS_DIR, "zh_CN-huayan-medium.onnx"),
        tokens: join(root, TTS_DIR, "tokens.txt"),
        dataDir: join(root, TTS_DIR, "espeak-ng-data"),
      },
    });
  }

  /** worker 单例：spawn 一次读端口,后续调用排队共享。 */
  private async ensureWorker(): Promise<{ port: number; token: string }> {
    if (this.worker != null) return this.worker;
    const status = this.status();
    if (!status.asrReady && !status.ttsReady) throw new Error("语音模型未准备，请先在界面完成下载");
    const token = randomBytes(32).toString("hex");
    // 打包态 worker 在 asar 外的 voice-runtime（RUN_AS_NODE 子进程没有 asar 补丁）。
    const workerPath = app.isPackaged
      ? join(process.resourcesPath, "voice-runtime", "voice-worker.cjs")
      : join(__dirname, "voice-worker.cjs");
    const child = spawn(process.execPath, [workerPath, this.workerConfig()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", QAKH_VOICE_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // worker 的死亡原因只出现在 stderr；不带进错误消息用户就只能看到空括号。
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
      console.warn("[voice-worker]", chunk.toString("utf8").trimEnd());
    });
    const port = await new Promise<number>((resolve, reject) => {
      let text = "";
      const onData = (chunk: Buffer): void => {
        text += chunk.toString("utf8");
        const end = text.indexOf("\n");
        if (end < 0) return;
        try {
          const value = JSON.parse(text.slice(0, end)) as { port: number };
          if (Number.isInteger(value.port) && value.port > 0) resolve(value.port);
          else reject(new Error("worker 端口非法"));
        } catch (error) { reject(error); }
      };
      child.stdout?.on("data", onData);
      child.once("exit", (code) => reject(new Error(`语音 worker 提前退出(${code})：${stderrTail.trim() || text.slice(0, 200) || "无输出"}`)));
      child.once("error", reject);
      setTimeout(() => reject(new Error("语音 worker 加载模型超时")), 60_000).unref?.();
    }).catch((error: unknown) => {
      child.kill();
      throw error;
    });
    this.worker = { child, port, token };
    child.once("exit", () => { if (this.worker?.child === child) this.worker = null; this.emit(); });
    this.emit();
    return this.worker;
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (worker == null) return;
    this.worker = null;
    worker.child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { worker.child.kill("SIGKILL"); resolve(); }, WORKER_GRACE_MS);
      worker.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.emit();
  }

  /** 串行队列 + 空闲回收；传输失败即回收进程（下次调用重新唤醒）。 */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.idleTimer != null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const job = this.queue.then(run, run);
    this.queue = job.then(() => undefined, () => undefined);
    void this.queue.then(() => {
      if (this.worker != null) {
        this.idleTimer = setTimeout(() => { void this.stopWorker(); }, IDLE_MS);
      }
    });
    return job;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    const worker = await this.ensureWorker();
    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${worker.token}` },
      });
      return response;
    } catch (error) {
      await this.stopWorker();
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }

  transcribe(wav: Buffer, language: string): Promise<{ text: string; audioSeconds: number; inferenceSeconds: number }> {
    if (wav.length > MAX_AUDIO_BYTES) return Promise.reject(new Error("录音超出 4MB 上限"));
    return this.enqueue(async () => {
      const response = await this.call(`/transcribe?language=${encodeURIComponent(language)}`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new Uint8Array(wav),
      });
      const value = await response.json() as { text?: string; error?: string; audioSeconds?: number; inferenceSeconds?: number };
      if (!response.ok) throw new Error(value.error ?? `transcribe HTTP ${response.status}`);
      return { text: value.text ?? "", audioSeconds: value.audioSeconds ?? 0, inferenceSeconds: value.inferenceSeconds ?? 0 };
    });
  }

  synthesize(text: string): Promise<Buffer> {
    return this.enqueue(async () => {
      const response = await this.call("/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(value.error ?? `synthesize HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    });
  }
}

export const voice = new VoiceManager();
