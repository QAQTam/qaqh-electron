import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost, mockNativeAddon, FakeTimers } from "./test-host.mjs";

const empty = () => ({ pending_permission: null, pending_interaction: null });
const ask = () => ({ pending_permission: null, pending_interaction: { id: "interaction-ask", kind: "ask", details: { questions: [{ id: "q1", question: "Proceed?", options: ["yes"], allow_custom: false }] } } });
const permission = (detailsUnavailable = false) => ({ pending_permission: { tool_call_id: "tool-call", tool_name: "exec", action_summary: "run command", reason: "shell", paths: [], category: "exec", level: 2, risk: "high", consequence: "runs command", details_unavailable: detailsUnavailable, secret: "do-not-forward" }, pending_interaction: null });
// plan 审批已随 `plan.review.respond` 退役（ringing-commands-7）；
// InteractionKind 只剩 ask|permission，plan 仅存于 device challenge 词表。

async function ipcFixture(pending = ask()) {
  const host = await loadHost();
  let view = { kind: "admin", pending };
  let ack = { status: "accepted", command_id: "accepted-id" };
  let queryResult = [];
  const calls = [];
  const queries = [];
  const client = {
    approvals: async () => { if (view instanceof Error) throw view; return view; },
    approvalsSnapshot: async () => ({ state: { session_id: "session-A", seq: 1, activity: "idle", current_turn_id: null, turns: [], timeline: [], tools: [], subagents: [], interactions: [
      ...(view?.pending?.pending_permission ? [{ kind: "permission", call_id: view.pending.pending_permission.tool_call_id, interaction_id: "permission-interaction", resolution: null }] : []),
      ...(view?.pending?.pending_interaction ? [{ kind: view.pending.pending_interaction.kind, interaction_id: view.pending.pending_interaction.id, resolution: null }] : []),
    ] } }),
    command: async (...args) => { calls.push(args); return ack; },
    serviceCall: async (...args) => { queries.push(args); return queryResult; },
    getActiveSeed: () => "active-B",
    getProjectionStatus: seed => "closed",
  };
  const challenges = new host.ChallengeManager();
  host.registerIpcHandlers(client, {}, challenges);
  return {
    ...host, challenges, calls, queries, client,
    setView: value => { view = value; },
    setAck: value => { ack = value; },
    setQueryResult: value => { queryResult = value; },
  };
}

for (const [kind, pending, decision, payload, expected] of [
  ["ask", ask, "submit", { answers: [{ question_id: "q1", answer: "yes", ignored: true }], interaction_id: "forged" }, { type: "interaction.ask.respond", interaction_id: "interaction-ask", answers: [{ question_id: "q1", answer: "yes" }] }],
  ["ask", ask, "dismiss", {}, { type: "interaction.ask.dismiss", interaction_id: "interaction-ask" }],
  ["tool_permission", permission, "approve", {}, { type: "tool.permission.respond", tool_call_id: "tool-call", approved: true, trust_folder: false }],
  ["tool_permission", permission, "reject", {}, { type: "tool.permission.respond", tool_call_id: "tool-call", approved: false, trust_folder: false }],
  ["tool_permission", permission, "trust", { tool_call_id: "forged" }, { type: "tool.permission.respond", tool_call_id: "tool-call", approved: true, trust_folder: true }],
]) {
  test(`IPC maps ${kind}/${decision} to the canonical command on the explicit session`, async () => {
    const host = await ipcFixture(pending());
    const views = await host.invoke("pending_approvals", { seed: "session-A" });
    assert.equal(views[0].kind, kind);
    assert.match(views[0].challenge_id, /^[0-9a-f]{64}$/);
    if (kind === "tool_permission") host.challenges.confirmChallenge("session-A", views[0].challenge_id);
    const result = await host.invoke("respond_approval",  { seed: "session-A", challengeId: views[0].challenge_id, decision, payload });
    assert.equal(result, null);
    assert.deepEqual(host.calls, [[expected, { kind: "session", session_id: "session-A" }]]);
    await assert.rejects(host.invoke("respond_approval", { seed: "session-A", challengeId: views[0].challenge_id, decision, payload }), /expired challenge/);
  });
}

test("pending view only exports permission display fields; independent slots both survive", async () => {
  const pending = permission(); pending.pending_interaction = ask().pending_interaction;
  const host = await ipcFixture(pending);
  const views = await host.invoke("pending_approvals", { seed: "session-A" });
  assert.deepEqual(views.map(v => v.kind), ["tool_permission", "ask"]);
  assert.deepEqual(Object.keys(views[0].details).sort(), ["tool_name", "action_summary", "reason", "paths", "category", "level", "risk", "consequence", "details_unavailable"].sort());
  assert.ok(!JSON.stringify(views).includes("tool-call"));
  assert.ok(!JSON.stringify(views).includes("interaction-ask"));
});

test("unavailable request details survive host mapping and cannot be approved or trusted", async () => {
  const host = await ipcFixture(permission(true));
  const [view] = await host.invoke("pending_approvals", { seed: "session-A" });
  assert.equal(view.details_unavailable, true);
  assert.equal(view.details.details_unavailable, true);
  host.challenges.markChallengeUnverified("session-A", view.challenge_id);
  await assert.rejects(host.invoke("respond_approval", { seed: "session-A", challengeId: view.challenge_id, decision: "approve" }), /approval_details_unavailable/);
  const [next] = await host.invoke("pending_approvals", { seed: "session-A" });
  host.challenges.confirmChallenge("session-A", next.challenge_id);
  await assert.rejects(host.invoke("respond_approval", { seed: "session-A", challengeId: next.challenge_id, decision: "trust" }), /approval_details_unavailable/);
  assert.equal(host.calls.length, 0);
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

test("a card invalidated by an interaction event cannot approve until a confirming snapshot", async () => {
  const host = await ipcFixture(ask());
  const [card] = await host.invoke("pending_approvals", { seed: "session-A" });
  host.challenges.markChallengeUnverified("session-A", card.challenge_id);
  await assert.rejects(
    host.invoke("respond_approval", { seed: "session-A", challengeId: card.challenge_id, decision: "submit", payload: { answers: [{ question_id: "q1", answer: "yes" }] } }),
    /approval_state_unverified/,
  );
  const [fresh] = await host.invoke("pending_approvals", { seed: "session-A" });
  assert.notEqual(fresh.challenge_id, card.challenge_id);
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
    approvalsSnapshot: async () => { throw new Error("bootstrap unavailable"); },
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
  assert.throws(() => host.approvalCommand({ kind: "plan", internalId: "id" }, "reject", { message: {} }), /invalid_approval_kind/);
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
  const decisions = { ask: ["submit", "dismiss"], tool_permission: ["approve", "reject", "trust"] };
  for (const [kind, allowed] of Object.entries(decisions)) {
    for (const decision of ["submit", "dismiss", "approve", "reject", "trust", "allow", "deny", "unknown"]) {
      if (!allowed.includes(decision)) assert.throws(() => approvalCommand({ kind, internalId: "canonical" }, decision), /invalid_decision/);
    }
  }
  assert.deepEqual(approvalCommand({ kind: "tool_permission", internalId: "canonical" }, "reject", {
    tool_call_id: "forged", approved: true, trust_folder: true,
  }), { type: "tool.permission.respond", tool_call_id: "canonical", approved: false, trust_folder: false });
});

test("generic commands preserve an explicit session target", async () => {
  const host = await ipcFixture();
  const target = { kind: "session", session_id: "session-A" };
  await host.invoke("command", { command: { type: "session.resume" }, target });
  assert.deepEqual(host.calls, [
    [{ type: "session.resume" }, target, []],
  ]);
});

test("renderer send_message cannot provide trusted runtime identity fields", async () => {
  const host = await ipcFixture();
  const reference = `sha256:${"a".repeat(64)}`;
  const target = { kind: "session", session_id: "session-A" };
  await host.invoke("command", {
    command: {
      type: "conversation.send_message",
      text: "hello",
      input_purpose: "trigger_turn",
      attachments: [reference],
      message_id: "renderer-message",
      as_system: true,
      inter_agent: { sender: "forged" },
      subagent_terminal: { terminal: "forged" },
    },
    target,
  });
  assert.deepEqual(host.calls, [[{
    type: "conversation.send_message",
    text: "hello",
    input_purpose: "trigger_turn",
    attachments: [reference],
    message_id: "renderer-message",
    as_system: false,
  }, target, []]]);
  await assert.rejects(host.invoke("command", {
    command: { type: "conversation.send_message", text: "bad", input_purpose: "trigger_turn", attachments: ["/tmp/local-file"] },
    target,
  }), /invalid_attachment_ref/);
});

test("session list forwards authoritative working and canceled states after cancel", async () => {
  const host = await ipcFixture();
  let status = "working";
  host.setQueryResult([{ session_id: "session-A", status }]);
  await host.invoke("command", { command: { type: "conversation.cancel" }, target: { kind: "session", session_id: "session-A" } });
  let [entry] = await host.invoke("session_list");
  assert.equal(entry.status, "working");
  assert.equal(entry.busy, true);
  status = "canceled";
  host.setQueryResult([{ session_id: "session-A", status }]);
  [entry] = await host.invoke("session_list");
  assert.equal(entry.status, "canceled");
  assert.equal(entry.busy, false);
  assert.deepEqual(host.queries, [["session.list", {}], ["session.list", {}]]);
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
    return { serviceCall: async () => [] };
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
  const mock = mockNativeAddon();
  const timers = new FakeTimers();
  const host = await loadHost({ native: mock.addon, timers });
  const events = [];
  const client = new host.RingingClient({}, (name, payload) => events.push({ name, payload }));
  return { ...mock, native: mock.client, host, timers, events, client };
}

test("open status refreshes pending interactions without a host recovery timer", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  assert.equal(f.client.getProjectionStatus("session-A"), "live");
  assert.equal(f.timers.jobs.size, 0, "host does not start a recovery timer");
  f.emit.reset("session-A", "cursor_expired");
  assert.equal(f.timers.jobs.size, 0, "resync ownership stays in the Rust stream loop");
  assert.ok(f.events.some(e => e.name === "projection://reset" && e.payload.reason === "cursor_expired"));
});

test("scheduled SSE reconnects are forwarded with attempt and delay", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  f.emit.status({ session_id: "session-A", state: "reconnecting", retry_ms: 1500, reason: null, last_cursor: null });
  f.emit.status({ session_id: "session-A", state: "reconnecting", retry_ms: 3000, reason: null, last_cursor: null });
  const reconnects = f.events.filter(e => e.name === "conn://reconnect");
  assert.equal(reconnects.length, 2);
  assert.deepEqual(reconnects.map(e => e.payload.attempt), [1, 2]);
  assert.equal(reconnects[1].payload.session_id, "session-A");
  assert.equal(reconnects[1].payload.delay_ms, 3000);
  assert.ok(f.events.every(e => e.name !== "conn://reconnect" || (typeof e.payload.at === "number" && e.payload.at > 0)));
  assert.equal(f.client.getProjectionStatus("session-A"), "reconnecting");
});

test("the Rust stream loop owns repeated reset recovery; adapter only mirrors status", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  f.emit.reset("session-A", "replay_overflow");
  assert.equal(f.timers.jobs.size, 0);
  f.emit.reset("session-A", "upgrade_required");
  assert.equal(f.timers.jobs.size, 0);
  f.emit.status({ session_id: "session-A", state: "closed", reason: "lease lost" });
  assert.equal(f.client.getProjectionStatus("session-A"), "closed");
  assert.ok(f.events.some(e => e.name === "conn://error" && /lease lost/.test(e.payload.message)));
});

test("explicit resync errors propagate and detaching prevents stale callbacks", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  f.native.bootstrap = async () => { throw new Error("bootstrap failed"); };
  await assert.rejects(f.client.retryActive("session-A"), /bootstrap failed/);
  assert.equal(f.timers.jobs.size, 0);
  await f.client.attach("session-B");
  assert.equal(f.timers.jobs.size, 0);
  const count = f.events.length;
  f.emit.event("session-A", { seq: 1, type: "activity_changed" });
  f.emit.reset("session-A", "cursor_expired");
  assert.equal(f.events.length, count);
});

test("overlapping attaches replace the current watch cleanly", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-A");
  await f.client.attach("session-B");
  assert.deepEqual(f.watches.map(w => w.seed), ["session-A", "session-B"]);
  assert.deepEqual(f.closedSeeds, ["session-A"], "旧 seed 的单流在 Rust 侧被显式停掉");
  assert.equal(f.client.getActiveSeed(), "session-B");
});

test("typed commands preserve targets and unknown outcomes", async t => {
  const f = await streamFixture(); t.after(() => f.client.destroy());
  await f.client.attach("session-B");
  const target = { kind: "session", session_id: "session-A" };
  await f.client.command({ type: "tool.permission.respond", tool_call_id: "tool-A", approved: true, trust_folder: false }, target);
  assert.deepEqual(f.submissions.at(-1), [target, { type: "tool.permission.respond", tool_call_id: "tool-A", approved: true, trust_folder: false }, { preconditions: [] }]);
  await f.client.command({ type: "config.save", patch: {} });
  assert.deepEqual(f.submissions.at(-1), [{ kind: "global" }, { type: "config.save", patch: {} }, { preconditions: [] }]);
  f.native.submit = async () => { throw new f.host.NativeClientError({ kind: "outcome_unknown", message: "timeout", commandId: "command-unknown" }); };
  await assert.rejects(f.client.command({ type: "interaction.ask.dismiss", interaction_id: "ask-A" }, target), e => e.kind === "outcome_unknown" && e.commandId === "command-unknown");
});
