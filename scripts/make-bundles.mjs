/**
 * make-bundles —— 组件热更新包产出(不产生系统安装包)。
 *
 * 两个 bundle,对应 updater 的两种 restartPolicy:
 *   frontend → app 代码(package.json + dist/ + renderer/),target 前缀 app/,重启 Electron;
 *   backend  → qaqh-daemon 二进制,target 前缀 backend/,重启 daemon。
 *
 * NSIS 平根布局(README doctrine:壳只从安装目录加载,不做 overlay):
 *   frontend → 整个 app 代码打成单文件 resources/app.asar,apply 即换 asar,重启 Electron;
 *   backend  → resources/bin/qaqh-daemon[.exe],apply 换 daemon 二进制(接线待做)。
 *
 * 用法(just 封装):
 *   node scripts/make-bundles.mjs [--skip-frontend] [--skip-backend] [--skip-install]
 *
 * 产物: .qaqh-bundles/<releaseId>/bundles/<kind>-<buildId>.zip (+ bundle-root 目录)
 * 构建身份沿用 just 注入的 QAQH_BUILD_VERSION / QAQH_GIT_COMMIT,缺失时回退 git。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { collectBundle } from "./collect-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = resolve(root, "../qaqh-backend");
const frontend = resolve(root, "webui");
const outRoot = resolve(root, ".qaqh-bundles");
const require = createRequire(import.meta.url);

function run(command, args, cwd = root, capture = false) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Windows 上 pnpm/cargo 都是 PATH shim(.cmd),无 shell 的 spawnSync 找不到;
    // 参数都是不含空格的简单 token,cmd 转发安全。
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`);
  return result.stdout;
}

function buildIdentity() {
  const commit = process.env.QAQH_GIT_COMMIT?.trim()
    || spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const version = process.env.QAQH_BUILD_VERSION?.trim() || "0.0.0-local";
  const dirty = process.env.QAQH_GIT_DIRTY === "1";
  const safeCommit = commit.slice(0, 8) + (dirty ? "-dirty" : "");
  return { version, commit, releaseId: `${version}+${commit.slice(0, 8)}`, buildId: safeCommit };
}

function stagingPath(kind) {
  const dir = join(outRoot, "staging", kind);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function buildFrontend(identity, skipInstall) {
  console.log("\n[bundle-frontend] renderer + shell code (NSIS asar flavor)");
  if (skipInstall) {
    // 依赖已就位才允许 skip;否则 typecheck/build 会自己失败,不在脚本里猜。
  } else {
    run("pnpm", ["install", "--frozen-lockfile"], frontend);
  }
  run("node", ["scripts/bundle.mjs", "all"], root);
  run("pnpm", ["run", "build"], frontend);
  rmSync(join(root, "renderer"), { recursive: true, force: true });
  cpSync(join(frontend, "out", "renderer"), join(root, "renderer"), { recursive: true });

  const staging = stagingPath("frontend");
  for (const entry of ["package.json", "dist", "renderer"]) {
    cpSync(join(root, entry), join(staging, entry), { recursive: true });
  }
  // 应用载荷 = 单个 resources/app.asar(electron 运行时从安装根的该路径加载)。
  // payload 目录与 staging 分离,避免 asar 把自己的输出再打进包里。
  const payload = stagingPath("frontend-payload");
  mkdirSync(join(payload, "resources"), { recursive: true });
  const asar = require("@electron/asar");
  await asar.createPackage(staging, join(payload, "resources", "app.asar"));
  const buildId = `frontend-${identity.buildId}`;
  const bundleRoot = join(outRoot, identity.releaseId, buildId);
  const zipOut = join(outRoot, identity.releaseId, "bundles", `${buildId}.zip`);
  mkdirSync(dirname(zipOut), { recursive: true });
  await collectBundle([
    "--kind", "frontend", "--build-id", buildId, "--app-version", identity.version,
    "--source", payload, "--out", bundleRoot,
    "--component", `frontend=${buildId}`, "--control-protocol", "1",
    "--release-id", identity.releaseId, "--channel", "local",
  ]);
  run("cargo", ["run", "--quiet", "--manifest-path", join(root, "crates", "qaqh-update", "Cargo.toml"),
    "--bin", "qaqh-pack", "--", "zip", "--bundle", bundleRoot,
    "--out", zipOut]);
}

function buildBackend(identity) {
  console.log("\n[bundle-backend] cargo release qaqh-daemon");
  const output = run("cargo", ["build", "--locked", "--release", "-p", "qaqh-daemon",
    "--message-format=json-render-diagnostics"], backend, true);
  const artifacts = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const artifact = artifacts.findLast((item) => item.reason === "compiler-artifact" &&
    item.target?.name === "qaqh-daemon" && item.target.kind.includes("bin") && item.executable);
  if (!artifact) throw new Error("Cargo did not report a qaqh-daemon executable.");

  const staging = stagingPath("backend");
  cpSync(artifact.executable, join(staging, basename(artifact.executable)));
  const buildId = `backend-${identity.buildId}`;
  const bundleRoot = join(outRoot, identity.releaseId, buildId);
  const zipOut = join(outRoot, identity.releaseId, "bundles", `${buildId}.zip`);
  mkdirSync(dirname(zipOut), { recursive: true });
  return collectBundle([
    "--kind", "backend", "--build-id", buildId, "--app-version", identity.version,
    "--source", staging, "--target-prefix", "resources/bin", "--out", bundleRoot,
    "--component", `backend=${buildId}`, "--control-protocol", "1",
    "--release-id", identity.releaseId, "--channel", "local",
    // Windows 落盘忽略 mode;Linux 包必须带执行位,否则应用后 daemon 无法执行。
    ...(process.platform === "win32" ? [] : ["--exec", basename(artifact.executable)]),
  ]).then(() => {
    run("cargo", ["run", "--quiet", "--manifest-path", join(root, "crates", "qaqh-update", "Cargo.toml"),
      "--bin", "qaqh-pack", "--", "zip", "--bundle", bundleRoot,
      "--out", zipOut]);
  });
}

async function main() {
  const skip = new Set(process.argv.slice(2));
  const skipInstall = skip.has("--skip-install");
  const identity = buildIdentity();
  console.log(`Bundle identity: ${identity.releaseId} (version ${identity.version})`);
  if (!existsSync(join(backend, "Cargo.toml"))) throw new Error(`qaqh-backend missing: ${backend}`);
  if (!skip.has("--skip-frontend")) await buildFrontend(identity, skipInstall);
  if (!skip.has("--skip-backend")) await buildBackend(identity);
  // 末步组装 update-source（bundles/ + catalog.json），qaqh-update stage 的输入端。
  run("node", ["scripts/make-update-source.mjs"]);
  console.log(`\nBundles ready: ${join(outRoot, identity.releaseId, "bundles")}`);
}

main().catch((error) => {
  console.error(`\nmake-bundles FAILED: ${error.message}`);
  process.exitCode = 1;
});
