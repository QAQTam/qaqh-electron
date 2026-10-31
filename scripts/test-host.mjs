import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as realSdk from "@qaqh/sdk";
import * as sdkNode from "@qaqh/sdk/node";
import * as protocol from "@qaqh/sdk/protocol";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const bundle = build({
  stdin: {
    contents: `export {registerIpcHandlers, reconnectAndRestoreSession} from "./src/main/ipc-handlers.ts";
      export {RingingClient} from "./src/main/ringing-client.ts";
      export {processGroup} from "./src/main/process-metrics.ts";
      export {ChallengeManager, APPROVAL_TTL_MS, MAX_PENDING_APPROVALS} from "./src/main/challenges.ts";
      export {approvalCommand, flattenAdminApprovals} from "./src/main/approvals.ts";`,
    resolveDir: root,
  },
  bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
  external: ["electron", "@qaqh/sdk", "@qaqh/sdk/node", "@qaqh/sdk/protocol"],
}).then(result => result.outputFiles[0].text);

/** Run actual host modules, mocking only Electron and the SDK boundary. No GUI/files/network. */
export async function loadHost({ sdk, timers, windows = [] } = {}) {
  const handlers = new Map();
  const electron = {
    app: { getPath: () => "/unused-interaction-test", quit() {} },
    BrowserWindow: class { static getAllWindows() { return windows; } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  };
  const dependencies = {
    electron,
    "@qaqh/sdk": sdk ? { ...realSdk, createClient: () => sdk } : realSdk,
    "@qaqh/sdk/node": sdkNode,
    "@qaqh/sdk/protocol": protocol,
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", "console", await bundle)(
    name => dependencies[name] ?? require(name), module, module.exports,
    timers?.setTimeout ?? setTimeout, timers?.clearTimeout ?? clearTimeout,
    { ...console, warn() {} },
  );
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

export function mockSdk() {
  const sessionWatches = [], submissions = [];
  const sdk = {
    onStateChange: () => () => {}, connect: async () => {}, disconnect: async () => {},
    submit: async (...args) => { submissions.push(args); return { ack: { status: "accepted", command_id: "command-test" } }; },
    watchSession: (seed, handlers) => {
      const watch = { seed, handlers, closed: false, resyncs: 0, close() { this.closed = true; handlers.onStatus?.("closed"); }, async resync() { this.resyncs++; handlers.onBootstrap?.({ session_id: seed }); handlers.onStatus?.("live"); } };
      sessionWatches.push(watch);
      handlers.onStatus?.("live");
      return watch;
    },
  };
  return { sdk, sessionWatches, submissions };
}
