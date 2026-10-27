import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@qaqh/sdk";
import { loadHost } from "./test-host.mjs";

test("config allowlist passes through Electron and SDK without session injection or field loss", async t => {
  const requests = [];
  const sdk = createClient({
    credentials: { endpoint: "http://mock.invalid", token: "synthetic" },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      const value = path.endsWith("/clients/open")
        ? { schema: "qaqh.Ringing", version: 2, accepted: true, client_session_id: "lease", server_epoch: "epoch", renew_interval_ms: 3600000 }
        : path.endsWith("/service/config.load") ? { toolAllowlistEnabled: false, toolAllowlist: ["read"] } : null;
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  t.after(() => sdk.disconnect());
  const host = await loadHost({ sdk });
  const client = new host.RingingClient({}, () => {});
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  assert.deepEqual(await host.invoke("service_rpc", { method: "config.load", params: {} }), { toolAllowlistEnabled: false, toolAllowlist: ["read"] });
  const patch = { toolAllowlistEnabled: true, toolAllowlist: ["read", "glob", "grep"] };
  await host.invoke("service_rpc", { method: "config.save", params: patch });
  assert.deepEqual(requests.at(-1), { path: "/ringing/v2/service/config.save", body: patch });
});
