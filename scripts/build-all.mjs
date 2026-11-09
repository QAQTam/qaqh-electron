import { sdkContract } from "./sdk-contract.mjs";
import { reserveLocalVersion } from "./release-version.mjs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, cpSync, chmodSync, rmSync, renameSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseArgs, parseBuildIdentity, assertInputs } = require("./packaging.cjs");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = resolve(root, "../qaqh-backend");
const frontend = resolve(root, "webui");
const nativeCrate = resolve(root, "crates/qaqh-napi-client");

function run(command, args, cwd = root, capture = false, env = process.env) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  // pnpm is a .cmd shim on Windows and must be launched via cmd.exe.
  const windowsPnpm = process.platform === "win32" && command === "pnpm";
  const invokedCommand = windowsPnpm ? (process.env.ComSpec || "cmd.exe") : command;
  const invokedArgs = windowsPnpm
    ? ["/d", "/s", "/c", ["pnpm.cmd", ...args].map(value => {
      const text = String(value);
      return /[\s"&|<>^()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(" ")]
    : args;
  const result = spawnSync(invokedCommand, invokedArgs, {
    cwd,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`);
  return result.stdout;
}

function install(cwd) {
  run("pnpm", ["install", "--frozen-lockfile"], cwd);
}

function syncDir(source, destination) {
  // 仅清理由流水线管理的产物，避免上次前端的旧 hash 文件混入本次安装包。
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

function assertGeneratedMirror(source, destination) {
  const names = (path) => readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
  const expected = names(source);
  const actual = names(destination);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Generated protocol file list drift: ${source} != ${destination}; run just sdk-sync`);
  }
  for (const name of expected) {
    if (!readFileSync(join(source, name)).equals(readFileSync(join(destination, name)))) {
      throw new Error(`Generated protocol file drift: ${name}; run just sdk-sync`);
    }
  }
}


async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: just build [all|dir|AppImage|deb|tar.gz|nsis] [--skip-install] [--skip-backend]\n" +
      "Linux x64 targets: all/dir/AppImage/deb/tar.gz. Windows x64 target: nsis.\n" +
      "deb/all reserve a daily revision; explicit QAQH_BUILD_VERSION overrides it. Source identity comes from just.");
    return;
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // 所有本地 target 共用一份账本：北京日期 + 当天递增修订号，版本号不用手改。
  // CI 显式注入 QAQH_BUILD_VERSION 时保留其已预留的版本，不重新分配。
  if (!process.env.QAQH_BUILD_VERSION) {
    process.env.QAQH_BUILD_VERSION = reserveLocalVersion(
      manifest.version, join(root, ".tmp/deb-version.json"),
    );
  }
  process.env.QAQH_BUILD_DATE ||= process.env.QAQH_BUILD_VERSION.split(".")[2].split("-")[0];
  const build = parseBuildIdentity(process.env);
  console.log(`Build identity: ${build.version}+${build.commit.slice(0, 8)}` +
    `${build.dirty ? "-dirty" : ""} (${build.date})`);
  const windowsBuild = process.platform === "win32" && options.target === "nsis";
  const linuxBuild = process.platform === "linux" && options.target !== "nsis";
  if ((!windowsBuild && !linuxBuild) || process.arch !== "x64") {
    throw new Error("Use native Linux x64 for Linux targets or native Windows x64 for nsis; cross-compilation is not supported.");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node.js >=22.12 is required.");
  for (const file of [join(frontend, "package.json"), join(frontend, "pnpm-lock.yaml"),
    join(backend, "Cargo.toml"), join(backend, "Cargo.lock"),
    join(nativeCrate, "Cargo.toml"), join(nativeCrate, "Cargo.lock")]) {
    if (!existsSync(file)) throw new Error(`Required repository/lockfile missing: ${file}`);
  }
  run("pnpm", ["--version"]);
  run("cargo", ["--version"]);

  console.log("\n[1/5] Contract and dependency preparation");
  // 协议运行时经 native 绑定直接编译 qaqh-client（与 daemon 同一 backend
  // workspace，lockstep 由 cargo 保证）；唯一物化契约是 WebUI 类型镜像。
  sdkContract();
  if (!options.skipInstall) {
    install(frontend);
    install(root);
  }

  console.log("\n[2/5] Backend daemon and native client addon");
  if (!options.skipBackend) {
    // Cargo 报告真实 executable 路径，兼容 CARGO_TARGET_DIR/后端 .cargo 配置。
    const output = run("cargo", ["build", "--locked", "--release", "-p", "qaqh-daemon",
      "--message-format=json-render-diagnostics"], backend, true);
    const artifacts = output.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const artifact = artifacts.findLast(item => item.reason === "compiler-artifact" &&
      item.target?.name === "qaqh-daemon" && item.target.kind.includes("bin") && item.executable);
    if (!artifact) throw new Error("Cargo did not report a qaqh-daemon executable.");
    const bin = join(root, "resources/bin");
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    const daemonName = windowsBuild ? "qaqh-daemon.exe" : "qaqh-daemon";
    cpSync(artifact.executable, join(bin, daemonName));
    if (!windowsBuild) chmodSync(join(bin, daemonName), 0o755);
    // 热更新 handoff 工作器:仅 Windows 平台随包分发(Linux 走 dpkg,verify-package
    // 拒绝系统包里出现 updater CLI)。见 crates/qaqh-update 与 docs 的更新设计。
    if (process.platform === "win32") {
      run("cargo", ["build", "--locked", "--release", "--manifest-path",
        join(root, "crates", "qaqh-update", "Cargo.toml"), "--bin", "qaqh-update"], root);
      cpSync(join(root, "crates", "qaqh-update", "target", "release", "qaqh-update.exe"),
        join(bin, "qaqh-update.exe"));
    }
  } else {
    console.warn("Explicit --skip-backend: reusing staged daemon; its source freshness is NOT guaranteed.");
  }

  // native 绑定（qaqh-napi-client → qaqh-client）与 daemon 同源编译。
  // 命名规则与 src/main/native-client.ts 的 nativeAddonFile 保持一致。
  const addonOutput = run("cargo", ["build", "--locked", "--release",
    "--message-format=json-render-diagnostics"], nativeCrate, true);
  const addonArtifacts = addonOutput.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const addon = addonArtifacts.findLast(item => item.reason === "compiler-artifact" &&
    item.target?.name === "qaqh_napi_client" && item.target?.crate_types?.includes("cdylib") &&
    Array.isArray(item.filenames) && item.filenames.some(name => name.endsWith(".so") || name.endsWith(".dll")));
  if (!addon) throw new Error("Cargo did not report the qaqh-napi-client cdylib.");
  const cdylibPath = addon.filenames.find(name => name.endsWith(".so") || name.endsWith(".dll"));
  const report = process.report?.getReport?.();
  const musl = process.platform === "linux" && report?.header?.glibcVersionRuntime == null;
  const suffix = process.platform === "win32"
    ? "win32-x64-msvc"
    : process.platform === "darwin"
      ? `darwin-x64`
      : `linux-x64-${musl ? "musl" : "gnu"}`;
  const addonName = `qaqh_napi_client.${suffix}.node`;
  mkdirSync(join(root, "native"), { recursive: true });
  cpSync(cdylibPath, join(root, "native", addonName));
  console.log(`Native client addon: native/${addonName} (${cdylibPath})`);

  console.log("\n[3/5] Renderer");
  run("pnpm", ["run", "typecheck"], frontend);
  run("pnpm", ["run", "build"], frontend);
  syncDir(join(frontend, "out/renderer"), join(root, "renderer"));

  console.log("\n[4/5] Electron shell");
  run("pnpm", ["run", "typecheck"]);
  rmSync(join(root, "dist"), { recursive: true, force: true });
  run(process.execPath, ["scripts/bundle.mjs", "all"]);
  assertInputs(root);

  console.log("\n[5/5] Package and verify");
  // 复用已安装、与当前依赖版本一致的 Electron，避免 builder 再下载同一份运行时。
  const electronExecutable = require("electron");
  if (!existsSync(electronExecutable)) throw new Error("Installed Electron binary missing; reinstall electron with build scripts enabled.");
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const staging = mkdtempSync(join(root, ".tmp/package-"));
  try {
    const targets = options.target === "all" ? [] : [options.target];
    run("pnpm", ["exec", "electron-builder", windowsBuild ? "--win" : "--linux", ...targets, "--x64", "--publish", "never",
      // Override semver prerelease sanitization: Debian needs a revision (-N), not ~N.
      ...(!windowsBuild ? ["--config.deb.fpm=--version", `--config.deb.fpm=${build.version}`,
        "--config.deb.fpm=build/deb/copyright=/usr/share/doc/qaqh-electron/copyright",
        "--config.deb.fpm=build/deb/com.qaqh.desktop.metainfo.xml=/usr/share/metainfo/com.qaqh.desktop.metainfo.xml"] : []),
      `--config.extraMetadata.version=${build.version}`,
      `--config.directories.output=${staging}`, `--config.electronDist=${dirname(electronExecutable)}`], root, false,
      { ...process.env,
        ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "1" });
    const expected = windowsBuild ? ["nsis"]
      : (options.target === "all" ? ["AppImage", "deb", "tar.gz"] : [options.target]);
    const files = readdirSync(staging);
    for (const target of expected) {
      const extension = target === "nsis" ? ".exe" : `.${target}`;
      if (target !== "dir" && !files.some(file => file.endsWith(extension))) {
        throw new Error(`electron-builder did not produce a ${extension} artifact for ${target}.`);
      }
    }
    for (const file of files.filter(file => file.endsWith(".deb"))) {
      const version = run("dpkg-deb", ["--field", join(staging, file), "Version"], root, true).trim();
      if (version !== build.version) throw new Error(`Debian Version mismatch: ${version} != ${build.version}`);
    }
    const unpackedDir = windowsBuild ? "win-unpacked" : "linux-unpacked";
    if (!existsSync(join(staging, unpackedDir, "resources/app.asar"))) {
      throw new Error(`Packaged app.asar missing from ${unpackedDir}.`);
    }
    // 成功才替换 release；失败不把旧安装包冒充成本次产物。
    const releaseDir = "release";
    rmSync(join(root, releaseDir), { recursive: true, force: true });
    renameSync(staging, join(root, releaseDir));
    console.log(`\nBuild succeeded: ${join(root, releaseDir)}\n${files.join("\n")}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`\nBuild FAILED: ${error.message}\nNo new release published; any existing release/ is from a previous build.`);
  process.exitCode = 1;
});
