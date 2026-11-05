import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ["src/main/daemon.ts"], bundle: true,
  platform: "node", format: "cjs", write: false,
  external: ["electron", "@qaqh/sdk/node", "@qaqh/sdk/protocol"] });

function fixture(t, busy = false) {
  const root = mkdtempSync(join(tmpdir(), "qaqh-package-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  mkdirSync(join(resources, "bin"), { recursive: true });
  const executable = join(resources, "bin/qaqh-daemon");
  cpSync(process.execPath, executable);
  const obsolete = join(root, "old-user-daemon");
  writeFileSync(obsolete, "old binary");
  const env = { QAQH_DAEMON_PATH: obsolete, QAQH_USE_USER_BACKEND: "1",
    QAQH_COMPONENT_ROOT: root, QAQH_ACTIVE_GENERATION: root };
  const discovery = { pid: 123456789, endpoint: "http://127.0.0.1:1", token: "test" };
  const calls = [];
  let stopped = false;
  const dependencies = {
    electron: { app: { isPackaged: true } },
    "@qaqh/sdk/node": { isAlive: () => !stopped, resolveCredentials: async () => discovery,
      DiscoveryError: class extends Error {} },
    "@qaqh/sdk/protocol": { RINGING_V2_VERSION: 2 },
    "node:child_process": { spawn: () => { throw new Error("spawn reached after idle stop"); } },
  };
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/health")) return new Response("ok");
    if (busy) return new Response("busy", { status: 409 });
    stopped = true;
    return new Response();
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", "fetch", compiled.outputFiles[0].text)(
    name => dependencies[name] ?? require(name), module, module.exports,
    { env, platform: "linux", resourcesPath: resources }, fetch);
  return { ...module.exports, executable, calls, root };
}

test("installed application ignores old overlay and daemon environment overrides", t => {
  const f = fixture(t);
  assert.equal(f.resolveDaemonExecutable(), f.executable);
  rmSync(f.executable);
  assert.equal(f.resolveDaemonExecutable(), null);
});

test("same path/version cannot hide a replaced running executable", t => {
  const f = fixture(t);
  assert.equal(f.daemonMatchesExecutable(process.pid, process.execPath), true);
  assert.equal(f.daemonMatchesExecutable(process.pid, f.executable), false);
});

test("obsolete daemon is replaced through stop-if-idle; active work blocks replacement", async t => {
  const idle = fixture(t);
  await assert.rejects(new idle.DaemonManager().ensureDaemonRunning(), /spawn reached after idle stop/);
  assert.match(idle.calls[1].url, /\/control\/v1\/stop-if-idle$/);
  assert.equal(idle.calls[1].options.headers.Authorization, "Bearer test");
  const busy = fixture(t, true);
  await assert.rejects(new busy.DaemonManager().ensureDaemonRunning(), /旧版 daemon 正在工作/);
});
