// 宣传片音效合成：scripts/promo/sfx.mjs → .tmp/promo/sfx.wav
//
// 全部音色由代码合成（48kHz/16bit/立体声），事件表读 scenes.json 的 sfx 轴
// （at=成片秒）。想要 BGM 就发布时在剪映/抖音曲库挂平台授权乐；这条轨只给 SFX。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenes = JSON.parse(readFileSync(join(root, "webui", "src", "promo", "scenes.json"), "utf8"));
const SR = 48000;
const total = Math.ceil(((scenes.durationVirtualMs / 1000) * 1.05 + 2) * SR); // 帧率折算成片时长 ≈ 31.2s，多留 2s
const L = new Float64Array(total);
const R = new Float64Array(total);

const add = (start, dur, fn) => {
  const a = Math.round(start * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && a + i < total; i += 1) {
    const [l, r] = fn(i / SR, i / n);
    L[a + i] += l;
    R[a + i] += r;
  }
};

let seed = 20261112;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const noiseTable = Float64Array.from({ length: SR * 2 }, () => rnd());
const noise = (t) => noiseTable[Math.floor(Math.abs(t * SR) % noiseTable.length)];
const env = (p, attack, release) => (p < attack ? p / attack : Math.pow(1 - (p - attack) / (1 - attack), release));

const VOICES = {
  // 纸：短促带通噪声 swish
  paper: (at, g) => add(at, 0.35, (t, p) => { const e = env(p, 0.06, 3.2) * g; const n = (noise(t) + noise(t * 1.7)) * .5; return [e * n, e * n * .9]; }),
  swish: (at, g) => add(at, 0.28, (t, p) => { const e = env(p, 0.25, 2.2) * g; const n = noise(t * 1.3); return [e * n * 0.8, e * n * 0.8]; }),
  // 盒盖：低频撞击 + 高频咔哒
  clack: (at, g) => add(at, 0.16, (t, p) => { const e = Math.exp(-p * 34) * g; return [e * Math.sin(2 * Math.PI * 170 * t) * .7 + e * noise(t * 3) * .3, e * Math.sin(2 * Math.PI * 150 * t) * .7]; }),
  lidclack: (at, g) => { add(at, 0.2, (t, p) => { const e = Math.exp(-p * 30) * g; return [e * (Math.sin(2 * Math.PI * 125 * t) * .8 + noise(t * 2) * .25), e * Math.sin(2 * Math.PI * 112 * t) * .8]; }); add(at + 0.02, 0.08, (t, p) => { const e = Math.exp(-p * 50) * g * .6; return [e * noise(t * 6), e * noise(t * 6)]; }); },
  // 勾/确认：高频铃
  ting: (at, g) => add(at, 0.7, (t) => { const e = Math.exp(-t * 6) * g; const l = e * (Math.sin(2 * Math.PI * 1568 * t) + .4 * Math.sin(2 * Math.PI * 3136 * t)); const r = e * (Math.sin(2 * Math.PI * 1568 * t + .5) + .4 * Math.sin(2 * Math.PI * 2093 * t)); return [l * .5, r * .5]; }),
  // 倒计时快进：上升 blip 序列
  accel: (at, g) => { for (let k = 0; k < 10; k += 1) { const dt = at + (k * (k + 1)) / 2 * 0.02; add(dt, 0.05, (t) => { const e = Math.exp(-t * 60) * g; const f = 600 + k * 90; return [e * Math.sin(2 * Math.PI * f * t), e * Math.sin(2 * Math.PI * f * t)]; }); } },
  // 飞箱：扫频噪声 whoosh
  whoosh: (at, g) => add(at, 0.85, (t, p) => { const e = env(p, 0.35, 1.4) * g; const f = 300 + p * 2600; const s = Math.sin(2 * Math.PI * f * t * 0.02 + noise(t) * 2); return [e * (s * .5 + noise(t * .9) * .5), e * (s * .5 + noise(t * .8) * .5)]; }),
  land: (at, g) => add(at, 0.25, (t, p) => { const e = Math.exp(-p * 22) * g; return [e * Math.sin(2 * Math.PI * 85 * t), e * Math.sin(2 * Math.PI * 80 * t)]; }),
  // 开箱：锁扣双咔 + 上行琶音
  latch: (at, g) => { VOICES.clack(at, g * .8); VOICES.clack(at + 0.09, g * .6); },
  "riser-up": (at, g) => { const notes = [523.25, 659.25, 783.99, 1046.5]; notes.forEach((f, k) => add(at + 0.12 + k * 0.16, 0.5, (t) => { const e = Math.exp(-(t - 0) * 5) * g * .5; return [e * Math.sin(2 * Math.PI * f * t), e * Math.sin(2 * Math.PI * f * t + .4)]; })); },
  tick: (at, g) => add(at, 0.06, (t) => { const e = Math.exp(-t * 70) * g; return [e * noise(t * 8) * .6, e * noise(t * 8) * .6]; }),
  riser: (at, g) => add(at, 2.3, (t, p) => { const e = p * p * g * .5; const f = 70 + p * 240; return [e * Math.sin(2 * Math.PI * f * t), e * Math.sin(2 * Math.PI * f * t + 1.1)]; }),
  boom: (at, g) => add(at, 1.6, (t, p) => { const e = Math.exp(-p * 4.5) * g; const f = 120 - p * 70; return [e * Math.sin(2 * Math.PI * f * t), e * Math.sin(2 * Math.PI * f * t)]; }),
  shine: (at, g) => add(at, 1.8, (t, p) => { const e = env(p, 0.08, 2.4) * g * .5; return [e * Math.sin(2 * Math.PI * 2637 * t) * .5, e * Math.sin(2 * Math.PI * 3520 * t + .8) * .5]; }),
  "mute-gap": () => {},
};

for (const ev of scenes.sfx) {
  const fn = VOICES[ev.type];
  if (fn == null) throw new Error(`未知音效类型: ${ev.type}`);
  fn(ev.at, ev.gain);
}

// 软限幅 + 写 WAV
const clip = (x) => Math.max(-1, Math.min(1, x));
const pcm = Buffer.alloc(total * 2 * 2);
for (let i = 0; i < total; i += 1) {
  pcm.writeInt16LE(Math.round(clip(L[i] * 0.92) * 32767), i * 4);
  pcm.writeInt16LE(Math.round(clip(R[i] * 0.92) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);

mkdirSync(join(root, ".tmp", "promo"), { recursive: true });
const out = join(root, ".tmp", "promo", "sfx.wav");
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`[promo-sfx] ${out} (${(pcm.length / 1000 / 1000).toFixed(1)}MB, ${(total / SR).toFixed(1)}s)`);
