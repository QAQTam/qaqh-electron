import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, cpSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  parseArgs,
  parseBuildIdentity,
  expectedPackageVersion,
  assertInputs,
  walkFiles,
} = require("./packaging.cjs");
const verify = require("./verify-package.cjs");
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asar = libRequire("@electron/asar");

test("CLI accepts only explicit targets and known opt-outs", () => {
  assert.equal(parseArgs([]).target, "all");
  for (const target of ["all", "dir", "AppImage", "deb", "tar.gz"]) {
    assert.deepEqual(parseArgs([target, "--skip-install", "--skip-backend"]),
      { target, skipInstall: true, skipBackend: true, help: false, shell: false });
  }
  for (const args of [["deb; touch /tmp/bad"], ["--linux"], ["deb", "dir"], ["--unknown"]]) {
    assert.throws(() => parseArgs(args), /Unknown target\/option/);
  }
});

test("--shell selects the shell packaging criteria (plain dir + baseline)", () => {
  assert.equal(parseArgs(["deb", "--shell"]).shell, true);
  assert.equal(parseArgs(["deb"]).shell, false);
  assert.equal(parseArgs(["--shell", "--skip-backend"]).shell, true);
});

test("just-provided build identity is complete, consistent and injected into the package", () => {
  const env = {
    QAQH_BUILD_VERSION: "2.0.20261028",
    QAQH_BUILD_DATE: "20261028",
    QAQH_GIT_COMMIT: "9f3610d6b6263f7abf690bfdd477c95658a0b85c",
    QAQH_GIT_DIRTY: "0",
  };
  assert.deepEqual(parseBuildIdentity(env), {
    version: "2.0.20261028",
    date: "20261028",
    commit: "9f3610d6b6263f7abf690bfdd477c95658a0b85c",
    dirty: false,
  });
  assert.equal(expectedPackageVersion("2.0.0", env), "2.0.20261028");
  assert.equal(expectedPackageVersion("2.0.0", {}), "2.0.0");
  assert.throws(() => parseBuildIdentity({ ...env, QAQH_BUILD_VERSION: "" }), /just build/);
  assert.throws(() => parseBuildIdentity({ ...env, QAQH_BUILD_DATE: "20261029" }), /disagree/);
  assert.throws(() => parseBuildIdentity({ ...env, QAQH_GIT_COMMIT: "" }), /QAQH_GIT_COMMIT/);
});

test("preload exposes a narrow Electron host bridge, not the legacy Tauri or generic Electron globals", () => {
  const preload = readFileSync(fileURLToPath(new URL("../src/preload/index.ts", import.meta.url)), "utf8");
  assert.match(preload, /exposeInMainWorld\("qaqhHost"/);
  assert.match(preload, /ipcRenderer\.invoke\("qaqh:invoke", command, args\)/);
  assert.doesNotMatch(preload, /__TAURI_INTERNALS__|electronAPI|exposeInMainWorld\("electronAPI"/);
  assert.match(preload, /Unsupported QAQH event/);
});

test("Electron service surface is runtime-allowlisted and has no unrestricted Tauri IPC channel", () => {
  const handlers = readFileSync(fileURLToPath(new URL("../src/main/ipc-handlers.ts", import.meta.url)), "utf8");
  assert.match(handlers, /SERVICE_METHODS\.has\(method\)/);
  assert.match(handlers, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.doesNotMatch(handlers, /tauri:invoke|tauri:event/);
});

function fixture(t) {
  const temp = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, contents) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  };
  put("package.json", JSON.stringify({ name: "fixture",
    version: process.env.QAQH_BUILD_VERSION || "1.0.0", main: "dist/bootstrap.cjs",
    author: { name: "QAQTam", email: "tsy3minso@gmail.com" }, homepage: "https://example.org" }));
  put("renderer/index.html", '<script src="/assets/app.js"></script>');
  put("renderer/assets/app.js", "console.log('fresh')");
  put("dist/bootstrap.cjs", "module.exports = {};");
  put("dist/main/index.cjs", "module.exports = {};");
  put("dist/preload/index.cjs", "module.exports = {};");
  const elf = Buffer.alloc(64);
  elf.write("\x7fELF"); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  put("resources/bin/qaqh-daemon", elf);
  chmodSync(join(root, "resources/bin/qaqh-daemon"), 0o755);
  return { root, put };
}

test("preflight rejects missing resources, wrong architecture and missing metadata", t => {
  const { root, put } = fixture(t);
  assert.doesNotThrow(() => assertInputs(root));
  assert.deepEqual(walkFiles(join(root, "renderer")).sort(), ["assets/app.js", "index.html"]);
  rmSync(join(root, "renderer/index.html"));
  assert.throws(() => assertInputs(root), /renderer\/index.html/);
  put("renderer/index.html", "index");
  put("resources/bin/qaqh-daemon", "not an ELF executable");
  assert.throws(() => assertInputs(root), /Linux x64 ELF/);
});

test("preflight rejects missing author metadata", t => {
  const { root, put } = fixture(t);
  put("package.json", "{}");
  assert.throws(() => assertInputs(root), /author.name/);
});

test("afterPack validates actual ASAR content and rejects stale renderer/daemon", async t => {
  const { root, put } = fixture(t);
  const appOutDir = join(root, "output");
  put("output/resources/bin/qaqh-daemon", readFileSync(join(root, "resources/bin/qaqh-daemon")));
  chmodSync(join(appOutDir, "resources/bin/qaqh-daemon"), 0o755);
  const input = join(root, "archive-input");
  for (const file of ["package.json", "dist", "renderer"]) {
    cpSync(join(root, file), join(input, file), { recursive: true });
  }
  const archive = join(appOutDir, "resources/app.asar");
  await asar.createPackage(input, archive);
  const context = { packager: { projectDir: root }, appOutDir };
  await verify(context);
  put("renderer/assets/app.js", "changed");
  await assert.rejects(verify(context), /differs from current build/);
  put("renderer/assets/app.js", "console.log('fresh')");
  put("output/resources/bin/qaqh-daemon", "stale daemon");
  await assert.rejects(verify(context), /daemon missing, not executable or stale/);
});
