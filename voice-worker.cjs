"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/voice/worker.ts
var import_node_module = require("node:module");
var import_node_http = __toESM(require("node:http"), 1);
var requireCjs = (0, import_node_module.createRequire)(__filename);
var sherpa = requireCjs("sherpa-onnx-node");
var config = JSON.parse(process.argv[2] ?? "");
var token = process.env.QAKH_VOICE_TOKEN ?? "";
delete process.env.QAKH_VOICE_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token)) {
  process.stderr.write("\u8BED\u97F3 worker \u7F3A\u5C11\u5408\u6CD5 token\n");
  process.exit(1);
}
function readWavPcm16Mono(buf) {
  let offset = 12;
  let dataAt = -1;
  let dataLen = 0;
  let sampleRate = 16e3;
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
    offset += 8 + size + size % 2;
  }
  if (dataAt < 0 || bits !== 16 || channels !== 1) throw new Error("\u4EC5\u652F\u6301 16k \u5355\u58F0\u9053 PCM16 WAV");
  const count = Math.floor(dataLen / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = buf.readInt16LE(dataAt + i * 2) / 32768;
  return { samples, sampleRate };
}
function writeWavPcm16(samples, sampleRate) {
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
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return buf;
}
var asrConfig = {
  featConfig: { sampleRate: 16e3, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: config.asr.model, language: "auto", useInverseTextNormalization: 1 },
    tokens: config.asr.tokens,
    numThreads: config.threads,
    provider: "cpu",
    debug: 0
  }
};
var recognizer = null;
var detector = null;
function transcribe(wav, language) {
  if (recognizer == null) recognizer = new sherpa.OfflineRecognizer(asrConfig);
  if (detector == null) {
    detector = new sherpa.Vad({
      sileroVad: { model: config.asr.vad, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512 },
      sampleRate: 16e3,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0
    }, 30 + 0.5 + 1);
  }
  const { samples, sampleRate } = readWavPcm16Mono(wav);
  if (sampleRate !== 16e3) throw new Error("\u91C7\u6837\u7387\u5FC5\u987B 16000");
  const audioSeconds = samples.length / sampleRate;
  const rec = recognizer;
  const vad = detector;
  asrConfig.modelConfig.senseVoice.language = language;
  rec.setConfig(asrConfig);
  vad.reset();
  const onsetPadding = Math.round(0.3 * 16e3);
  let first = true;
  const texts = [];
  const drain = () => {
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
      stream.acceptWaveform({ sampleRate: 16e3, samples: speech });
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
  return { text: texts.filter(Boolean).join(" ").trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1e3 };
}
var tts = null;
function synthesize(text) {
  if (text.length === 0 || text.length > 2e3) throw new Error("\u6587\u672C\u957F\u5EA6\u9700\u5728 1..2000");
  if (tts == null) {
    tts = new sherpa.OfflineTts({
      model: {
        vits: { model: config.tts.model, tokens: config.tts.tokens, dataDir: config.tts.dataDir },
        numThreads: config.threads,
        debug: 0,
        provider: "cpu"
      },
      maxNumSentences: 3
    });
  }
  const audio = tts.generate({ text, sid: 0, speed: 1 });
  return writeWavPcm16(audio.samples, audio.sampleRate);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("\u8BF7\u6C42\u4F53\u8D85\u9650"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
var server = import_node_http.default.createServer((req, res) => {
  const send = (code, body, type) => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(401, Buffer.from('{"error":"unauthorized"}'), "application/json");
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  void (async () => {
    if (req.method === "POST" && url.pathname === "/transcribe") {
      const wav = await readBody(req, 4 * 1024 * 1024);
      const language = url.searchParams.get("language") ?? "auto";
      send(200, Buffer.from(JSON.stringify(transcribe(wav, language))), "application/json");
      return;
    }
    if (req.method === "POST" && url.pathname === "/synthesize") {
      const body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8"));
      send(200, synthesize(String(body.text ?? "")), "audio/wav");
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      send(200, Buffer.from(JSON.stringify({ asrLoaded: recognizer != null, ttsLoaded: tts != null })), "application/json");
      return;
    }
    send(404, Buffer.from('{"error":"not found"}'), "application/json");
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    send(
      message.includes("\u8D85\u9650") || message.includes("\u5FC5\u987B") || message.includes("\u4EC5\u652F\u6301") || message.includes("\u957F\u5EA6") ? 400 : 500,
      Buffer.from(JSON.stringify({ error: message })),
      "application/json"
    );
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address == null || typeof address === "string") {
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ port: address.port })}
`);
});
//# sourceMappingURL=voice-worker.cjs.map
