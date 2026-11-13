/**
 * 语音推理子进程：SenseVoice(ASR)+Silero VAD+VITS(Piper zh TTS) 全在一个托管进程里。
 * stdout 只输出一行 `{"port":N}` 作为就绪协议；私有环回 HTTP 用 Bearer token 认证。
 * sherpa-onnx-node 是 CommonJS Node-API 绑定(JSDoc 无声明,Electron 下必须复制 VAD
 * 缓冲区避开 V8 内存笼)，故 createRequire 加载,打包时保持 external。
 */
import { createRequire } from "node:module";
import http from "node:http";

type Sherpa = {
  OfflineRecognizer: new (config: object) => Recognizer;
  Vad: new (config: object, bufferSeconds: number) => Detector;
  OfflineTts: new (config: object) => Tts;
};
type Recognizer = {
  createStream(): { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void };
  setConfig(config: object): void;
  decode(stream: object): void;
  getResult(stream: object): { text: string };
};
type Detector = {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(externalBuffer: false): { start: number; samples: Float32Array };
  pop(): void;
  reset(): void;
  flush(): void;
};
type Tts = {
  sampleRate: number;
  generate(obj: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number };
};

const requireCjs = createRequire(__filename);
const sherpa = requireCjs("sherpa-onnx-node") as Sherpa;

type WorkerConfig = {
  root: string;
  threads: number;
  asr: { model: string; tokens: string; vad: string };
  tts: { model: string; tokens: string; dataDir: string };
};

const config: WorkerConfig = JSON.parse(process.argv[2] ?? "");
const token = process.env.QAKH_VOICE_TOKEN ?? "";
delete process.env.QAKH_VOICE_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token)) {
  process.stderr.write("语音 worker 缺少合法 token\n");
  process.exit(1);
}

// —— 文本 WAV 工具 ——
function readWavPcm16Mono(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  let offset = 12;
  let dataAt = -1;
  let dataLen = 0;
  let sampleRate = 16_000;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataAt = offset + 8;
      dataLen = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataAt < 0 || bits !== 16 || channels !== 1) throw new Error("仅支持 16k 单声道 PCM16 WAV");
  const count = Math.floor(dataLen / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = buf.readInt16LE(dataAt + i * 2) / 32_768;
  return { samples, sampleRate };
}

function writeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    buf.writeInt16LE(Math.round(v * (v < 0 ? 32_768 : 32_767)), 44 + i * 2);
  }
  return buf;
}

// —— ASR：SenseVoice + Silero 分段(照 dsh inference.ts) ——
const asrConfig = {
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: config.asr.model, language: "auto", useInverseTextNormalization: 1 },
    tokens: config.asr.tokens,
    numThreads: config.threads,
    provider: "cpu",
    debug: 0,
  },
};
let recognizer: Recognizer | null = null;
let detector: Detector | null = null;

function transcribe(wav: Buffer, language: string): { text: string; audioSeconds: number; inferenceSeconds: number } {
  if (recognizer == null) recognizer = new sherpa.OfflineRecognizer(asrConfig);
  if (detector == null) {
    detector = new sherpa.Vad({
      sileroVad: { model: config.asr.vad, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512 },
      sampleRate: 16_000,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
    }, 30 + 0.5 + 1);
  }
  const { samples, sampleRate } = readWavPcm16Mono(wav);
  if (sampleRate !== 16_000) throw new Error("采样率必须 16000");
  const audioSeconds = samples.length / sampleRate;
  const rec = recognizer;
  const vad = detector;
  asrConfig.modelConfig.senseVoice.language = language;
  rec.setConfig(asrConfig);
  vad.reset();
  const onsetPadding = Math.round(0.3 * 16_000); // 冷启动 VAD 迟报起音,回填 0.3s。
  let first = true;
  const texts: string[] = [];
  const drain = (): void => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      let speech = segment.samples;
      if (first) {
        first = false;
        const from = Math.max(0, segment.start - onsetPadding);
        if (from < segment.start) {
          const restored = new Float32Array(segment.start - from + speech.length);
          restored.set(samples.subarray(from, segment.start));
          restored.set(speech, segment.start - from);
          speech = restored;
        }
      }
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: 16_000, samples: speech });
      rec.decode(stream);
      texts.push(rec.getResult(stream).text.trim());
      vad.pop();
    }
  };
  const started = performance.now();
  for (let at = 0; at < samples.length; at += 512) {
    vad.acceptWaveform(samples.subarray(at, at + 512));
    drain();
  }
  vad.flush();
  drain();
  return { text: texts.filter(Boolean).join(" ").trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1_000 };
}

// —— TTS：VITS-piper,首个请求才加载(省 2s 冷启动与内存当用户不用播报) ——
let tts: Tts | null = null;

function synthesize(text: string): Buffer {
  if (text.length === 0 || text.length > 2_000) throw new Error("文本长度需在 1..2000");
  if (tts == null) {
    tts = new sherpa.OfflineTts({
      model: {
        vits: { model: config.tts.model, tokens: config.tts.tokens, dataDir: config.tts.dataDir },
        numThreads: config.threads,
        debug: 0,
        provider: "cpu",
      },
      maxNumSentences: 3,
    });
  }
  const audio = tts.generate({ text, sid: 0, speed: 1.0 });
  return writeWavPcm16(audio.samples, audio.sampleRate);
}

// —— 私有环回服务 ——
function readBody(req: import("node:http").IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("请求体超限")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  const send = (code: number, body: Buffer, type: string): void => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  if (req.headers.authorization !== `Bearer ${token}`) { send(401, Buffer.from('{"error":"unauthorized"}'), "application/json"); return; }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  void (async () => {
    if (req.method === "POST" && url.pathname === "/transcribe") {
      const wav = await readBody(req, 4 * 1024 * 1024);
      const language = url.searchParams.get("language") ?? "auto";
      send(200, Buffer.from(JSON.stringify(transcribe(wav, language))), "application/json");
      return;
    }
    if (req.method === "POST" && url.pathname === "/synthesize") {
      const body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8")) as { text?: string };
      send(200, synthesize(String(body.text ?? "")), "audio/wav");
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      send(200, Buffer.from(JSON.stringify({ asrLoaded: recognizer != null, ttsLoaded: tts != null })), "application/json");
      return;
    }
    send(404, Buffer.from('{"error":"not found"}'), "application/json");
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    send(message.includes("超限") || message.includes("必须") || message.includes("仅支持") || message.includes("长度") ? 400 : 500,
      Buffer.from(JSON.stringify({ error: message })), "application/json");
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address == null || typeof address === "string") { process.exit(1); }
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
