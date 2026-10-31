import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { identifyBaseline } from "./baseline-metadata.mjs";
import * as sdkNode from "@qaqh/sdk/node";
import * as protocol from "@qaqh/sdk/protocol";

const require = createRequire(import.meta.url);
const bundles = new Map();
async function source(entry) {
  if (!bundles.has(entry)) bundles.set(entry, build({ entryPoints: [entry], bundle: true,
    write: false, platform: "node", format: "cjs", external: ["electron", "@qaqh/sdk/node", "@qaqh/sdk/protocol"], logLevel: "silent",
  }).then(result => result.outputFiles[0].text));
  return bundles.get(entry);
}
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "qaqh-baseline-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "user-components"), resources = join(dir, "resources");
  const appPath = join(resources, "app");
  const env = { QAQH_COMPONENT_ROOT: root };
  const calls = [], events = [];
  const put = (path, text) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text); };
  const json = (path, value) => put(path, JSON.stringify(value));
  const statePath = join(root, "install-state.json");
  const state = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { components: {} };
  const install = (name, current, version, health = "healthy") => {
    const installed = state();
    installed.components[name] = { current, version, health };
    json(statePath, installed);
    for (const file of name === "frontend"
      ? ["app/package.json", "app/dist/main/index.cjs", "app/dist/preload/index.cjs", "app/renderer/index.html"]
      : ["backend/qaqh-daemon"]) put(join(root, file), current);
  };
  const index = { formatVersion: 1, components: {} };
  const baseline = (name, version = "2.0.20261029", buildId = `baseline-${name}-new`) => {
    const bundle = name === "frontend" ? "app.zip" : "backend.zip";
    const bytes = Buffer.from(buildId);
    put(join(resources, "baseline", bundle), bytes);
    index.components[name] = { buildId, version, bundle, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") };
    json(join(resources, "baseline", "baseline.json"), index);
  };
  baseline("frontend"); baseline("backend");
  json(join(appPath, "package.json"), { version: "2.0.20261029" });
  let failure = null;
  const deps = {
    "@qaqh/sdk/node": sdkNode,
    "@qaqh/sdk/protocol": protocol,
    "node:child_process": { ...require("node:child_process"), execFileSync: (exe, args) => {
      const name = args[1].endsWith("backend.zip") ? "backend" : "frontend";
      calls.push({ exe, args }); events.push(`unpack:${name}`);
      if (failure === name) throw Error("simulated unpack failure");
      const meta = index.components[name];
      install(name, meta.buildId, meta.version);
    } },
    electron: { app: { isPackaged: true, getAppPath: () => appPath,
      requestSingleInstanceLock: () => true, quit: () => events.push("quit") } },
    "node:module": { createRequire: file => () => events.push(`main:${dirname(file)}`) },
  };
  const load = async entry => {
    const module = { exports: {} };
    new Function("require", "module", "exports", "process", "console", "__dirname", await source(entry))(
      name => deps[name] ?? require(name), module, module.exports,
      { env, pid: process.pid, platform: process.platform, resourcesPath: resources },
      { log() {}, warn: (...args) => events.push(["warning", ...args]) }, join(appPath, "dist"));
    return module.exports;
  };
  return { root, resources, appPath, env, calls, events, deps, put, json, state, install, baseline, index, load,
    fail: name => { failure = name; },
    reconcile: async () => (await load("src/main/baseline.ts")).reconcileBaseline({ packaged: true, resourcesPath: resources, appPath }),
  };
}

test("first install seeds both components; unchanged launch does not unpack again", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.reconcile(), { frontend: true, backend: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].args[2], f.root);
  assert.deepEqual(await f.reconcile(), { frontend: true, backend: true });
  assert.equal(f.calls.length, 2);
});

test("deb upgrade replaces legacy overlay despite existing install-state, BEFORE old main", async t => {
  const f = fixture(t);
  f.install("frontend", "baseline-2.0.20261028", "2.0.20261028");
  f.install("backend", "baseline-2.0.20261028", "2.0.20261028");
  await f.load("src/main/bootstrap.ts");
  assert.deepEqual(f.events, ["unpack:frontend", "unpack:backend", `main:${join(f.root, "app")}`]);
  assert.equal(f.state().components.frontend.current, f.index.components.frontend.buildId);
  assert.equal(f.env.QAQH_USE_USER_BACKEND, "1");
});

test("newer per-component hot updates survive an older deb baseline", async t => {
  const f = fixture(t);
  f.install("frontend", "hot-frontend", "2.0.20261030");
  f.install("backend", "hot-backend", "2.0.20261030");
  assert.deepEqual(await f.reconcile(), { frontend: true, backend: true });
  assert.equal(f.calls.length, 0);
});

test("same-version hot updates survive until system baseline content changes", async t => {
  const f = fixture(t);
  await f.reconcile();
  f.calls.length = 0;
  f.install("frontend", "hot-same-day", "2.0.20261029");
  await f.reconcile();
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().components.frontend.current, "hot-same-day");
  f.baseline("frontend", "2.0.20261029", "baseline-rebuilt-same-day");
  await f.reconcile();
  assert.equal(f.calls.length, 1);
  assert.equal(f.state().components.frontend.current, "baseline-rebuilt-same-day");
});

test("partial component update does not downgrade newer frontend", async t => {
  const f = fixture(t);
  f.install("frontend", "hot", "2.0.20261030");
  f.install("backend", "old", "2.0.20261028");
  await f.reconcile();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args[1].endsWith("backend.zip"));
});

test("missing files or failed health trigger repair despite current state", async t => {
  const f = fixture(t);
  await f.reconcile();
  f.calls.length = 0;
  fs.unlinkSync(join(f.root, "app/renderer/index.html"));
  f.install("backend", "hot", "2.0.20261030", "failed");
  await f.reconcile();
  assert.equal(f.calls.length, 2);
});

test("unpack failure falls back to packaged app/backend and retries next launch", async t => {
  const f = fixture(t);
  f.fail("backend");
  await f.load("src/main/bootstrap.ts");
  assert.ok(f.events.includes(`main:${f.appPath}`));
  assert.equal(f.env.QAQH_USE_USER_BACKEND, "0");
  assert.equal(fs.existsSync(join(f.root, "baseline-receipt.json")), false);
  f.fail(null);
  assert.deepEqual(await f.reconcile(), { frontend: true, backend: true });
});

test("corrupt payload is rejected before either component is modified", async t => {
  const f = fixture(t);
  f.put(join(f.resources, "baseline/backend.zip"), "corrupt");
  assert.deepEqual(await f.reconcile(), { frontend: false, backend: false });
  assert.equal(f.calls.length, 0);
});

test("seed opt-out does not authorize stale overlays", async t => {
  const f = fixture(t);
  f.env.QAQH_BASELINE_SEED = "0";
  assert.deepEqual(await f.reconcile(), { frontend: false, backend: false });
  assert.equal(f.calls.length, 0);
});

test("second instance never unpacks or loads main", async t => {
  const f = fixture(t);
  f.deps.electron.app.requestSingleInstanceLock = () => false;
  await f.load("src/main/bootstrap.ts");
  assert.deepEqual(f.events, ["quit"]);
});

test("inherited resolved app env cannot pin old overlay across relaunch", async t => {
  const f = fixture(t);
  const old = join(f.root, "app");
  f.install("frontend", "old", "2.0.20261028");
  f.env.QAQH_APP_DIR = old;
  f.env.QAQH_RESOLVED_APP_DIR = old;
  await f.load("src/main/bootstrap.ts");
  assert.equal(f.calls.length, 2);
  assert.ok(f.events.indexOf("unpack:frontend") < f.events.indexOf(`main:${old}`));
});

test("explicit app override is honored without seeding user components", async t => {
  const f = fixture(t);
  const custom = join(f.root, "explicit");
  f.put(join(custom, "dist/main/index.cjs"), "override");
  f.env.QAQH_APP_DIR = custom;
  await f.load("src/main/bootstrap.ts");
  assert.deepEqual(f.events, [`main:${custom}`]);
});

test("full packages reject older shell overlays without a baseline index", async t => {
  const f = fixture(t);
  fs.rmSync(join(f.resources, "baseline"), { recursive: true });
  f.install("frontend", "old", "2.0.20261028");
  f.install("backend", "old", "2.0.20261028");
  assert.deepEqual(await f.reconcile(), { frontend: false, backend: false });
});

test("unified component path honors override, XDG data home, then HOME", async t => {
  const f = fixture(t);
  const paths = await f.load("src/main/component-paths.ts");
  assert.equal(paths.userComponentRoot(), f.root);
  delete f.env.QAQH_COMPONENT_ROOT;
  f.env.XDG_DATA_HOME = join(f.root, "xdg");
  assert.equal(paths.userComponentRoot(), join(f.root, "xdg/QAQ-Harness"));
});

test("numeric release order and same-version dirty payload identities", async t => {
  const f = fixture(t);
  const { compareReleaseVersions } = await f.load("src/main/baseline.ts");
  assert.equal(compareReleaseVersions("2.0.9", "2.0.10"), -1);
  assert.equal(compareReleaseVersions("2.1.20261031-1", "2.0.20261031"), 1);
  assert.equal(compareReleaseVersions("2.1.20261031-1", "2.1.20261031-1"), 0);
  assert.equal(compareReleaseVersions("2.1.20261031-2", "2.1.20261031-10"), -1);
  assert.equal(compareReleaseVersions("2.1.20261031", "2.1.20261031-1"), 1);
  assert.equal(compareReleaseVersions("2.1.20261031-1", "2.1.20261031"), -1);
  assert.equal(compareReleaseVersions("2.1.20261031-dirty", "2.1.20261031-1"), null);
  assert.equal(compareReleaseVersions("unknown", "2.0.10"), null);
  const manifest = { appVersion: "2.0.20261029", files: [{ target: "app/main", sha256: "a" }],
    components: { frontend: { version: "2.0.20261029" } } };
  const first = identifyBaseline(manifest);
  const second = identifyBaseline({ ...manifest, files: [{ target: "app/main", sha256: "b" }] });
  assert.notEqual(first.buildId, second.buildId);
  assert.equal(first.components.frontend.buildId, first.buildId);
  assert.equal(identifyBaseline(manifest).buildId, first.buildId);
});

test("revisioned baseline upgrades old backend while preserving a newer frontend revision", async t => {
  const f = fixture(t);
  f.baseline("frontend", "2.1.20261031-1");
  f.baseline("backend", "2.1.20261031-1");
  f.install("frontend", "hot-revision-2", "2.1.20261031-2");
  f.install("backend", "old-backend", "2.0.20261031");
  const { reconcileBaseline } = await f.load("src/main/baseline.ts");
  reconcileBaseline({ packaged: true, appPath: f.appPath, resourcesPath: f.resources });
  assert.deepEqual(f.calls.map(call => call.args[1].endsWith("backend.zip")), [true]);
  assert.equal(f.state().components.frontend.version, "2.1.20261031-2");
  assert.equal(f.state().components.backend.version, "2.1.20261031-1");
});

test("missing/corrupt index and unrepairable user state fall back without deleting state", async t => {
  const f = fixture(t);
  fs.unlinkSync(join(f.resources, "baseline/baseline.json"));
  assert.deepEqual(await f.reconcile(), { frontend: false, backend: false });
  f.baseline("frontend");
  f.put(join(f.resources, "baseline/baseline.json"), "broken json");
  assert.deepEqual(await f.reconcile(), { frontend: false, backend: false });
  f.baseline("frontend");
  f.put(join(f.root, "install-state.json"), "broken json");
  // The real engine refuses to commit over corrupt state. Never delete it or
  // report the partially written overlay as usable.
  f.fail("frontend");
  assert.deepEqual(await f.reconcile(), { frontend: false, backend: false });
  assert.equal(fs.readFileSync(join(f.root, "install-state.json"), "utf8"), "broken json");
});

test("development bootstrap never seeds or chooses a packaged user overlay", async t => {
  const f = fixture(t);
  f.deps.electron.app.isPackaged = false;
  await f.load("src/main/bootstrap.ts");
  assert.deepEqual(f.events, [`main:${f.appPath}`]);
  assert.equal(f.calls.length, 0);
});

test("daemon and updater share custom root and obey bootstrap fallback decision", async t => {
  const f = fixture(t);
  f.install("backend", "hot", "2.0.20261030");
  f.put(join(f.resources, "bin/qaqh-daemon"), "packaged daemon");
  const { resolveDaemonExecutable } = await f.load("src/main/daemon.ts");
  const { updaterPaths } = await f.load("src/main/updater.ts");
  assert.equal(updaterPaths().componentRoot, f.root);
  f.env.QAQH_USE_USER_BACKEND = "0";
  assert.equal(resolveDaemonExecutable(), join(f.resources, "bin/qaqh-daemon"));
  f.env.QAQH_USE_USER_BACKEND = "1";
  assert.equal(resolveDaemonExecutable(), join(f.root, "backend/qaqh-daemon"));
  f.env.QAQH_DAEMON_PATH = join(f.resources, "bin/qaqh-daemon");
  assert.equal(resolveDaemonExecutable(), f.env.QAQH_DAEMON_PATH);
});
