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
  for (const target of ["all", "dir", "AppImage", "deb", "tar.gz", "nsis"]) {
    assert.deepEqual(parseArgs([target, "--skip-install", "--skip-backend"]),
      { target, skipInstall: true, skipBackend: true, help: false });
  }
  for (const args of [["deb; touch /tmp/bad"], ["--linux"], ["deb", "dir"], ["--unknown"]]) {
    assert.throws(() => parseArgs(args), /Unknown target\/option/);
  }
});

test("removed shell packaging cannot be selected", () => {
  assert.throws(() => parseArgs(["deb", "--shell"]), /Unknown target\/option/);
});

test("just-provided build identity is complete, consistent and injected into the package", () => {
  const env = {
    QAQH_BUILD_VERSION: "2.1.20261031-1",
    QAQH_BUILD_DATE: "20261031",
    QAQH_GIT_COMMIT: "9f3610d6b6263f7abf690bfdd477c95658a0b85c",
    QAQH_GIT_DIRTY: "0",
  };
  assert.deepEqual(parseBuildIdentity(env), {
    version: "2.1.20261031-1",
    date: "20261031",
    commit: "9f3610d6b6263f7abf690bfdd477c95658a0b85c",
    dirty: false,
  });
  assert.equal(expectedPackageVersion("2.0.0", env), "2.1.20261031-1");
  assert.equal(expectedPackageVersion("2.0.0", {}), "2.0.0");
  assert.equal(parseBuildIdentity({ ...env, QAQH_BUILD_DATE: "" }).date, "20261031");
  assert.equal(parseBuildIdentity({ ...env, QAQH_BUILD_VERSION: "2.0.20261031" }).version, "2.0.20261031");
  assert.equal(parseBuildIdentity({ ...env, QAQH_BUILD_VERSION: "2.11.20261031-1", QAQH_BUILD_DATE: "" }).date, "20261031");
  assert.throws(() => expectedPackageVersion("2.0.0", { ...env, QAQH_BUILD_VERSION: "2.1.20261031-bad" }), /Invalid/);
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

test("RINGING_COMMAND_TYPES covers every generated RingingCommand variant in both directions", () => {
  const generated = readFileSync(fileURLToPath(new URL("../webui/src/api/qaqh/RingingCommand.ts", import.meta.url)), "utf8");
  const handlers = readFileSync(fileURLToPath(new URL("../src/main/ipc-handlers.ts", import.meta.url)), "utf8");
  const variants = new Set([...generated.matchAll(/\{\s*"type":\s*"([a-z][a-z0-9_.]*)"/g)].map(m => m[1]));
  const block = handlers.match(/const RINGING_COMMAND_TYPES[^=]*= new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "RINGING_COMMAND_TYPES block not found in ipc-handlers.ts");
  const declared = new Set([...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
  const missing = [...variants].filter(v => !declared.has(v));
  const stale = [...declared].filter(v => !variants.has(v));
  assert.deepEqual(missing, [], "renderer 发这些命令会被 invalid_command 拒：请补 RINGING_COMMAND_TYPES（或确认应从生成契约退出）");
  assert.deepEqual(stale, [], "白名单里有生成契约已删除的命令：请清理（TS 侧 ReadonlySet 类型可能还在放行旧名）");
});

test("Electron host exposes the typed command bridge and rejects non-renderer senders", () => {
  const handlers = readFileSync(fileURLToPath(new URL("../src/main/ipc-handlers.ts", import.meta.url)), "utf8");
  assert.match(handlers, /case "command"/);
  assert.match(handlers, /client\.command\(normalizeRendererCommand\(args\.command\), readCommandTarget\(args\.target\), readPreconditions\(args\.preconditions\)\)/);
  assert.match(handlers, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.doesNotMatch(handlers, /service_rpc/);
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
    version: process.env.QAQH_BUILD_VERSION || "1.0.0", main: "dist/main/index.cjs",
    author: { name: "QAQTam", email: "tsy3minso@gmail.com" }, homepage: "https://example.org" }));
  put("renderer/index.html", '<script src="/assets/app.js"></script>');
  put("renderer/assets/app.js", "console.log('fresh')");
  put("dist/main/index.cjs", "module.exports = {};");
  put("dist/preload/index.cjs", "module.exports = {};");
  const elf = Buffer.alloc(64);
  elf.write("\x7fELF"); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  put("resources/bin/qaqh-daemon", elf);
  chmodSync(join(root, "resources/bin/qaqh-daemon"), 0o755);
  // native addon：verifyNativeAddon 断言 asar 外副本与构建树逐字节一致。
  const addonName = process.platform === "win32"
    ? "qaqh_napi_client.win32-x64-msvc.node"
    : `qaqh_napi_client.${process.platform}-x64-gnu.node`;
  put(join("native", addonName), "native-addon-bytes");
  put(join("output/resources/app.asar.unpacked/native", addonName), "native-addon-bytes");
  return { root, put, addonName };
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

test("afterPack validates actual ASAR content and rejects stale renderer/daemon at the same version", async t => {
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
