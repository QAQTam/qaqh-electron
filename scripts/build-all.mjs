import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, cpSync, chmodSync, rmSync, renameSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseArgs, parseBuildIdentity, assertInputs } = require("./packaging.cjs");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = resolve(root, "../qaqh-sdk");
const backend = resolve(root, "../qaqh-backend");
const frontend = resolve(root, "webui");

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
    throw new Error(`Generated protocol file list drift: ${source} != ${destination}`);
  }
  for (const name of expected) {
    if (!readFileSync(join(source, name)).equals(readFileSync(join(destination, name)))) {
      throw new Error(`Generated protocol file drift: ${name}`);
    }
  }
}

function checkBackendContract() {
  const revision = run("git", ["rev-parse", "HEAD"], backend, true).trim();
  const dirty = run("git", ["status", "--porcelain"], backend, true).trim() !== "";
  const env = {
    ...process.env,
    QAQH_SOURCE_REVISION: dirty ? "development" : revision,
    QAQH_SOURCE_DIRTY: dirty ? "1" : "0",
  };
  const args = ["run", "--locked", "-p", "qaqh-contract-export", "--", "check", "--against", join(sdk, "src/protocol/generated")];
  if (!dirty) args.push("--release");
  run("cargo", args, backend, false, env);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: just build [all|dir|AppImage|deb|tar.gz|nsis] [--skip-install] [--skip-backend] [--shell]\n" +
      "Linux x64 targets: all/dir/AppImage/deb/tar.gz. Windows x64 target: nsis.\n" +
      "--shell: shell 包口径(electron-builder.shell.yml)——plain dir baseline + 双 CLI + 维护脚本,\n" +
      "         仅支持 deb 目标;AppImage/tar.gz 永远是全量口径。\n" +
      "Build identity comes from just (QAQH_BUILD_VERSION / QAQH_BUILD_DATE / QAQH_GIT_COMMIT).");
    return;
  }
  if (options.shell && !["all", "deb", "dir"].includes(options.target)) {
    throw new Error(`shell 口径只支持 deb(dir=调试);${options.target} 请走全量口径(去掉 --shell)。`);
  }
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
  for (const file of [join(sdk, "package.json"), join(sdk, "pnpm-lock.yaml"), join(sdk, "src/core/index.ts"),
    join(frontend, "package.json"), join(frontend, "pnpm-lock.yaml"),
    join(backend, "Cargo.toml"), join(backend, "Cargo.lock")]) {
    if (!existsSync(file)) throw new Error(`Required sibling repository/lockfile missing: ${file}`);
  }
  run("pnpm", ["--version"]);
  run("cargo", ["--version"]);

  console.log("\n[1/5] SDK and dependency preparation");
  checkBackendContract();
  assertGeneratedMirror(join(sdk, "src/protocol/generated/types/qaqh"), join(frontend, "src/api/qaqh"));
  if (!options.skipInstall) install(sdk);
  run("pnpm", ["run", "build"], sdk);
  if (!existsSync(join(sdk, "dist/core/index.js"))) throw new Error("qaqh-sdk build did not produce dist/core/index.js");
  if (!options.skipInstall) {
    install(frontend);
    install(root);
  }

  console.log("\n[2/5] Backend daemon");
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
  } else {
    console.warn("Explicit --skip-backend: reusing staged daemon; its source freshness is NOT guaranteed.");
  }

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
  if (options.shell) {
    // shell 口径专属产物:更新引擎双 CLI + 出厂基线 zip。
    run("cargo", ["build", "--locked", "--release", "--manifest-path",
      join(root, "crates", "qaqh-update", "Cargo.toml"), "--bins"]);
    for (const bin of ["qaqh-maint", "qaqh-update"]) {
      cpSync(join(root, "crates", "qaqh-update", "target", "release", bin), join(root, "resources", "bin", bin));
      chmodSync(join(root, "resources", "bin", bin), 0o755);
    }
    run(process.execPath, ["scripts/make-baseline.mjs", "--version", build.version]);
  }
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const staging = mkdtempSync(join(root, ".tmp/package-"));
  try {
    const targets = options.target === "all" ? [] : [options.target];
    run("pnpm", ["exec", "electron-builder", windowsBuild ? "--win" : "--linux", ...targets, "--x64", "--publish", "never",
      ...(options.shell ? ["--config", "electron-builder.shell.yml"] : []),
      `--config.extraMetadata.version=${build.version}`,
      `--config.directories.output=${staging}`, `--config.electronDist=${dirname(electronExecutable)}`], root, false,
      { ...process.env, ...(options.shell ? { QAQH_SHELL_PACKAGE: "1" } : {}),
        ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "1" });
    const expected = windowsBuild ? ["nsis"] : options.shell
      ? ["deb"]
      : (options.target === "all" ? ["AppImage", "deb", "tar.gz"] : [options.target]);
    const files = readdirSync(staging);
    for (const target of expected) {
      const extension = target === "nsis" ? ".exe" : `.${target}`;
      if (target !== "dir" && !files.some(file => file.endsWith(extension))) {
        throw new Error(`electron-builder did not produce a ${extension} artifact for ${target}.`);
      }
    }
    if (options.shell) {
      if (!existsSync(join(staging, "linux-unpacked/resources/app/dist/bootstrap.cjs"))) {
        throw new Error("Shell layout broken: plain-dir baseline app missing bootstrap.cjs.");
      }
      if (existsSync(join(staging, "linux-unpacked/resources/app.asar"))) {
        throw new Error("Shell layout must not contain app.asar.");
      }
    } else {
      const unpackedDir = windowsBuild ? "win-unpacked" : "linux-unpacked";
      if (!existsSync(join(staging, unpackedDir, "resources/app.asar"))) {
        throw new Error(`Packaged app.asar missing from ${unpackedDir}.`);
      }
    }
    // 成功才替换 release；失败不把旧安装包冒充成本次产物。
    const releaseDir = options.shell ? "release-shell" : "release";
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
