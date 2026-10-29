/**
 * make-baseline —— shell 包的出厂基线 zip(resources/baseline/{app,backend}.zip)。
 *
 * 用途链路:deb postinst 用 qaqh-maint unpack 把它们落到系统 seed
 * (/var/lib/qaqh-harness),壳首跑再提升到用户域 overlay,给 updater 的
 * plan/stage 提供 install-state 起点。布局与 make-bundles 同一契约
 * (collect-bundle → qaqh-pack zip,target 前缀 app/ 与 backend/)。
 *
 * 用法: node scripts/make-baseline.mjs [--version <v>]
 * 前置: dist/ + renderer/ 已就绪(just build 的 1-4 步)、resources/bin/qaqh-daemon
 *       已就绪、qaqh-pack release 二进制已构建(build-all.mjs shell 分支负责)。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBundle } from "./collect-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "resources/baseline");
const workDir = resolve(root, ".qaqh-baseline");
const pack = resolve(root, "crates/qaqh-update/target/release/qaqh-pack");

function zip(bundleRoot, out) {
  const result = spawnSync(pack, ["zip", "--bundle", bundleRoot, "--out", out], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`qaqh-pack zip failed for ${bundleRoot}`);
}

async function main() {
  if (!existsSync(pack)) {
    throw new Error(`qaqh-pack missing: ${pack}(先 cargo build --release --manifest-path crates/qaqh-update/Cargo.toml --bins)`);
  }
  const args = process.argv.slice(2);
  const version = args.includes("--version") ? args[args.indexOf("--version") + 1] : "0.0.0-baseline";
  const buildId = `baseline-${version}`;

  rmSync(outDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // app 基线:dist + renderer + package.json,与前端热更新包同一 target 前缀 app/。
  const appStaging = join(workDir, "app");
  mkdirSync(appStaging, { recursive: true });
  for (const entry of ["package.json", "dist", "renderer"]) {
    cpSync(join(root, entry), join(appStaging, entry), { recursive: true });
  }
  const appBundle = join(workDir, "bundle-app");
  await collectBundle([
    "--kind", "frontend", "--build-id", buildId, "--app-version", version,
    "--source", appStaging, "--target-prefix", "app", "--out", appBundle,
    "--component", `frontend=${buildId}`, "--control-protocol", "1",
    "--release-id", buildId, "--channel", "local",
    "--exec", "dist/main/index.cjs", "--exec", "dist/preload/index.cjs",
  ]);
  zip(appBundle, join(outDir, "app.zip"));

  // backend 基线:resources/bin/qaqh-daemon。
  const daemon = resolve(root, "resources/bin/qaqh-daemon");
  if (!existsSync(daemon)) throw new Error(`qaqh-daemon missing: ${daemon}`);
  const backendStaging = join(workDir, "backend");
  mkdirSync(backendStaging, { recursive: true });
  cpSync(daemon, join(backendStaging, "qaqh-daemon"));
  const backendBundle = join(workDir, "bundle-backend");
  await collectBundle([
    "--kind", "backend", "--build-id", buildId, "--app-version", version,
    "--source", backendStaging, "--target-prefix", "backend", "--out", backendBundle,
    "--component", `backend=${buildId}`, "--control-protocol", "1",
    "--release-id", buildId, "--channel", "local",
    "--exec", "qaqh-daemon",
  ]);
  zip(backendBundle, join(outDir, "backend.zip"));

  rmSync(workDir, { recursive: true, force: true });
  console.log(`baseline ready: ${outDir} (app.zip + backend.zip, buildId=${buildId})`);
}

main().catch((error) => {
  console.error(`\nmake-baseline FAILED: ${error.message}`);
  process.exitCode = 1;
});
