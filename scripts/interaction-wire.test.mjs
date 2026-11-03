import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@qaqh/sdk";
import { loadHost } from "./test-host.mjs";

const scenarios = [
  { kind: "ask", decision: "submit", payload: { answers: [{ question_id: "q1", answer: "yes" }] }, type: "interaction.ask.respond", answers: { q1: "yes" } },
  { kind: "ask", decision: "dismiss", type: "interaction.ask.dismiss" },
  { kind: "tool_permission", decision: "approve", type: "tool.permission.respond", approved: true, trust_folder: false },
  { kind: "tool_permission", decision: "reject", type: "tool.permission.respond", approved: false, trust_folder: false },
  { kind: "tool_permission", decision: "trust", type: "tool.permission.respond", approved: true, trust_folder: true },
  { kind: "plan", decision: "approve", payload: { message: "approved" }, type: "plan.review.respond", approved: true, message: "approved" },
  { kind: "plan", decision: "reject", payload: { message: "revise" }, type: "plan.review.respond", approved: false, message: "revise" },
];

for (const scenario of scenarios) {
  test(`IPC -> real SDK -> HTTP envelope: ${scenario.kind}/${scenario.decision}`, async t => {
    const requests = [];
    const canonicalId = scenario.kind === "tool_permission" ? "call-canonical" : "interaction-canonical";
    const pending = {
      pending_permission: scenario.kind === "tool_permission" ? { tool_call_id: canonicalId, tool_name: "exec", paths: [] } : null,
      pending_interaction: scenario.kind !== "tool_permission" ? { id: canonicalId, kind: scenario.kind, details: {} } : null,
    };
    const sdk = createClient({
      credentials: { endpoint: "http://mock.invalid", token: "synthetic-host-token" },
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ path, body, headers: new Headers(init.headers), method: init.method });
        let response;
        if (path === "/ringing/v2/clients/open") {
          response = { schema: "qaqh.Ringing", version: 2, accepted: true, client_session_id: "lease-test", server_epoch: "epoch-test", renew_interval_ms: 3600_000, capabilities: { single_stream: true }, command_contract_revision: "ringing-commands-6" };
        } else if (path === "/ringing/v2/sessions/session-A/approvals") {
          response = pending;
        } else if (path === "/ringing/v2/sessions/session-A/bootstrap") {
          response = { schema: "qaqh.Ringing", version: 2, session_id: "session-A", server_epoch: "epoch-test", state: { session_id: "session-A", seq: 1, activity: "idle", current_turn_id: null, turns: [], timeline: [], tools: [], interactions: [{ interaction_id: canonicalId === "call-canonical" ? "permission-interaction" : canonicalId, call_id: canonicalId === "call-canonical" ? canonicalId : null, kind: scenario.kind === "tool_permission" ? "permission" : scenario.kind, request: "", resolution: null }], subagents: [] } };
        } else if (path === "/ringing/v2/commands") {
          response = { status: "accepted", command_id: body.command_id, result: null };
        } else throw new Error(`Unexpected request: ${path}`);
        return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    t.after(() => sdk.disconnect());
    const host = await loadHost({ sdk });
    const client = new host.RingingClient({}, () => {});
    host.registerIpcHandlers(client, {}, new host.ChallengeManager());
    const [view] = await host.invoke("pending_approvals", { seed: "session-A" });
    assert.ok(!JSON.stringify(view).includes(canonicalId));
    await host.invoke("respond_approval", { seed: "session-A", challengeId: view.challenge_id, decision: scenario.decision, payload: scenario.payload });
    const request = requests.at(-1);
    const envelope = request.body;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/ringing/v2/commands");
    assert.equal(request.headers.get("Authorization"), "Bearer synthetic-host-token");
    assert.equal(request.headers.get("X-QAQH-Client-Session-Id"), "lease-test");
    assert.equal(envelope.schema, "qaqh.Ringing");
    assert.equal(envelope.version, 2);
    assert.equal(envelope.contract_revision, "ringing-commands-6");
    assert.deepEqual(envelope.target, { kind: "session", session_id: "session-A" });
    assert.equal(envelope.command.type, scenario.type);
    if (scenario.kind === "tool_permission") {
      assert.equal(envelope.command.tool_call_id, canonicalId);
      assert.equal(envelope.command.approved, scenario.approved);
      assert.equal(envelope.command.trust_folder, scenario.trust_folder);
    } else {
      assert.equal(envelope.command.interaction_id, canonicalId);
      if (scenario.kind === "plan") {
        assert.equal(envelope.command.approved, scenario.approved);
        assert.equal(envelope.command.message, scenario.message);
        assert.equal(envelope.command.autonomous, false);
      } else if (scenario.decision === "submit") assert.deepEqual(envelope.command.answers, [{ question_id: "q1", answer: "yes" }]);
    }
  });
}

test("real SDK reset re-bootstraps and resumes projection delivery", async t => {
  const { FakeTimers } = await import("./test-host.mjs");
  const timers = new FakeTimers();
  let bootstraps = 0, streams = 0;
  const encoder = new TextEncoder();
  const sse = (text, holdOpen = false) => new Response(new ReadableStream({ start(controller) { if (text) controller.enqueue(encoder.encode(text)); if (!holdOpen) controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const sdk = createClient({
    credentials: { endpoint: "http://mock.invalid", token: "synthetic" },
    reconnect: { initialMs: 1, maxMs: 1 },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/clients/open")) return json({ schema: "qaqh.Ringing", version: 2, accepted: true, client_session_id: "lease", server_epoch: "epoch", renew_interval_ms: 3600_000, capabilities: { single_stream: true }, command_contract_revision: "ringing-commands-6" });
      if (path.endsWith("/commands")) return json({ status: "accepted", command_id: JSON.parse(init.body).command_id, result: null });
      if (path.endsWith("/bootstrap")) {
        bootstraps++;
        return json({ schema: "qaqh.Ringing", version: 2, session_id: "session-A", server_epoch: "epoch", state: { session_id: "session-A", seq: bootstraps, activity: "idle", current_turn_id: null, turns: [], timeline: [], tools: [], interactions: [], subagents: [] } });
      }
      if (path.endsWith("/events")) {
        streams++;
        if (streams === 1) return sse('event: ringing.resync_required\ndata: {"session_id":"session-A","reason":"cursor_gap"}\n\n');
        assert.equal(new URL(url).searchParams.get("since_cursor"), "epoch:2");
        return sse('id: epoch:3\nevent: ringing.event\ndata: {"seq":3,"type":"activity_changed","activity":"idle","current_turn_id":null}\n\n');
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  const host = await loadHost({ sdk, timers });
  const events = [];
  const client = new host.RingingClient({}, (name, payload) => events.push({ name, payload }));
  t.after(() => client.destroy());
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`stream condition was not reached (${JSON.stringify({ bootstraps, streams, events })})`);
  };
  await client.attach("session-A");
  // SDK owns its native recovery timer (the host's fake timer adapter must not
  // create a competing recovery schedule).
  await until(() => events.some(e => e.name === "projection://event"));
  assert.equal(bootstraps, 2);
  assert.ok(streams >= 2);
  assert.ok(["live", "reconnecting"].includes(client.getProjectionStatus("session-A")));
});
