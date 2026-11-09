/**
 * 前端-only 滚动打包：版本号自己跑，不重编后端、不走 sdk-check。
 *
 * 版本沿用 scripts/release-version.mjs 的本地账本：北京日期 + 当天递增修订号
 * （3.0.20261109-1 → -2 → 次日 3.0.20261110-1），与 deb/all 共用同一份账本，
 * 所以同一次本地构建不会撞号。package.json 里的版本只是「最低基线」，不用手改。
 *
 * 用法（或直接 `just frontend-rolling`）：
 *   node scripts/package-frontend.mjs [--wizard]
 *   QAQH_BUILD_VERSION=3.0.20261109-9 node scripts/package-frontend.mjs   # 显式覆盖
 *
 * 产物：release/rolling/<version>/
 *   QAQ-Harness-<version>-win-x64-setup.exe (+ blockmap / latest.yml)
 *   win-unpacked/                         完整解包目录
 *   app.asar                               可直接覆盖 resources/app.asar
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveLocalVersion } from "./release-version.mjs";

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
// CI/复现可显式注入；本地默认自动分配（失败也会消耗该修订号，符合滚动发布语义）。
const version = process.env.QAQH_BUILD_VERSION?.trim()
  || reserveLocalVersion(manifest.version, join(root, ".tmp/deb-version.json"));
const date = version.split(".")[2]?.split("-")[0] ?? "";
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
  QAQH_BUILD_DATE: date,
  QAQH_GIT_COMMIT: commit,
  QAQH_GIT_DIRTY: dirty,
  QAQH_BUILD_ID: commit,
  ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "1",
};
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
