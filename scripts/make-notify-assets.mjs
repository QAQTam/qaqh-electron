// 桌面通知静态素材生成（开发者机跑一次,产物 commit 进仓）：
//   resources/notify/countdown-10s.gif —— 封箱 hero 卡动画。hero 槽位官方口径
//   364x180@100%（2:1）,高斯屏 728x360@200%——按 728x364 出图保 200% 锐度,
//   1fps×11 帧（10..0s）,bar 逐秒退格 + 秒数倒数（与 notifier 的
//   SEAL_AUTO_CONTINUE_MS=10s 同刻起播,toast 弹出即开表,天然同步；
//   单播完停在「0s」帧,配合主进程 1s 收卡宽限完整播完）。
//   两遍 palettegen 压体积（逐帧独立调色板在 2x 尺寸下会肥到 MB 级）。
// 依赖:开发者机 ffmpeg（分发产物不需要——GIF 随包走 extraResources）。
// 用法: node scripts/make-notify-assets.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = join(root, "resources", "notify");
mkdirSync(outDir, { recursive: true });
const tmp = join(outDir, ".frames");
mkdirSync(tmp, { recursive: true });

// drawtext 需要具体字体文件（含中文字形）;拷进 tmp 让 ffmpeg 用相对路径,绕开
// filtergraph 的盘符冒号转义。Windows 用微软雅黑,Linux 回退文泉驿/DejaVu。
const fontCandidates = [
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\msyh.ttf",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];
const fontSrc = fontCandidates.find((f) => existsSync(f));
if (!fontSrc) {
  console.error("no usable font found; install a ttf and add its path to fontCandidates");
  process.exit(1);
}
const font = join(tmp, "font.ttf");
copyFileSync(fontSrc, font);

// hero 槽 2:1；728x364 = 200% 缩放下的官方 364x180 逻辑尺寸,100% 屏由系统降采样。
const W = 728, H = 364, BAR_X = 40, BAR_W = 648, BAR_Y = 258, BAR_H = 30;
const FRAMES = 11; // 10..0 共 11 帧@1fps:末帧「0s」给 notifier 的收卡宽限留位

const frame = (index) => {
  const secondsLeft = FRAMES - 1 - index; // 10..0
  const barWidth = Math.round((BAR_W * secondsLeft) / (FRAMES - 1)); // 10→满格 … 0→空
  const vf = [
    `drawbox=x=${BAR_X}:y=${BAR_Y}:w=${BAR_W}:h=${BAR_H}:color=0x4a4d55:t=fill`,
    `drawbox=x=${BAR_X}:y=${BAR_Y}:w=${barWidth}:h=${BAR_H}:color=0x4fd1c5:t=fill`,
    `drawtext=fontfile=font.ttf:text='自动继续交接 ${secondsLeft}s':fontcolor=white:fontsize=68:x=${BAR_X}:y=110`,
  ].join(",");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x1f2127:s=${W}x${H}`,
    "-vf", vf, "-frames:v", "1", join(tmp, `f${String(index).padStart(2, "0")}.png`),
  ], { cwd: tmp });
};

for (let i = 0; i < FRAMES; i += 1) frame(i);

// 两遍调色板压体积;单播停在末帧(-loop 1),toast 弹完 10s 后 bar 归零定格。
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", "f%02d.png", "-vf", "palettegen=stats_mode=full", "pal.png",
], { cwd: tmp });
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-framerate", "1", "-i", "f%02d.png", "-i", "pal.png",
  "-lavfi", "paletteuse=dither=none", "-loop", "1", "-final_delay", "100", "countdown-10s.gif",
], { cwd: tmp });

const gif = join(outDir, "countdown-10s.gif");
rmSync(gif, { force: true });
copyFileSync(join(tmp, "countdown-10s.gif"), gif);
rmSync(tmp, { recursive: true, force: true });
console.log("wrote", gif);
