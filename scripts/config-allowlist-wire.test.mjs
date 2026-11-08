import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost, mockNativeAddon } from "./test-host.mjs";

// 信封的逐字节形状（schema/version/contract_revision/headers）现在由 Rust 侧
// qaqh-client 构造并有自己的 crate 测试；Electron 层断言适配层把命令原样
// 交给 native 绑定，且目标/preconditions 语义不被 IPC 路由改变。
test("config.save crosses Electron as a global Ringing command", async t => {
  const mock = mockNativeAddon();
  const host = await loadHost({ native: mock.addon });
  const client = new host.RingingClient({}, () => {});
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  const patch = { toolAllowlistEnabled: true, toolAllowlist: ["read", "glob", "grep"] };
  await host.invoke("command", { command: { type: "config.save", patch } });
  assert.deepEqual(mock.submissions.at(-1), [
    { kind: "global" },
    { type: "config.save", patch },
    { preconditions: [] },
  ]);
});

test("session-scoped service calls carry explicit session_id params and allowlist rejects unknowns", async t => {
  const mock = mockNativeAddon();
  const serviceCalls = [];
  mock.client.serviceCall = async (method, params) => { serviceCalls.push([method, params]); return { ok: true }; };
  const host = await loadHost({ native: mock.addon });
  const client = new host.RingingClient({}, () => {});
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  await host.invoke("service_query", { method: "session.meta", params: { session_id: "ses-1" } });
  assert.deepEqual(serviceCalls, [["session.meta", { session_id: "ses-1" }]]);
  assert.deepEqual(mock.submissions, []);
  // 参数缺失的会话查询必须在闸门处被拒（E04 回归：target 不再被丢进空 params）。
  await assert.rejects(host.invoke("service_query", { method: "session.meta", params: {} }), /session_id/);
  await assert.rejects(host.invoke("service_query", { method: "totally.unknown", params: {} }), /unsupported_service_method/);
});

test("native addon service allowlist matches the TS method table in both directions", async t => {
  const { createRequire } = await import("node:module");
  const { existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const host = await loadHost();
  const require2 = createRequire(import.meta.url);
  const addonFile = process.platform === "win32"
    ? "qaqh_napi_client.win32-x64-msvc.node"
    : `qaqh_napi_client.${process.platform}-x64-gnu.node`;
  const addonPath = fileURLToPath(new URL(`../native/${addonFile}`, import.meta.url));
  if (!existsSync(addonPath)) {
    t.skip(`native addon not built (${addonFile}); run the build pipeline first`);
    return;
  }
  const addon = require2(addonPath);
  const addonMethods = addon.serviceMethods().sort();
  const tableMethods = [...host.MAIN_SERVICE_METHODS].sort();
  assert.deepEqual(addonMethods, tableMethods,
    "addon 与 TS 方法表漂移：白名单真源必须单点对齐（更新 src/main/types.ts 或 qaqh-client QueryRequest）");
  assert.equal(addon.ringingV2Version(), 2);
  assert.match(addon.commandContractRevision(), /^ringing-commands-/);
});
