import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ["src/main/daemon.ts"], bundle: true,
  platform: "node", format: "cjs", write: false, external: ["electron"] });

/** electron 与 node:child_process 的 require 级 mock（daemon.ts 的两个外部面）。 */
function shim(name, childProcess) {
  if (name === "electron") return { app: { isPackaged: true } };
  if (name === "node:child_process") return childProcess;
  return require(name);
}

/**
 * daemon.ts 现在自带 discovery 校验/判活（不再 import @qaqh/sdk/node），
 * 夹具相应改用**真实**的存活进程 + 真实 daemon.json + 本地 HTTP 断言服务。
 */

/** 轻量夹具：只求值模块，供可执行解析/inode 判定断言使用（无子进程/端口）。 */
function execFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qaqh-package-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  mkdirSync(join(resources, "bin"), { recursive: true });
  const executable = join(resources, "bin/qaqh-daemon");
  cpSync(process.execPath, executable);
  const env = { QAQH_USE_USER_BACKEND: "1" };
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", (compiled.outputFiles[0].text))(
    name => shim(name, { spawn: () => { throw new Error("spawn should not run in exec fixture"); } }),
    module, module.exports,
    { ...process, env, platform: "linux", resourcesPath: resources });
  return { ...module.exports, executable };
}

async function fixture(t, busy = false) {
  const root = mkdtempSync(join(tmpdir(), "qaqh-package-start-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir), { recursive: true });
  const resources = join(root, "resources");
  mkdirSync(join(resources, "bin"), { recursive: true });
  const executable = join(resources, "bin/qaqh-daemon");
  cpSync(process.execPath, executable);

  // 存活的“旧 daemon”：长睡 node 子进程（pid 判活真实通过）。
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    if (child.pid) resolve();
    else child.once("spawn", resolve);
    child.once("error", reject);
  });

  const calls = [];
  let stopped = false;
  const server = createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url?.endsWith("/health")) { res.end("ok"); return; }
    if (req.url?.endsWith("/control/v1/stop-if-idle")) {
      if (busy) { res.statusCode = 409; res.end("busy"); return; }
      stopped = true;
      child.kill("SIGKILL");
      res.end("{}");
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  // executable 指向 node 副本（inode 与子进程真实 exe 不同 → 触发替换流程）。
  writeFileSync(join(dataDir, "daemon.json"), JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: "test",
    pid: child.pid,
    server_epoch: "epoch-old",
    protocol_version: 1,
    daemon_version: "3.0.0-test",
    build_id: "test-build",
    channel: "dev",
    executable,
    lan_endpoint: null,
    tls_fingerprint: null,
  }));

  const env = { QAQH_DATA_DIR: dataDir };
  let spawnReached = false;
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", (compiled.outputFiles[0].text))(
    name => shim(name, { spawn: () => { spawnReached = true; throw new Error("spawn reached after idle stop"); } }),
    module, module.exports,
    { ...process, env, platform: "linux", resourcesPath: resources });
  return { ...module.exports, executable, calls, root, stopped: () => stopped, spawnReached: () => spawnReached };
}

test("installed application ignores old overlay and daemon environment overrides", t => {
  const f = execFixture(t);
  assert.equal(f.resolveDaemonExecutable(), f.executable);
  rmSync(f.executable);
  assert.equal(f.resolveDaemonExecutable(), null);
});

test("same path/version cannot hide a replaced running executable", t => {
  const f = execFixture(t);
  assert.equal(f.daemonMatchesExecutable(process.pid, process.execPath), true);
  assert.equal(f.daemonMatchesExecutable(process.pid, f.executable), false);
});

test("obsolete daemon is replaced through stop-if-idle; active work blocks replacement", async t => {
  const idle = await fixture(t);
  await assert.rejects(new idle.DaemonManager().ensureDaemonRunning(), err => {
    if (!(err instanceof Error) || !/spawn reached after idle stop/.test(err.message)) {
      console.error("[DEBUG] unexpected rejection:", err, "calls:", JSON.stringify(idle.calls));
      return false;
    }
    return true;
  });
  assert.match(idle.calls[1].url, /\/control\/v1\/stop-if-idle$/);
  assert.equal(idle.calls[1].authorization, "Bearer test");
  assert.ok(idle.stopped(), "stop-if-idle 成功后旧 daemon 进程应已退出");
  const busy = await fixture(t, true);
  await assert.rejects(new busy.DaemonManager().ensureDaemonRunning(), /旧版 daemon 正在工作/);
});
