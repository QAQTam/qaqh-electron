const { readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");
const { assertInputs, expectedPackageVersion, walkFiles, digest } = require("./packaging.cjs");

// 使用 builder 自身的 asar 库，不另加一份依赖。
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asar = libRequire("@electron/asar");

module.exports = async function verifyPackage(context) {
  const root = context.packager.projectDir;
  assertInputs(root);
  if (process.env.QAQH_SHELL_PACKAGE === "1") {
    verifyShellLayout(context, root);
    return;
  }
  verifyLegacyAsar(context, root);
};

// 全量便携口径:asar 单包 + daemon。
function verifyLegacyAsar(context, root) {
  const resources = join(context.appOutDir, "resources");
  const archive = join(resources, "app.asar");
  const files = ["dist/bootstrap.cjs", "dist/main/index.cjs", "dist/preload/index.cjs",
    ...walkFiles(join(root, "renderer")).map(file => `renderer/${file}`)];
  for (const file of files) {
    if (digest(readFileSync(join(root, file))) !== digest(asar.extractFile(archive, file))) {
      throw new Error(`Packaged file differs from current build: ${file}`);
    }
  }
  const packagedRenderer = asar.listPackage(archive).filter(file =>
    file.startsWith("/renderer/") && !asar.statFile(archive, file.slice(1)).files);
  // dist 条目数不再硬编码(bootstrap 加入后是 3 个),按清单实际结构计算。
  const distEntries = files.filter(file => !file.startsWith("renderer/")).length;
  if (packagedRenderer.length !== files.length - distEntries) {
    throw new Error("Packaged renderer contains missing/stale files.");
  }
  const daemon = join(resources, "bin/qaqh-daemon");
  if (!(statSync(daemon).mode & 0o111) ||
    digest(readFileSync(daemon)) !== digest(readFileSync(join(root, "resources/bin/qaqh-daemon")))) {
    throw new Error("Packaged daemon missing, not executable or stale.");
  }
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  const sourcePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedVersion = expectedPackageVersion(sourcePkg.version);
  if (pkg.main !== "dist/bootstrap.cjs" || pkg.version !== expectedVersion) {
    throw new Error(`Packaged entrypoint/version mismatch: expected ${expectedVersion}, got ${pkg.version}.`);
  }
  console.log(`[verify] ${files.length} shell/renderer files and daemon match the current build.`);
}

// shell 口径:plain-dir baseline + 双 CLI + 出厂基线 zip(定稿双根架构)。
function verifyShellLayout(context, root) {
  const resources = join(context.appOutDir, "resources");
  const appDir = join(resources, "app");
  if (statSync(join(resources, "app.asar"), { throwIfNoEntry: false })) {
    throw new Error("Shell layout must not contain app.asar.");
  }
  // baseline plain dir:bootstrap + main + preload + renderer 与源逐字节一致。
  for (const file of ["dist/bootstrap.cjs", "dist/main/index.cjs", "dist/preload/index.cjs"]) {
    if (digest(readFileSync(join(appDir, file))) !== digest(readFileSync(join(root, file)))) {
      throw new Error(`Shell baseline differs from current build: ${file}`);
    }
  }
  const sourceRenderer = walkFiles(join(root, "renderer"));
  if (walkFiles(join(appDir, "renderer")).length !== sourceRenderer.length) {
    throw new Error("Shell baseline renderer contains missing/stale files.");
  }
  for (const file of sourceRenderer) {
    if (digest(readFileSync(join(appDir, "renderer", file))) !== digest(readFileSync(join(root, "renderer", file)))) {
      throw new Error(`Shell baseline renderer differs from current build: ${file}`);
    }
  }
  // 双 CLI + daemon 兜底:在位、可执行、与源一致。
  for (const bin of ["qaqh-daemon", "qaqh-maint", "qaqh-update"]) {
    const packaged = join(resources, "bin", bin);
    if (!(statSync(packaged).mode & 0o111) ||
      digest(readFileSync(packaged)) !== digest(readFileSync(join(root, "resources/bin", bin)))) {
      throw new Error(`Shell package CLI missing, not executable or stale: ${bin}`);
    }
  }
  // 出厂基线 zip:postinst seed 的输入,缺一不可。
  for (const bundle of ["app.zip", "backend.zip"]) {
    const path = join(resources, "baseline", bundle);
    if (!statSync(path, { throwIfNoEntry: false })?.isFile() || statSync(path).size === 0) {
      throw new Error(`Shell package baseline bundle missing or empty: ${bundle}`);
    }
  }
  const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const sourcePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedVersion = expectedPackageVersion(sourcePkg.version);
  if (pkg.main !== "dist/bootstrap.cjs" || pkg.version !== expectedVersion) {
    throw new Error(`Shell baseline entrypoint/version mismatch: expected ${expectedVersion}, got ${pkg.version}.`);
  }
  console.log(`[verify] shell layout: plain app dir (${sourceRenderer.length} renderer files), 3 CLIs, 2 baseline zips.`);
}
