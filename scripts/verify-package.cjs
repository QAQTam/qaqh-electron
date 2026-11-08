const { readFileSync, statSync, existsSync, readdirSync } = require("node:fs");
const { join, normalize, sep } = require("node:path");
const { createRequire } = require("node:module");
const { assertInputs, expectedPackageVersion, walkFiles, digest } = require("./packaging.cjs");

// 使用 builder 自身的 asar 库，不另加一份依赖。
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asar = libRequire("@electron/asar");

module.exports = async function verifyPackage(context) {
  const root = context.packager.projectDir;
  assertInputs(root);
  verifyAsar(context, root);
};

// 全量便携口径:asar 单包 + daemon。
function verifyAsar(context, root) {
  const resources = join(context.appOutDir, "resources");
  const archive = join(resources, "app.asar");
  const files = ["dist/main/index.cjs", "dist/preload/index.cjs",
    ...walkFiles(join(root, "renderer")).map(file => `renderer/${file}`)];
  for (const file of files) {
    if (digest(readFileSync(join(root, file))) !== digest(asar.extractFile(archive, normalize(file)))) {
      throw new Error(`Packaged file differs from current build: ${file}`);
    }
  }
  const packagedRenderer = asar.listPackage(archive).filter(file =>
    file.startsWith(`${sep}renderer${sep}`) && !asar.statFile(archive, file.slice(1)).files);
  // 按清单核对 renderer 文件数量,防止旧 hash 文件进入包。
  const distEntries = files.filter(file => !file.startsWith("renderer/")).length;
  if (packagedRenderer.length !== files.length - distEntries) {
    throw new Error("Packaged renderer contains missing/stale files.");
  }
  const daemonName = context.electronPlatformName === "win32" ? "qaqh-daemon.exe" : "qaqh-daemon";
  if (existsSync(join(resources, "baseline")) ||
      JSON.stringify(readdirSync(join(resources, "bin")).sort()) !== JSON.stringify([daemonName])) {
    throw new Error("System package must contain only its bundled daemon, without component overlays or updater CLIs.");
  }
  const daemon = join(resources, "bin", daemonName);
  if ((!process.platform.startsWith("win") && !(statSync(daemon).mode & 0o111)) ||
    digest(readFileSync(daemon)) !== digest(readFileSync(join(root, "resources/bin", daemonName)))) {
    throw new Error("Packaged daemon missing, not executable or stale.");
  }
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  const sourcePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedVersion = expectedPackageVersion(sourcePkg.version);
  if (pkg.main !== "dist/main/index.cjs" || pkg.version !== expectedVersion) {
    throw new Error(`Packaged entrypoint/version mismatch: expected ${expectedVersion}, got ${pkg.version}.`);
  }
  verifyNativeAddon(context, root, resources);
  console.log(`[verify] ${files.length} shell/renderer files and daemon match the current build.`);
}

// native 协议客户端必须落在 asar 之外（asarUnpack），且与仓库构建产物逐字节一致。
function verifyNativeAddon(context, root, resources) {
  const platform = context.electronPlatformName || process.platform;
  const report = process.report?.getReport?.();
  const musl = platform === "linux" && report?.header?.glibcVersionRuntime == null;
  const addonName = platform === "win32"
    ? "qaqh_napi_client.win32-x64-msvc.node"
    : `qaqh_napi_client.${platform}-x64-${musl ? "musl" : "gnu"}.node`;
  const packed = join(resources, "app.asar.unpacked", "native", addonName);
  const source = join(root, "native", addonName);
  if (!existsSync(source)) throw new Error(`Native addon missing from build tree: native/${addonName}; run the build pipeline.`);
  if (!existsSync(packed) ||
      digest(readFileSync(packed)) !== digest(readFileSync(source))) {
    throw new Error(`Packaged native addon missing or stale: app.asar.unpacked/native/${addonName}.`);
  }
  // asarUnpack 语义：节点保留在 asar 头清单并标记 unpacked=true，实体在
  // app.asar.unpacked。节点存在且未标 unpacked = 实体仍在包内。
  const archive = join(resources, "app.asar");
  let node = null;
  try {
    node = asar.statFile(archive, normalize(`native/${addonName}`), true);
  } catch {
    // asar 内无该条目也可以：实体整体在 app.asar.unpacked。
  }
  if (node && !node.unpacked) {
    throw new Error("Native addon was packed inside app.asar; asarUnpack did not apply.");
  }
}
