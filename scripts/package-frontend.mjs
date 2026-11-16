/**
 * 前端-only 滚动打包：版本号自己跑，不重编后端、不走 sdk-check。
 *
 * 版本固定取 package.json(4.0.0)，不再按日期分配修订号。
 *
 * 用法（或直接 `just frontend-rolling`）：
 *   node scripts/package-frontend.mjs [--wizard]
 *   QAQH_BUILD_VERSION=4.0.0 node scripts/package-frontend.mjs   # 显式覆盖
 *
 * 产物：release/rolling/<version>/
 *   QAQ-Harness-<version>-win-x64-setup.exe (+ blockmap / latest.yml)
 *   win-unpacked/                         完整解包目录
 *   app.asar                               可直接覆盖 resources/app.asar
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/package-frontend.mjs [--wizard]\n" +
    "  --wizard   assisted NSIS installer (welcome / choose install directory)");
  process.exit(0);
}
const unknown = args.filter((arg) => arg !== "--wizard");
if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(" ")}`);
const wizard = args.includes("--wizard");

const { assertInputs } = require("./packaging.cjs");
assertInputs(root, "win32");

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// CI/复现可显式注入；缺省用 package.json 的固定版本。
const version = process.env.QAQH_BUILD_VERSION?.trim() || manifest.version;
const git = (...argv) => spawnSync("git", argv, { cwd: root, encoding: "utf8" }).stdout.trim();
const commit = git("rev-parse", "HEAD") || "unknown";
const dirty = git("status", "--porcelain").length > 0 ? "1" : "0";

const electron = require("electron");
if (!existsSync(electron)) throw new Error("Installed Electron binary missing; reinstall electron with build scripts enabled.");
const cli = require.resolve("electron-builder/cli.js");
const out = join(root, "release", "rolling", version);
mkdirSync(out, { recursive: true });

const env = {
  ...process.env,
  QAQH_BUILD_VERSION: version,
  QAQH_GIT_COMMIT: commit,
  QAQH_GIT_DIRTY: dirty,
  QAQH_BUILD_ID: commit,
  ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "1",
};

// 新鲜度守卫(2026-11-12 事故:rolling 打过"新版本号 + 旧 dist/renderer"的包)。
// electron-builder 只搬 dist/** 与 renderer/**,本身不构建;所以打包前强制
// 重建三件:清 dist → bundle main/preload → vite 重建 renderer → 同步进根 renderer/。
const runStep = (command, args, cwd = root) => {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const step = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (step.error) throw step.error;
  if (step.status !== 0) throw new Error(`新鲜度构建失败(exit ${step.status}): ${command} ${args.join(" ")}`);
};
rmSync(join(root, "dist"), { recursive: true, force: true });
runStep(process.execPath, [join(root, "scripts", "bundle.mjs"), "all"]);
// 不走 require.resolve:vite 8 的 exports 白名单不含 bin 子路径,直接取物理入口。
runStep(process.execPath, [join(root, "webui", "node_modules", "vite", "bin", "vite.js"), "build"], join(root, "webui"));
rmSync(join(root, "renderer"), { recursive: true, force: true });
cpSync(join(root, "webui", "out", "renderer"), join(root, "renderer"), { recursive: true });
const builderArgs = [
  cli, "--win", "nsis", "--x64", "--publish", "never",
  `--config.extraMetadata.version=${version}`,
  `--config.directories.output=${out}`,
  `--config.electronDist=${dirname(electron)}`,
  ...(wizard ? [
    "--config.nsis.oneClick=false",
    "--config.nsis.allowToChangeInstallationDirectory=true",
    "--config.nsis.perMachine=false",
  ] : []),
];

console.log(`\n[rolling] ${version}  commit ${commit.slice(0, 8)}${dirty === "1" ? "-dirty" : ""}` +
  `  mode ${wizard ? "assisted" : "one-click"}\n[rolling] output ${out}\n`);
const result = spawnSync(process.execPath, builderArgs, { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`electron-builder failed (${result.status})`);

const asar = join(out, "win-unpacked", "resources", "app.asar");
if (!existsSync(asar)) throw new Error(`Packaged app.asar missing: ${asar}`);
copyFileSync(asar, join(out, "app.asar"));

console.log(`\n[rolling] done ${version}`);
console.log(`  setup : QAQ-Harness-${version}-win-x64-setup.exe`);
console.log(`  patch : ${join(out, "app.asar")}`);
console.log(`  next build will allocate ${version.split("-")[0]}-${Number(version.split("-")[1] ?? 0) + 1}` +
  ` (or -1 on the next Beijing date)`);
