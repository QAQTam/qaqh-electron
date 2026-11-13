/**
 * 语音输入/输出渲染层门面：麦克风采集 + 重采样 PCM16 WAV + 宿主推理调用 + 播报播放。
 * 采集/编码逻辑移植自 DeepSeek Harness (MIT) `client-ui-voice-input/src/client/audio.ts`，
 * 按其"浏览器拥有麦克风轨道与草稿、识别结果只作为一次可撤销插入"的所有权语义执行。
 */
import { invoke, listen } from "./transport/electron-core";

export type VoiceStatus = {
  root: string;
  asrReady: boolean;
  ttsReady: boolean;
  worker: "absent" | "ready";
  prepare: { file: string; receivedBytes: number; totalBytes: number } | null;
  error: string | null;
};

export type VoicePhase =
  | "off" | "idle" | "preparing" | "ready"
  | "recording" | "transcribing" | "speaking";

export interface VoiceCallbacks {
  phase(next: VoicePhase, detail?: string): void;
  level(value: number): void;
  /** 转写完成：交回调用方插入 composer（识别本身不写 Session 事件）。 */
  recognized(text: string): void;
  notice(message: string, kind: "ok" | "err"): void;
}

/** 一次录音的完整生命周期。停止后解码 → OfflineAudioContext 重采样 16k 单声道 → PCM16 WAV。 */
class Recording {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private context: AudioContext | undefined;
  private analyser: AnalyserNode | undefined;
  private readonly samples = new Float32Array(256);
  private chunks: Blob[] = [];
  private readonly lifetime = new AbortController();

  async start(): Promise<void> {
    const devices = navigator.mediaDevices;
    if (!devices) throw new Error("此环境没有麦克风接口");
    let stream: MediaStream;
    try {
      stream = await devices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") throw new Error("麦克风权限被拒绝");
      throw error;
    }
    if (this.lifetime.signal.aborted) { stream.getTracks().forEach((track) => track.stop()); throw new Error("录音已取消"); }
    this.stream = stream;
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    this.context.createMediaStreamSource(stream).connect(this.analyser);
    this.recorder = new MediaRecorder(stream);
    this.recorder.ondataavailable = (event) => { if (event.data.size > 0) this.chunks.push(event.data); };
    this.recorder.start();
  }

  amplitude(): number {
    if (this.analyser == null) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.sqrt(sum / this.samples.length);
  }

  async stop(maxSeconds: number): Promise<Uint8Array> {
    const recorder = this.recorder;
    const context = this.context;
    if (recorder == null || context == null || recorder.state !== "recording") throw new Error("没有进行中的录音");
    recorder.onstop = null;
    recorder.stop();
    await new Promise<void>((resolve) => { recorder.onstop = () => resolve(); setTimeout(resolve, 500); });
    this.stream?.getTracks().forEach((track) => track.stop());
    const blob = new Blob(this.chunks, { type: recorder.mimeType });
    this.chunks = [];
    if (blob.size === 0) throw new Error("录音为空");
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(Math.min(decoded.duration, maxSeconds) * 16_000)), 16_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWave(rendered.getChannelData(0));
  }

  dispose(): void {
    this.lifetime.abort();
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.analyser = undefined;
    this.chunks = [];
  }
}

/** 单声道 float → PCM16 WAV（16k，Little-Endian，44 字节头）。 */
function encodeWave(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string): void => { for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32_768 : 32_767)), true);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

/**
 * 播报前把 Markdown 拧成人话：代码块整体让位给一句口播说明，
 * 链接留锚文本，符号剥掉。识别文本进 composer 不做改写——那是用户的话。
 */
export function plainForVoice(raw: string): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, "，这里有一段代码，详见屏幕。")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_>#]+/g, "")
    .replace(/\s*\n+\s*/g, "。")
    .trim();
  if (text.length > 400) text = `${text.slice(0, 400)}……余下见屏幕`;
  return text;
}

const MAX_RECORD_SECONDS = 60;

/** 生命周期门面：App 只调 enable/disable/talkStart/talkStop/speak/stopSpeak。 */
export class VoiceIO {
  private recording: Recording | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl = "";
  private unlistenStatus: (() => void) | null = null;
  private phase: VoicePhase = "off";
  /** 转写请求在途（talkStop 之后、结果回来之前）也占用状态机。 */
  busy = false;

  constructor(private readonly cb: VoiceCallbacks) {}

  getPhase(): VoicePhase { return this.phase; }

  private setPhase(next: VoicePhase, detail?: string): void {
    this.phase = next;
    this.cb.phase(next, detail);
  }

  /** 打开语音：查磁盘缓存；缺件则点火下载并订阅进度事件。 */
  async enable(): Promise<void> {
    this.setPhase("idle");
    const status = await invoke<VoiceStatus>("voice_status");
    if (status.asrReady && status.ttsReady) { this.setPhase("ready"); return; }
    this.setPhase("preparing", "下载语音模型约 300MB，请勿退出应用");
    if (this.unlistenStatus == null) {
      void listen<VoiceStatus>("voice://status", (event) => {
        const value = event.payload;
        if (value.asrReady && value.ttsReady && this.phase === "preparing") {
          this.setPhase("ready");
          this.cb.notice("语音模型已就绪", "ok");
        } else if (this.phase === "preparing" && value.prepare != null) {
          const pct = value.prepare.totalBytes > 0 ? ` ${Math.floor((value.prepare.receivedBytes / value.prepare.totalBytes) * 100)}%` : "";
          this.setPhase("preparing", `${value.prepare.file}${pct}`);
        } else if (value.error != null && this.phase === "preparing") {
          this.setPhase("idle");
          this.cb.notice(`模型准备失败：${value.error}`, "err");
        }
      }).then((un) => { this.unlistenStatus = un; });
    }
    await invoke("voice_prepare");
  }

  disable(): void {
    this.stopLevel();
    this.recording?.dispose();
    this.recording = null;
    this.stopSpeak();
    this.busy = false;
    this.setPhase("off");
  }

  /** 手柄扳机按下：开录（播放中 = barge-in 先闭嘴）。 */
  async talkStart(): Promise<void> {
    if (this.phase !== "ready") {
      if (this.phase === "preparing") this.cb.notice("语音模型还在下载", "err");
      else if (this.phase === "off") this.cb.notice("先点亮麦克风按钮启用语音", "err");
      return;
    }
    this.stopSpeak();
    const recording = new Recording();
    try {
      await recording.start();
    } catch (error) {
      this.cb.notice(error instanceof Error ? error.message : String(error), "err");
      return;
    }
    this.recording = recording;
    this.setPhase("recording");
    this.levelTimer = setInterval(() => { this.cb.level(recording.amplitude()); }, 60);
  }

  /** 松手：封段 → 送识别 → recognized 回调插草稿。 */
  async talkStop(): Promise<void> {
    const recording = this.recording;
    if (recording == null) return;
    this.recording = null;
    this.stopLevel();
    this.cb.level(0);
    let wav: Uint8Array;
    try {
      wav = await recording.stop(MAX_RECORD_SECONDS);
    } catch (error) {
      this.setPhase("ready");
      this.cb.notice(error instanceof Error ? error.message : String(error), "err");
      return;
    }
    this.busy = true;
    this.setPhase("transcribing");
    try {
      const result = await invoke<{ text: string }>("voice_transcribe", { wav: toBase64(wav), language: "auto" });
      if (result.text.length > 0) this.cb.recognized(result.text);
      else this.cb.notice("没听清，再试一次？", "err");
    } catch (error) {
      this.cb.notice(`识别失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally {
      this.busy = false;
      if (this.phase === "transcribing") this.setPhase("ready");
    }
  }

  /** 播报：合成整段 wav 再播（v1 不做边合成边播的流式接缝）。 */
  async speak(text: string): Promise<void> {
    const plain = plainForVoice(text);
    if (plain.length === 0 || this.phase === "off") return;
    if (this.phase !== "ready" && this.phase !== "speaking") return;
    this.stopSpeak();
    this.setPhase("speaking");
    try {
      const base64 = await invoke<string>("voice_synthesize", { text: plain });
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const blob = new Blob([bytes], { type: "audio/wav" });
      this.audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.audioUrl);
      this.audio = audio;
      audio.onended = () => { this.releaseAudio(); if (this.phase === "speaking") this.setPhase("ready"); };
      audio.onerror = () => { this.releaseAudio(); this.setPhase("ready"); this.cb.notice("播报失败", "err"); };
      await audio.play();
    } catch (error) {
      this.releaseAudio();
      this.setPhase("ready");
      this.cb.notice(`播报失败：${error instanceof Error ? error.message : String(error)}`, "err");
    }
  }

  stopSpeak(): void {
    this.releaseAudio();
    if (this.phase === "speaking") this.setPhase("ready");
  }

  private releaseAudio(): void {
    if (this.audio != null) { this.audio.pause(); this.audio.src = ""; this.audio = null; }
    if (this.audioUrl !== "") { URL.revokeObjectURL(this.audioUrl); this.audioUrl = ""; }
  }

  private stopLevel(): void {
    if (this.levelTimer != null) { clearInterval(this.levelTimer); this.levelTimer = null; }
  }
}
