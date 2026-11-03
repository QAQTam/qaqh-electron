import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@qaqh/sdk";
import { loadHost } from "./test-host.mjs";

test("config.save crosses Electron and SDK as a global Ringing command", async t => {
  const requests = [];
  const sdk = createClient({
    credentials: { endpoint: "http://mock.invalid", token: "synthetic" },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      const value = path.endsWith("/clients/open")
        ? { schema: "qaqh.Ringing", version: 2, accepted: true, client_session_id: "lease", server_epoch: "epoch", renew_interval_ms: 3600000, capabilities: { single_stream: true }, command_contract_revision: "ringing-commands-6" }
        : path.endsWith("/commands") ? { status: "accepted", command_id: body.command_id } : null;
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  t.after(() => sdk.disconnect());
  const host = await loadHost({ sdk });
  const client = new host.RingingClient({}, () => {});
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  const patch = { toolAllowlistEnabled: true, toolAllowlist: ["read", "glob", "grep"] };
  await host.invoke("command", { command: { type: "config.save", patch } });
  const body = requests.at(-1).body;
  assert.equal(requests.at(-1).path, "/ringing/v2/commands");
  assert.equal(body.schema, "qaqh.Ringing");
  assert.equal(body.version, 2);
  assert.deepEqual(body.target, { kind: "global" });
  assert.deepEqual(body.command, { type: "config.save", patch });
  assert.deepEqual(body.preconditions, []);
});
