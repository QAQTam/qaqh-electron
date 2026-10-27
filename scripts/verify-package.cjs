const { readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");
const { assertInputs, walkFiles, digest } = require("./packaging.cjs");

// 使用 builder 自身的 asar 库，不另加一份依赖。
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asar = libRequire("@electron/asar");

module.exports = async function verifyPackage(context) {
  const root = context.packager.projectDir;
  assertInputs(root);
  const resources = join(context.appOutDir, "resources");
  const archive = join(resources, "app.asar");
  const files = ["dist/main/index.cjs", "dist/preload/index.cjs",
    ...walkFiles(join(root, "renderer")).map(file => `renderer/${file}`)];
  for (const file of files) {
    if (digest(readFileSync(join(root, file))) !== digest(asar.extractFile(archive, file))) {
      throw new Error(`Packaged file differs from current build: ${file}`);
    }
  }
  const packagedRenderer = asar.listPackage(archive).filter(file =>
    file.startsWith("/renderer/") && !asar.statFile(archive, file.slice(1)).files);
  if (packagedRenderer.length !== files.length - 2) {
    throw new Error("Packaged renderer contains missing/stale files.");
  }
  const daemon = join(resources, "bin/qaqh-daemon");
  if (!(statSync(daemon).mode & 0o111) ||
    digest(readFileSync(daemon)) !== digest(readFileSync(join(root, "resources/bin/qaqh-daemon")))) {
    throw new Error("Packaged daemon missing, not executable or stale.");
  }
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  const sourcePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.main !== "dist/main/index.cjs" || pkg.version !== sourcePkg.version) {
    throw new Error("Packaged entrypoint/version mismatch.");
  }
  console.log(`[verify] ${files.length} shell/renderer files and daemon match the current build.`);
};
