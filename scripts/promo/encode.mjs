// 宣传片合成：scripts/promo/encode.mjs
// PNG 序列（.tmp/promo/frames）+ sfx.wav → .tmp/promo/promo.mp4（H.264 CRF16）。
// ffmpeg 解析顺序：PATH → winget Links（Gyan.FFmpeg 安装位）。
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const framesDir = join(root, ".tmp", "promo", "frames");
const wav = join(root, ".tmp", "promo", "sfx.wav");
const out = join(root, ".tmp", "promo", "promo.mp4");

const findFfmpeg = () => {
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0 ? "ffmpeg" : null,
    join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
  ].filter((p) => p != null && (p === "ffmpeg" || existsSync(p)));
  if (candidates.length === 0) throw new Error("未找到 ffmpeg（winget install Gyan.FFmpeg 或加入 PATH）");
  return candidates[0];
};

const count = readdirSync(framesDir).filter((f) => f.endsWith(".png")).length;
if (count === 0) throw new Error("帧目录为空，先跑 render.mjs");
const fps = Number(process.env.PROMO_FPS ?? 30);
const ffmpeg = findFfmpeg();
console.log(`[promo-encode] ${count} frames @${fps}fps via ${ffmpeg}`);

const args = [
  "-y", "-framerate", String(fps), "-i", join(framesDir, "f%05d.png"),
  "-i", wav,
  "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
  "-c:a", "aac", "-b:a", "192k", "-shortest",
  out,
];
const r = spawnSync(ffmpeg, args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`[promo-encode] ${out}`);
