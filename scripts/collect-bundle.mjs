/**
 * collect-bundle —— 把构建产物物化成 qaqh-update 的 bundle 布局:
 *
 *   <out>/bundle.json          清单(kind/buildId/components/files[])
 *   <out>/files/<target>       按 install-relative 路径落盘的字节
 *
 * 这是 Windows 版 collect-payload-winui.ps1 的 Linux 对等物。产物可直接被
 * `qaqh-pack zip` 压成发布 zip、被 `qaqh-pack delta` 当作 target 做增量,
 * 被 updater 的 apply_bundle_zip 应用。清单 schema 见 crates/qaqh-update/src/model.rs。
 *
 * 用法:
 *   node scripts/collect-bundle.mjs --kind frontend --build-id <id> --app-version <v> \
 *     --source <dir> --target-prefix app --out <bundle-root> \
 *     [--component frontend=<buildId>] [--component-version frontend=<v>] \
 *     [--control-protocol 1] [--exec dist/main/index.cjs] [--release-id r] [--channel c]
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 简易 --key value 解析;--exec/--component 可重复。 */
function parseArgs(argv) {
  const options = {
    kind: "", buildId: "", appVersion: "", source: "", targetPrefix: "", out: "",
    exec: [], components: [], componentVersions: [], controlProtocol: null,
    releaseId: "", channel: "",
  };
  const walk = (args) => {
    for (let index = 0; index < args.length; index += 1) {
      const key = args[index];
      const value = args[index + 1];
      if (value === undefined) throw new Error(`missing value for ${key}`);
      index += 1;
      switch (key) {
        case "--kind": options.kind = value; break;
        case "--build-id": options.buildId = value; break;
        case "--app-version": options.appVersion = value; break;
        case "--source": options.source = value; break;
        case "--target-prefix": options.targetPrefix = value.replace(/^\/+|\/+$/g, ""); break;
        case "--out": options.out = value; break;
        case "--exec": options.exec.push(value); break;
        case "--component": options.components.push(value); break;
        case "--component-version": options.componentVersions.push(value); break;
        case "--control-protocol": options.controlProtocol = Number(value); break;
        case "--release-id": options.releaseId = value; break;
        case "--channel": options.channel = value; break;
        default: throw new Error(`unknown flag ${key}`);
      }
    }
  };
  walk(argv);
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" && value === "" && !["releaseId", "channel", "targetPrefix"].includes(key)) {
      throw new Error(`missing required --${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
    }
  }
  const KINDS = new Set(["full", "frontend", "backend", "renderer", "shell", "runtime"]);
  if (!KINDS.has(options.kind)) throw new Error(`unsupported bundle kind '${options.kind}'`);
  return options;
}

/** 相对路径白名单:与 qaqh-update 的 validate_relative_path 同口径(只认 / 分隔)。 */
function safeRelative(root, absolute) {
  const rel = relative(root, absolute).split("\\").join("/");
  if (rel === "" || rel.startsWith("..") || rel.includes("../")) throw new Error(`path escapes source root: ${absolute}`);
  return rel;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(sourceRoot, targetPrefix, forceExec) {
  const forceExecSet = new Set(forceExec);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // 安装 payload 不含链接(与 crate 同口径)
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const rel = safeRelative(sourceRoot, path);
      if (rel.endsWith(".map")) continue; // payload 不带 sourcemap(与 electron-builder files 同口径)
      const target = targetPrefix ? `${targetPrefix}/${rel}` : rel;
      // target 同样不许逃逸:安装根是 safe_join 的边界(crate install_root.rs 同口径)。
      if (target.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new Error(`path escapes install root: ${target}`);
      }
      const stats = statSync(path);
      const executable = forceExecSet.has(rel) || (stats.mode & 0o111) !== 0;
      files.push({
        source: `files/${target}`,
        target,
        size: stats.size,
        sha256: sha256File(path),
        ...(executable ? { mode: 0o755 } : {}),
      });
    }
  };
  walk(sourceRoot);
  if (files.length === 0) throw new Error(`source contains no files: ${sourceRoot}`);
  return files;
}

/** 纯函数:由选项 + 文件清单组装 bundle manifest(model.rs::BundleManifest,camelCase)。 */
export function buildBundleManifest(options, files) {
  const components = {};
  const names = options.components.length > 0
    ? options.components
    : [options.kind === "full" ? "frontend" : options.kind];
  for (const name of names) {
    const [id, buildId] = name.includes("=") ? name.split("=", 2) : [name, options.buildId];
    const versionEntry = options.componentVersions.find((entry) => entry.startsWith(`${id}=`));
    components[id] = {
      buildId,
      version: versionEntry ? versionEntry.split("=", 2)[1] : options.appVersion,
      ...(options.controlProtocol != null ? { controlProtocol: options.controlProtocol } : {}),
    };
  }
  return {
    formatVersion: 1,
    kind: options.kind,
    buildId: options.buildId,
    appVersion: options.appVersion,
    ...(options.releaseId ? { releaseId: options.releaseId } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
    components,
    requiresFullInstall: options.kind === "full",
    files,
  };
}

export async function collectBundle(argv) {
  const options = parseArgs(argv);
  const sourceRoot = resolve(options.source);
  if (!existsSync(sourceRoot)) throw new Error(`source not found: ${sourceRoot}`);
  const outRoot = resolve(options.out);
  rmSync(outRoot, { recursive: true, force: true });

  const files = collectFiles(sourceRoot, options.targetPrefix, options.exec);
  for (const file of files) {
    const destination = join(outRoot, file.source);
    mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    const relativeToSource = options.targetPrefix
      ? file.target.slice(options.targetPrefix.length + 1)
      : file.target;
    cpSync(join(sourceRoot, relativeToSource), destination);
  }
  const manifest = buildBundleManifest(options, files);
  writeFileSync(join(outRoot, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`collect: ${files.length} files, ${bytes} bytes -> ${outRoot}`);
  return manifest;
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  collectBundle(process.argv.slice(2)).catch((error) => {
    console.error(`collect-bundle: ${error.message}`);
    process.exitCode = 1;
  });
}
