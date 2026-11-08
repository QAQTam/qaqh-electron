import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const bundle = build({
  stdin: {
    contents: `export {registerIpcHandlers, reconnectAndRestoreSession} from "./src/main/ipc-handlers.ts";
      export {RingingClient} from "./src/main/ringing-client.ts";
      export {processGroup} from "./src/main/process-metrics.ts";
      export {ChallengeManager, APPROVAL_TTL_MS, MAX_PENDING_APPROVALS} from "./src/main/challenges.ts";
      export {approvalCommand, flattenAdminApprovals} from "./src/main/approvals.ts";
      export {setNativeAddonOverride, NativeClientError} from "./src/main/native-client.ts";
      export {MAIN_SERVICE_METHODS} from "./src/main/types.ts";`,
    resolveDir: root,
  },
  bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
  external: ["electron"],
}).then(result => result.outputFiles[0].text);

/** Run actual host modules, mocking only Electron and the native addon boundary. No GUI/files/network. */

// fake addon 的方法全集：由 loadHost 从 bundle 导出回填（与真实 addon 的一致性
// 由 packaging 测试校验）。
let serviceMethodsCache = [];

export async function loadHost({ native, timers, windows = [] } = {}) {
  const handlers = new Map();
  const electron = {
    app: { getPath: () => "/unused-interaction-test", quit() {} },
    BrowserWindow: class { static getAllWindows() { return windows; } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  };
  const dependencies = { electron };
  const module = { exports: {} };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", "console", await bundle)(
    name => dependencies[name] ?? require(name), module, module.exports,
    timers?.setTimeout ?? setTimeout, timers?.clearTimeout ?? clearTimeout,
    { ...console, warn() {} },
  );
  // native 覆写放在 bundle 求值之后亦可：loadNativeAddon 是惰性调用。
  serviceMethodsCache = module.exports.MAIN_SERVICE_METHODS;
  module.exports.setNativeAddonOverride(native ?? null);
  const frame = { url: "app://localhost/index.html" };
  const event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  return {
    ...module.exports,
    handlers,
    invoke: (command, args = {}, sender = event) => handlers.get("qaqh:invoke")(sender, command, args),
  };
}

export class FakeTimers {
  jobs = new Map();
  counter = 0;
  setTimeout = (fn, delay) => { const id = ++this.counter; this.jobs.set(id, { fn, delay }); return id; };
  clearTimeout = id => this.jobs.delete(id);
  async next() {
    const [id, job] = this.jobs.entries().next().value ?? [];
    if (!job) throw new Error("No pending timer");
    this.jobs.delete(id);
    job.fn();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    return job.delay;
  }
}

/**
 * Fake qaqh-napi-client addon：NativeClient.create 记录适配层注册的回调，
 * 返回可编程的 fake 客户端。测试经 `emit.*` 驱动 Rust→JS 的推送面
 * （status/event/reset/liveness），经 `watches`/`submissions` 观察调用面。
 */
export function mockNativeAddon() {
  const submissions = [];
  const watches = [];
  const closedSeeds = [];
  let handlers = null;
  let nextAck = 1;
  let submitImpl = null;
  const client = {
    async watchSession(seed) {
      const watch = { seed, closed: false };
      watches.push(watch);
      // 与 Rust 行为对齐：流建立后先推 open 状态（bootstrap 由适配层拉取）。
      handlers?.onStatus({ session_id: seed, state: "open", server_epoch: "epoch", cursor: null });
      return watch;
    },
    async deactivateStream(seed) { closedSeeds.push(seed); },
    async submit(target, command, options) {
      const call = [target, command, options ?? { preconditions: [] }];
      submissions.push(call);
      if (submitImpl) return submitImpl(target, command, options);
      return { command_id: `command-${nextAck}`, ack: { status: "accepted", command_id: `command-${nextAck++}` } };
    },
    async commandStatus() { return { state: "succeeded" }; },
    async serviceCall(method, params) { return []; },
    async bootstrap(seed) {
      return { session_id: seed, server_epoch: "epoch", state: { session_id: seed, seq: 1, activity: "idle", current_turn_id: null, turns: [], timeline: [], tools: [], interactions: [], subagents: [] } };
    },
    async approvalsRaw() { return { pending_permission: null, pending_interaction: null }; },
    async downloadContent() { return new Uint8Array(); },
    async uploadContentRaw() { throw new Error("not stubbed"); },
    async stopDaemon() { return "stopping"; },
    async issuePairingToken() { return { pairing_token: "t", expires_in_ms: 60_000, tls_fp: "" }; },
    async listDevices() { return []; },
    async revokeDevice() {},
    close() {},
  };
  const addon = {
    NativeClient: {
      connect(_options, onEvent, onReset, onStatus, onLiveness) {
        handlers = { onEvent, onReset, onStatus, onLiveness };
        return client;
      },
    },
    ringingV2Version: () => 2,
    commandContractRevision: () => "ringing-commands-test",
    serviceMethods: () => serviceMethodsCache,
  };
  return {
    addon, client, submissions, watches, closedSeeds, handlers: () => handlers,
    setSubmitImpl: impl => { submitImpl = impl; },
    emit: {
      status: payload => handlers?.onStatus(payload),
      event: (seed, event) => handlers?.onEvent({ session_id: seed, event }),
      reset: (seed, reason) => handlers?.onReset({ session_id: seed, reset: { session_id: seed, reason } }),
      liveness: () => handlers?.onLiveness(),
    },
  };
}
