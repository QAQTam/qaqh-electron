import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@qaqh/sdk";
import { loadHost } from "./test-host.mjs";

const scenarios = [
  { kind: "ask", decision: "submit", payload: { answers: [{ question_id: "q1", answer: "yes" }] }, type: "interaction.ask.respond", answers: { q1: "yes" } },
  { kind: "ask", decision: "dismiss", type: "interaction.ask.dismiss" },
  { kind: "tool_permission", decision: "approve", type: "interaction.permission.respond", approved: true, trust_folder: false },
  { kind: "tool_permission", decision: "reject", type: "interaction.permission.respond", approved: false, trust_folder: false },
  { kind: "tool_permission", decision: "trust", type: "interaction.permission.respond", approved: true, trust_folder: true },
  { kind: "plan", decision: "approve", payload: { message: "approved" }, type: "interaction.plan.respond", approved: true, feedback: "approved" },
  { kind: "plan", decision: "reject", payload: { message: "revise" }, type: "interaction.plan.respond", approved: false, feedback: "revise" },
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
          response = { schema: "qaqh.Ringing", version: 2, accepted: true, client_session_id: "lease-test", server_epoch: "epoch-test", renew_interval_ms: 3600_000 };
        } else if (path === "/ringing/v2/sessions/session-A/approvals") {
          response = pending;
        } else if (path === "/ringing/v2/sessions/session-A/bootstrap") {
          response = { schema: "qaqh.Ringing", version: 2, session_id: "session-A", server_epoch: "epoch-test", snapshot_cursor: "cursor-1", control: { state: { revision: 1, interactions: [] } } };
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
        assert.equal(envelope.command.feedback, scenario.feedback);
      } else if (scenario.decision === "submit") assert.deepEqual(envelope.command.answers, scenario.answers);
    }
  });
}

test("real SDK reset pauses, then host resync re-bootstraps and resumes projection delivery", async t => {
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
      if (path.endsWith("/clients/open")) return json({ schema: "qaqh.Ringing", version: 2, accepted: true, client_session_id: "lease", server_epoch: "epoch", renew_interval_ms: 3600_000 });
      if (path.endsWith("/commands")) return json({ status: "accepted", command_id: JSON.parse(init.body).command_id, result: null });
      if (path.endsWith("/bootstrap")) {
        bootstraps++;
        return json({ schema: "qaqh.Ringing", version: 2, session_id: "session-A", server_epoch: "epoch", snapshot_cursor: `cursor-${bootstraps}` });
      }
      if (path.endsWith("/events")) {
        streams++;
        if (streams === 1) return sse('event: ringing.reset_required\ndata: {"session_id":"session-A","reason":"cursor_expired"}\n\n');
        assert.equal(new URL(url).searchParams.get("since_cursor"), "cursor-2");
    return sse('event: ringing.event\ndata: {"schema":"qaqh.Ringing","version":2,"session_id":"session-A","server_epoch":"epoch","cursor":"cursor-3","payload":{}}\n\n');
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  const host = await loadHost({ sdk, timers });
  const events = [];
  const client = new host.RingingClient({}, (name, payload) => events.push({ name, payload }));
  t.after(() => client.destroy());
  const until = async predicate => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await Promise.resolve(); }
    assert.fail("stream condition was not reached");
  };
  await client.attach("session-A");
  // SDK owns its native recovery timer (the host's fake timer adapter must not
  // create a competing recovery schedule).
  await new Promise(resolve => setTimeout(resolve, 400));
  await until(() => events.some(e => e.name === "projection://event"));
  assert.equal(bootstraps, 2);
  assert.ok(streams >= 2);
  assert.ok(["live", "reconnecting"].includes(client.getProjectionStatus("session-A")));
});
