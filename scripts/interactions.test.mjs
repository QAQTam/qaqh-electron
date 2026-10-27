import { test } from "node:test";
import assert from "node:assert/strict";
import { SdkError } from "@qaqh/sdk";
import { loadHost, mockSdk, FakeTimers } from "./test-host.mjs";

const empty = () => ({ pending_permission: null, pending_interaction: null });
const ask = () => ({ pending_permission: null, pending_interaction: { id: "interaction-ask", kind: "ask", details: { questions: [{ id: "q1", question: "Proceed?", options: ["yes"], allow_custom: false }] } } });
const permission = () => ({ pending_permission: { tool_call_id: "tool-call", tool_name: "exec", action_summary: "run command", reason: "shell", paths: [], category: "exec", level: 2, risk: "high", consequence: "runs command", details_unavailable: false, secret: "do-not-forward" }, pending_interaction: null });
const plan = () => ({ pending_permission: null, pending_interaction: { id: "interaction-plan", kind: "plan", details: { plan_content: "Implement this", review_type: "plan" } } });

async function ipcFixture(pending = ask()) {
  const host = await loadHost();
  let view = { kind: "admin", pending };
  let ack = { status: "accepted", command_id: "accepted-id" };
  const calls = [];
  const client = {
    approvals: async () => { if (view instanceof Error) throw view; return view; },
    command: async (...args) => { calls.push(args); return ack; },
    getActiveSeed: () => "active-B",
    getTimelineStatus: seed => ({ status: "closed", session_id: seed }),
    serviceRpc: async () => [],
  };
  const challenges = new host.ChallengeManager();
  host.registerIpcHandlers(client, {}, challenges);
  return { ...host, challenges, calls, client, setView: value => { view = value; }, setAck: value => { ack = value; } };
}

for (const [kind, pending, decision, payload, expected] of [
  ["ask", ask, "submit", { answers: [{ question_id: "q1", answer: "yes", ignored: true }], interaction_id: "forged" }, { channel: "control", type: "interaction_ask_respond", interaction_id: "interaction-ask", answers: [{ question_id: "q1", answer: "yes" }] }],
  ["ask", ask, "dismiss", {}, { channel: "control", type: "interaction_ask_dismiss", interaction_id: "interaction-ask" }],
  ["tool_permission", permission, "approve", {}, { channel: "tool", type: "tool_permission_respond", tool_call_id: "tool-call", approved: true, trust_folder: false }],
  ["tool_permission", permission, "reject", {}, { channel: "tool", type: "tool_permission_respond", tool_call_id: "tool-call", approved: false, trust_folder: false }],
  ["tool_permission", permission, "trust", { tool_call_id: "forged" }, { channel: "tool", type: "tool_permission_respond", tool_call_id: "tool-call", approved: true, trust_folder: true }],
  ["plan", plan, "approve", { message: "ok", autonomous: true, ignored: true }, { channel: "control", type: "plan_review_respond", interaction_id: "interaction-plan", approved: true, message: "ok", autonomous: true }],
  ["plan", plan, "reject", { message: null, autonomous: false }, { channel: "control", type: "plan_review_respond", interaction_id: "interaction-plan", approved: false, message: null, autonomous: false }],
]) {
  test(`IPC maps ${kind}/${decision} to the canonical command on the explicit session`, async () => {
    const host = await ipcFixture(pending());
    const views = await host.invoke("pending_approvals", { seed: "session-A" });
    assert.equal(views[0].kind, kind);
    assert.match(views[0].challenge_id, /^[0-9a-f]{64}$/);
    const result = await host.invoke("respond_approval", { seed: "session-A", challengeId: views[0].challenge_id, decision, payload });
    assert.equal(result, null);
    assert.deepEqual(host.calls, [[expected.channel, expected, "session-A"]]);
    await assert.rejects(host.invoke("respond_approval", { seed: "session-A", challengeId: views[0].challenge_id, decision, payload }), /expired challenge/);
  });
}

test("pending view only exports permission display fields; independent slots both survive", async () => {
  const pending = permission(); pending.pending_interaction = ask().pending_interaction;
  const host = await ipcFixture(pending);
  const views = await host.invoke("pending_approvals", { seed: "session-A" });
  assert.deepEqual(views.map(v => v.kind), ["tool_permission", "ask"]);
  assert.deepEqual(Object.keys(views[0].details).sort(), ["tool_name", "action_summary", "reason", "paths", "category", "level", "risk", "consequence"].sort());
  assert.ok(!JSON.stringify(views).includes("tool-call"));
  assert.ok(!JSON.stringify(views).includes("interaction-ask"));
});

test("approval read failures and device views reject rather than clearing pending challenges", async () => {
  const host = await ipcFixture();
  const [first] = await host.invoke("pending_approvals", { seed: "session-A" });
  host.setView(new Error("lease_required"));
  await assert.rejects(host.invoke("pending_approvals", { seed: "session-A" }), /lease_required/);
  host.setView({ kind: "device", challenges: { challenges: [] } });
  await assert.rejects(host.invoke("pending_approvals", { seed: "session-A" }), /requires admin/);
  assert.ok(host.challenges.consume("session-A", first.challenge_id));
});

test("unexpected permission interaction is not mistaken for a tool-call id", async () => {
  const pending = ask(); pending.pending_interaction.kind = "permission";
  const host = await ipcFixture(pending);
  await assert.rejects(host.invoke("pending_approvals", { seed: "session-A" }), /invalid_pending_interaction_kind/);
  assert.equal(host.calls.length, 0);
});

test("approval read errors notify the host diagnostics channel and bootstrap failures stay failures", async () => {
  const sent = [];
  const window = { isDestroyed: () => false, webContents: { id: 1, send: (...args) => sent.push(args) } };
  const host = await loadHost({ windows: [window] });
  const client = {
    approvals: async () => { throw new Error("lease expired"); },
    bootstrap: async () => { throw new Error("bootstrap unavailable"); },
  };
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  await assert.rejects(host.invoke("pending_approvals", { seed: "session-A" }), /lease expired/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "qaqh:event:conn://error");
  assert.match(sent[0][1].message, /session-A.*lease expired/);
  await assert.rejects(host.invoke("session_bootstrap", { seed: "session-A" }), /bootstrap unavailable/);
});

test("rejected acknowledgements propagate and a failed response needs a fresh challenge", async () => {
  const host = await ipcFixture();
  const [first] = await host.invoke("pending_approvals", { seed: "session-A" });
  host.setAck({ status: "rejected", code: "already_resolved", message: "not yours" });
  await assert.rejects(host.invoke("respond_approval", { seed: "session-A", challengeId: first.challenge_id, decision: "dismiss" }), /already_resolved.*not yours/);
  const [next] = await host.invoke("pending_approvals", { seed: "session-A" });
  assert.notEqual(next.challenge_id, first.challenge_id);
});

test("IPC rejects malformed decisions, answers, ids and cross-session challenge use", async () => {
  const host = await ipcFixture();
  const [view] = await host.invoke("pending_approvals", { seed: "session-A" });
  await assert.rejects(host.invoke("respond_approval", { seed: "session-B", challengeId: view.challenge_id, decision: "dismiss" }), /expired challenge/);
  await assert.rejects(host.invoke("respond_approval", { seed: "session-A", challengeId: view.challenge_id, decision: "approve" }), /invalid_decision/);
  assert.equal(host.calls.length, 0);
  for (const answers of [null, [], [{ question_id: "q1", answer: 1 }], [{ question_id: "q1", answer: " " }], [{ question_id: "q1", answer: "a" }, { question_id: "q1", answer: "b" }]]) {
    assert.throws(() => host.approvalCommand({ kind: "ask", internalId: "id" }, "submit", { answers }), /invalid_/);
  }
  assert.throws(() => host.approvalCommand({ kind: "plan", internalId: "id" }, "approve", { autonomous: "false" }), /invalid_plan_autonomous/);
  assert.throws(() => host.approvalCommand({ kind: "plan", internalId: "id" }, "reject", { message: {} }), /invalid_plan_message/);
  await assert.rejects(host.invoke("pending_approvals", { seed: "" }), /invalid_session_id/);
  assert.throws(() => host.flattenAdminApprovals({}), /invalid_pending_permission/);
});

test("IPC sender restrictions still reject untrusted origins and subframes", async () => {
  const host = await ipcFixture();
  const frame = { url: "https://untrusted.invalid" };
  await assert.rejects(host.invoke("pending_approvals", { seed: "session-A" }, { sender: { id: 1, mainFrame: frame }, senderFrame: frame }), /not the application renderer/);
  await assert.rejects(host.invoke("pending_approvals", { seed: "session-A" }, { sender: { id: 1, mainFrame: {} }, senderFrame: { url: "app://localhost/index.html" } }), /not the application renderer/);
});

test("decision vocabularies do not cross kinds and renderer fields cannot override grants", async () => {
  const { approvalCommand } = await loadHost();
  const decisions = { ask: ["submit", "dismiss"], tool_permission: ["approve", "reject", "trust"], plan: ["approve", "reject"] };
  for (const [kind, allowed] of Object.entries(decisions)) {
    for (const decision of ["submit", "dismiss", "approve", "reject", "trust", "allow", "deny", "unknown"]) {
      if (!allowed.includes(decision)) assert.throws(() => approvalCommand({ kind, internalId: "canonical" }, decision), /invalid_decision/);
    }
  }
  assert.deepEqual(approvalCommand({ kind: "tool_permission", internalId: "canonical" }, "reject", {
    tool_call_id: "forged", approved: true, trust_folder: true,
  }), { channel: "tool", type: "tool_permission_respond", tool_call_id: "canonical", approved: false, trust_folder: false });
});

test("cancel/compact target the requested session and status reflects both streams", async () => {
  const host = await ipcFixture();
  await host.invoke("cancel_turn", { seed: "session-A", turnId: "turn-A" });
  await host.invoke("compact_context", { seed: "session-A" });
  assert.deepEqual(host.calls, [
    ["conversation", { type: "conversation_cancel", turn_id: "turn-A" }, "session-A"],
    ["conversation", { type: "conversation_compact" }, "session-A"],
  ]);
  assert.equal((await host.invoke("timeline_status", { seed: "active-B" })).status, "closed");
});

test("session list forwards authoritative working and canceled states after cancel", async () => {
  const host = await ipcFixture();
  let status = "working";
  host.client.serviceRpc = async method => {
    assert.equal(method, "session.list");
    return [{ session_id: "session-A", status }];
  };
  await host.invoke("cancel_turn", { seed: "session-A", turnId: "turn-A" });
  let [entry] = await host.invoke("session_list");
  assert.equal(entry.status, "working");
  assert.equal(entry.busy, true);
  status = "canceled";
  [entry] = await host.invoke("session_list");
  assert.equal(entry.status, "canceled");
  assert.equal(entry.busy, false);
});

test("session rename is allowed and preserves the explicit target", async () => {
  const host = await ipcFixture();
  const calls = [];
  host.client.getActiveSeed = () => null;
  host.client.serviceRpc = async (...args) => { calls.push(args); return null; };
  await host.invoke("service_rpc", { method: "session.rename", params: { session_id: "session-A", title: "New title" } });
  assert.deepEqual(calls, [["session.rename", { session_id: "session-A", title: "New title" }]]);
  await assert.rejects(host.invoke("service_rpc", { method: "unlisted.method" }), /not allowed/);
});

test("filesystem services follow backend session-optional contract", async () => {
  const host = await ipcFixture();
  const calls = [];
  host.client.serviceRpc = async (...args) => { calls.push(args); return []; };
  host.client.getActiveSeed = () => null;
  await host.invoke("service_rpc", { method: "fs.list", params: { path: "/registered", scope_session_id: null } });
  host.client.getActiveSeed = () => "session-A";
  await host.invoke("service_rpc", { method: "fs.read", params: { path: "/registered/file" } });
  await host.invoke("service_rpc", { method: "fs.read", params: { path: "/registered/file", scope_session_id: "session-B" } });
  await host.invoke("service_rpc", { method: "fs.list", params: { path: "/registered", scope_session_id: null } });
  assert.deepEqual(calls, [
    ["fs.list", { path: "/registered", scope_session_id: null }],
    ["fs.read", { path: "/registered/file", scope_session_id: "session-A" }],
    ["fs.read", { path: "/registered/file", scope_session_id: "session-B" }],
    ["fs.list", { path: "/registered", scope_session_id: null }],
  ]);
});

test("legacy read-only service methods remain available and session scoped", async () => {
  const host = await ipcFixture();
  const calls = [];
  host.client.serviceRpc = async (...args) => { calls.push(args); return null; };
  for (const method of ["session.dashboard", "session.get_activity", "workspace.get", "todo.status", "plan.read", "git.diff", "git.branch", "git.branches", "git.file_diff"]) {
    await host.invoke("service_rpc", { method, params: { session_id: "session-A" } });
    assert.deepEqual(calls.at(-1), [method, { session_id: "session-A" }]);
  }
  await assert.rejects(host.invoke("service_rpc", { method: "git.commit" }), /not allowed/);
});

test("reconnect restores the previously saved session after reconnect clears it", async () => {
  const host = await loadHost();
  let activeSeed = "session-A";
  const attached = [];
  const client = {
    reconnectWithCredentials: async () => { activeSeed = null; },
    attach: async seed => { attached.push(seed); activeSeed = seed; },
  };
  const saved = activeSeed;
  await host.reconnectAndRestoreSession(client, {}, saved);
  assert.deepEqual(attached, ["session-A"]);
  assert.equal(activeSeed, "session-A");
});

test("IPC resolves a client lazily and retries after connection failure", async () => {
  const host = await loadHost();
  let attempts = 0;
  host.registerIpcHandlers(async () => {
    attempts++;
    if (attempts === 1) throw new Error("daemon unavailable");
    return { serviceRpc: async () => [] };
  }, {}, new host.ChallengeManager());
  await assert.rejects(host.invoke("session_list"), /daemon unavailable/);
  assert.deepEqual(await host.invoke("session_list"), []);
  assert.equal(attempts, 2);
});

test("Electron process metrics exclude the main process and convert KiB to bytes", async () => {
  const { processGroup } = await loadHost();
  const group = processGroup([
    { pid: 1, type: "Browser", memory: { workingSetSize: 100 } },
    { pid: 2, type: "Tab", memory: { workingSetSize: 50, privateBytes: 12 } },
    { pid: 3, type: "GPU", memory: {} },
  ], 1);
  assert.deepEqual(group.members, [
    { pid: 2, kind: "renderer", resident_bytes: 51200, private_bytes: 12288, error: null },
    { pid: 3, kind: "gpu", resident_bytes: null, private_bytes: null, error: "memory unavailable" },
  ]);
});

test("ChallengeManager reuses unchanged cards, expires exactly at TTL and consumes once", async () => {
  const { ChallengeManager, APPROVAL_TTL_MS, flattenAdminApprovals } = await loadHost();
  let now = 1000;
  const store = new ChallengeManager(() => now);
  const items = flattenAdminApprovals(ask());
  const [first] = store.issueViews("session-A", items);
  const [same] = store.issueViews("session-A", structuredClone(items));
  assert.deepEqual(same, first);
  now += 1000;
  const [later] = store.issueViews("session-A", items);
  assert.equal(later.challenge_id, first.challenge_id);
  assert.equal(later.expires_in, first.expires_in - 1);
  assert.equal(store.consume("session-B", first.challenge_id), null);
  now = 1000 + APPROVAL_TTL_MS;
  assert.equal(store.consume("session-A", first.challenge_id), null);
  const [renewed] = store.issueViews("session-A", items);
  assert.notEqual(renewed.challenge_id, first.challenge_id);
  assert.ok(store.consume("session-A", renewed.challenge_id));
  assert.equal(store.consume("session-A", renewed.challenge_id), null);
});

test("ChallengeManager revokes changed/removed cards without touching another session", async () => {
  const { ChallengeManager, flattenAdminApprovals } = await loadHost();
  const store = new ChallengeManager();
  const items = flattenAdminApprovals(ask());
  const [a] = store.issueViews("session-A", items);
  const [b] = store.issueViews("session-B", items);
  const changed = structuredClone(items); changed[0].details.questions[0].question = "Changed?";
  const [replacement] = store.issueViews("session-A", changed);
  assert.notEqual(replacement.challenge_id, a.challenge_id);
  assert.equal(store.consume("session-A", a.challenge_id), null);
  store.issueViews("session-A", []);
  assert.equal(store.consume("session-A", replacement.challenge_id), null);
  assert.ok(store.consume("session-B", b.challenge_id));
});

test("ChallengeManager detaches returned details and bounds global storage atomically", async () => {
  const { ChallengeManager, MAX_PENDING_APPROVALS, flattenAdminApprovals } = await loadHost();
  const store = new ChallengeManager();
  const items = flattenAdminApprovals(ask());
  const [view] = store.issueViews("session-A", items);
  view.details.questions[0].question = "forged";
  assert.equal(store.issueViews("session-A", items)[0].details.questions[0].question, "Proceed?");
  for (let i = 1; i < MAX_PENDING_APPROVALS; i++) store.issueViews(`session-${i}`, items);
  assert.throws(() => store.issueViews("overflow", items), /approval_limit/);
  assert.ok(store.consume("session-A", view.challenge_id));
  store.clear();
  assert.equal(store.issueViews("overflow", items).length, 1);
});

async function streamFixture() {
  const mock = mockSdk();
  const timers = new FakeTimers();
  const { RingingClient } = await loadHost({ sdk: mock.sdk, timers });
  const events = [];
  const client = new RingingClient({}, (name, payload) => events.push({ name, payload }));
  return { ...mock, timers, events, client };
}

test("projection resets resync after pause and bootstrap refreshes pending interactions", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  const watch = f.sessionWatches[0];
  assert.equal(f.client.getTimelineStatus("session-A").status, "open");
  watch.handlers.onReset({ reason: "cursor_expired", session_id: "session-A" });
  watch.handlers.onStatus("paused");
  assert.equal(watch.resyncs, 0);
  assert.equal(f.client.getTimelineStatus("session-A").status, "closed");
  assert.equal(await f.timers.next(), 250);
  assert.equal(watch.resyncs, 1);
  assert.equal(f.client.getTimelineStatus("session-A").status, "open");
  assert.ok(f.events.some(e => e.name === "projection://reset" && e.payload.reason === "bootstrap"));
});

test("scheduled SSE reconnects are forwarded with attempt and delay", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  f.sessionWatches[0].handlers.onReconnectScheduled({ attempt: 2, delayMs: 1500 });
  f.timelineWatches[0].handlers.onReconnectScheduled({ attempt: 3, delayMs: 3000 });
  const reconnects = f.events.filter(e => e.name === "conn://reconnect");
  assert.equal(reconnects.length, 2);
  assert.equal(reconnects[0].payload.session_id, "session-A");
  assert.equal(reconnects[0].payload.attempt, 2);
  assert.equal(reconnects[0].payload.delay_ms, 1500);
  assert.equal(reconnects[1].payload.attempt, 3);
  assert.equal(reconnects[1].payload.delay_ms, 3000);
  assert.ok(reconnects.every(e => typeof e.payload.at === "number" && e.payload.at > 0));
  assert.equal(f.client.getTimelineStatus("session-A").status, "open");
});

test("provider retry timeline entries are forwarded unchanged", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  const entry = {
    timeline_seq: 7,
    turn_id: "turn-A",
    round_num: 0,
    event: {
      type: "provider_retrying",
      attempt: 2,
      max_retries: 5,
      delay_secs: 4,
      error: "429 Too Many Requests",
    },
  };
  f.timelineWatches[0].handlers.onEntry({ session_id: "session-A", entry });
  const forwarded = f.events.find(e => e.name === "timeline://entry");
  assert.equal(forwarded.payload.session_id, "session-A");
  assert.deepEqual(forwarded.payload.entry, entry);
});

test("resync is bounded and unrecoverable resets/termination stay paused", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  const watch = f.sessionWatches[0];
  for (const delay of [250, 500, 1000]) {
    watch.handlers.onReset({ reason: "replay_overflow", session_id: "session-A" });
    watch.handlers.onStatus("paused");
    assert.equal(await f.timers.next(), delay);
  }
  watch.handlers.onReset({ reason: "replay_overflow", session_id: "session-A" });
  assert.equal(f.timers.jobs.size, 0);
  assert.ok(f.events.some(e => e.name === "conn://error" && /exhausted/.test(e.payload.message)));
  watch.handlers.onEvent({ session_id: "session-A" });
  watch.handlers.onReset({ reason: "upgrade_required", session_id: "session-A" });
  watch.handlers.onStatus("paused");
  assert.equal(f.timers.jobs.size, 0);
  assert.equal(f.client.getTimelineStatus("session-A").status, "closed");
  watch.handlers.onTerminated({ code: "forbidden", message: "lease lost" });
  assert.equal(f.timers.jobs.size, 0);
});

test("failed resync reports errors, retries and detaching cancels pending recovery", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  const watch = f.sessionWatches[0];
  watch.resync = async () => { throw new Error("bootstrap failed"); };
  watch.handlers.onReset({ reason: "epoch_mismatch", session_id: "session-A" });
  await f.timers.next();
  assert.equal(f.client.getTimelineStatus("session-A").status, "closed");
  assert.equal(f.timers.jobs.size, 1);
  assert.ok(f.events.some(e => e.name === "conn://error" && /bootstrap failed/.test(e.payload.message)));
  await f.client.attach("session-B");
  assert.equal(f.timers.jobs.size, 0);
  const count = f.events.length;
  watch.handlers.onEvent({ session_id: "session-A" });
  watch.handlers.onReset({ reason: "cursor_expired", session_id: "session-A" });
  assert.equal(f.events.length, count);
});

test("overlapping attaches cannot publish stale snapshots or replace the current watches", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  let resolveA;
  f.sdk.timelinePage = seed => seed === "session-A" ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve({ session_id: seed });
  const attachA = f.client.attach("session-A");
  while (!resolveA) await Promise.resolve();
  await f.client.attach("session-B");
  resolveA({ session_id: "session-A" });
  await attachA;
  assert.deepEqual(f.sessionWatches.map(w => w.seed), ["session-B"]);
  assert.ok(!f.events.some(e => e.name === "timeline://snapshot" && e.payload.session_id === "session-A"));
});

test("command supports tool, explicit null target and exposes failed timeout outcomes", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-B");
  await f.client.command("tool", { type: "tool_permission_respond", tool_call_id: "tool-A", approved: true, trust_folder: false }, "session-A");
  assert.deepEqual(f.submissions.at(-1), ["tool", { channel: "tool", type: "tool_permission_respond", tool_call_id: "tool-A", approved: true, trust_folder: false }, "session-A"]);
  await f.client.command("control", { type: "session_create", close_current: false }, null);
  assert.equal(f.submissions.at(-1)[2], null);
  f.sdk.submit = async () => { throw new SdkError("outcome_unknown", "timeout", undefined, undefined, "command-unknown"); };
  f.sdk.resolveOutcome = async () => ({ state: "failed", command_id: "command-unknown", error_code: "invalid_answer" });
  const ack = await f.client.command("control", { type: "interaction_ask_dismiss", interaction_id: "ask-A" }, "session-A");
  assert.equal(ack.status, "rejected"); assert.equal(ack.code, "invalid_answer");
  f.sdk.resolveOutcome = async () => { throw new Error("still unknown"); };
  await assert.rejects(f.client.command("control", { type: "interaction_ask_dismiss", interaction_id: "ask-A" }, "session-A"), e => e.kind === "outcome_unknown" && e.commandId === "command-unknown");
});
