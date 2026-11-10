import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost, mockNativeAddon } from "./test-host.mjs";

const scenarios = [
  { kind: "ask", decision: "submit", payload: { answers: [{ question_id: "q1", answer: "yes" }] }, type: "interaction.ask.respond", answers: { q1: "yes" } },
  { kind: "ask", decision: "dismiss", type: "interaction.ask.dismiss" },
  { kind: "tool_permission", decision: "approve", type: "tool.permission.respond", approved: true, trust_folder: false },
  { kind: "tool_permission", decision: "reject", type: "tool.permission.respond", approved: false, trust_folder: false },
  { kind: "tool_permission", decision: "trust", type: "tool.permission.respond", approved: true, trust_folder: true },
];
// 计划评审已随 `plan.review.respond` 退役（ringing-commands-7）：宿主审批面
// 只剩 permission/ask 两类，plan 只保留在 device challenge 词表（桌面壳不使用）。

for (const scenario of scenarios) {
  test(`IPC -> canonical command into native submit: ${scenario.kind}/${scenario.decision}`, async t => {
    const canonicalId = scenario.kind === "tool_permission" ? "call-canonical" : "interaction-canonical";
    const pending = {
      pending_permission: scenario.kind === "tool_permission" ? { tool_call_id: canonicalId, tool_name: "exec", paths: [] } : null,
      pending_interaction: scenario.kind !== "tool_permission" ? { id: canonicalId, kind: scenario.kind, details: {} } : null,
    };
    const mock = mockNativeAddon();
    mock.client.approvalsRaw = async () => pending;
    mock.client.bootstrap = async seed => ({
      session_id: seed, server_epoch: "epoch-test",
      state: { session_id: seed, seq: 1, activity: "idle", current_turn_id: null, turns: [], timeline: [], tools: [],
        interactions: [{ interaction_id: canonicalId === "call-canonical" ? "permission-interaction" : canonicalId, call_id: canonicalId === "call-canonical" ? canonicalId : null, kind: scenario.kind === "tool_permission" ? "permission" : scenario.kind, request: "", resolution: null }], subagents: [] },
    });
    const host = await loadHost({ native: mock.addon });
    const client = new host.RingingClient({}, () => {});
    host.registerIpcHandlers(client, {}, new host.ChallengeManager());
    const [view] = await host.invoke("pending_approvals", { seed: "session-A" });
    assert.ok(!JSON.stringify(view).includes(canonicalId));
    await host.invoke("respond_approval", { seed: "session-A", challengeId: view.challenge_id, decision: scenario.decision, payload: scenario.payload });
    const [target, command] = mock.submissions.at(-1);
    // 信封（schema/version/contract_revision/headers/身份字段）由 qaqh-client 的
    // send_command_v2_typed 构造并在 crate 测试覆盖；这里断言 Electron 层把
    // 规范命令与显式 session target 原样交给 native 绑定。
    assert.deepEqual(target, { kind: "session", session_id: "session-A" });
    assert.equal(command.type, scenario.type);
    if (scenario.kind === "tool_permission") {
      assert.equal(command.tool_call_id, canonicalId);
      assert.equal(command.approved, scenario.approved);
      assert.equal(command.trust_folder, scenario.trust_folder);
    } else {
      assert.equal(command.interaction_id, canonicalId);
      if (scenario.decision === "submit") assert.deepEqual(command.answers, [{ question_id: "q1", answer: "yes" }]);
    }
  });
}

test("adapter delivers bootstrap before events and re-bootstraps after resync", async t => {
  const mock = mockNativeAddon();
  const host = await loadHost({ native: mock.addon });
  const events = [];
  const client = new host.RingingClient({}, (name, payload) => events.push({ name, payload }));
  t.after(() => client.destroy());
  let bootstraps = 0;
  mock.client.bootstrap = async seed => {
    bootstraps++;
    return { session_id: seed, server_epoch: "epoch", state: { session_id: seed, seq: bootstraps, activity: "idle", current_turn_id: null, turns: [], timeline: [], tools: [], interactions: [], subagents: [] } };
  };
  await client.attach("session-A");
  // open → bootstrap 先行送达；随后事件直通。
  assert.equal(bootstraps, 1);
  assert.ok(events.some(e => e.name === "projection://bootstrap"));
  mock.emit.event("session-A", { seq: 2, type: "activity_changed", activity: "idle" });
  assert.ok(events.some(e => e.name === "projection://event" && e.payload.event.seq === 2));

  // resync：缓冲清空，下一次 open 重新 bootstrap（顺序契约与旧 SDK watch 一致）。
  mock.emit.reset("session-A", "cursor_gap");
  assert.ok(events.some(e => e.name === "projection://reset" && e.payload.reason === "cursor_gap"));
  mock.emit.event("session-A", { seq: 9, type: "activity_changed", activity: "idle" });
  assert.ok(!events.some(e => e.name === "projection://event" && e.payload.event.seq === 9), "事件在重新 bootstrap 前被缓冲");
  mock.emit.status({ session_id: "session-A", state: "open", server_epoch: "epoch-2", cursor: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bootstraps, 2);
  assert.ok(events.some(e => e.name === "projection://event" && e.payload.event.seq === 9), "缓冲事件在新 bootstrap 之后按序 flush");
});

test("reconnecting status is forwarded as scheduled reconnect notices", async t => {
  const mock = mockNativeAddon();
  const host = await loadHost({ native: mock.addon });
  const events = [];
  const client = new host.RingingClient({}, (name, payload) => events.push({ name, payload }));
  t.after(() => client.destroy());
  await client.attach("session-A");
  mock.emit.status({ session_id: "session-A", state: "reconnecting", retry_ms: 1500, reason: { kind: "lagged" }, last_cursor: "epoch:7" });
  const reconnects = events.filter(e => e.name === "conn://reconnect");
  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0].payload.session_id, "session-A");
  assert.equal(reconnects[0].payload.attempt, 1);
  assert.equal(reconnects[0].payload.delay_ms, 1500);
  assert.ok(reconnects.every(e => typeof e.payload.at === "number" && e.payload.at > 0));
  assert.equal(client.getProjectionStatus("session-A"), "reconnecting");
});

test("closed stream surfaces the reason and detaching prevents stale callbacks", async t => {
  const mock = mockNativeAddon();
  const host = await loadHost({ native: mock.addon });
  const events = [];
  const client = new host.RingingClient({}, (name, payload) => events.push({ name, payload }));
  t.after(() => client.destroy());
  await client.attach("session-A");
  mock.emit.status({ session_id: "session-A", state: "closed", reason: "server terminated stream (forbidden)" });
  assert.equal(client.getProjectionStatus("session-A"), "closed");
  assert.ok(events.some(e => e.name === "conn://error" && /forbidden/.test(e.payload.message)));
  // detach 后旧 seed 的推送不再进入宿主事件面。
  client.detachActive();
  const count = events.length;
  mock.emit.event("session-A", { seq: 3, type: "activity_changed" });
  mock.emit.status({ session_id: "session-A", state: "open", server_epoch: "epoch", cursor: null });
  assert.equal(events.length, count);
});
