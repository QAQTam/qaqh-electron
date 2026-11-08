// qaqh-napi-client ↔ 真实 daemon 的端到端验收（隔离数据根）。
//
// 前置：qaqh-daemon 以 `QAQH_ALLOW_TEST_DATA_ROOT=1 QAQH_DATA_DIR=<dir> run` 启动，
// 本脚本从 discovery 文档读取 endpoint/token。
//
// 覆盖：connect（lease 握手）→ provider 目录 CAS 配置 → session.create →
// watch（SSE open/bootstrap/事件）→ conversation.send_message → turn 终态 →
// bootstrap/service 查询 → stop-if-idle。
//
// 用法：node scripts/e2e-native-client.mjs <path/to/daemon.json>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const discovery = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
const addon = require("../native/qaqh_napi_client.linux-x64-gnu.node");

console.log(`[e2e] daemon at ${discovery.endpoint}`);

const events = [];
const statuses = [];
let resolveTurn = null;
const turnEnded = new Promise((resolve) => { resolveTurn = resolve; });

const client = addon.NativeClient.connect(
  { base_url: discovery.endpoint, token: discovery.token, tls_fp: discovery.tls_fingerprint ?? undefined },
  (payload) => {
    events.push(payload.event);
    if (payload.event.type === "turn_ended") resolveTurn(payload.event);
  },
  (payload) => console.warn(`[e2e] resync_required: ${JSON.stringify(payload.reset)}`),
  (payload) => statuses.push(payload.state),
  () => {},
);

const submit = async (target, command, options) => {
  const { ack } = await client.submit(target, command, options);
  return ack;
};

const fail = (err) => {
  console.error(`[e2e] FAIL: ${err.message}`);
  try { client.close(); } catch { /* already gone */ }
  process.exit(1);
};

const main = async () => {
  // 1. provider 目录：读 revision → CAS 写入（revision 0 首写路径一并覆盖）。
  const listAck = await submit({ kind: "global" }, { type: "provider.list" });
  if (listAck.status !== "accepted") throw new Error(`provider.list rejected: ${JSON.stringify(listAck)}`);
  const revision = listAck.result?.revision ?? 0;
  console.log(`[e2e] provider.list ok (revision ${revision})`);

  const upsertAck = await submit(
    { kind: "global" },
    {
      type: "provider.upsert",
      id: "e2e",
      provider: {
        name: "E2E Mock",
        base_url: "http://127.0.0.1:9/v1",
        wire: "chat",
        credential: "api_key",
        headers: {},
        compat: null,
        api_key: { operation: "set", value: "sk-e2e-isolated" },
      },
    },
    { preconditions: [{ kind: "config_revision", revision }] },
  );
  if (upsertAck.status !== "accepted") throw new Error(`provider.upsert rejected: ${JSON.stringify(upsertAck)}`);
  console.log("[e2e] provider.upsert accepted");

  const modelAck = await submit(
    { kind: "global" },
    {
      type: "provider.model.upsert",
      provider_id: "e2e",
      model_id: "mock",
      model: {
        enabled: true,
        display_name: "E2E Mock",
        context_window: 8192,
        max_output_tokens: 512,
        reasoning_levels: ["low"],
        capabilities: { tool_calls: false, image_input: false, native_web_search: false, reasoning: false },
        defaults: { native_web_search: false },
      },
    },
    { preconditions: [{ kind: "config_revision", revision: upsertAck.revision ?? revision + 1 }] },
  );
  if (modelAck.status !== "accepted") throw new Error(`provider.model.upsert rejected: ${JSON.stringify(modelAck)}`);

  const defaultAck = await submit(
    { kind: "global" },
    { type: "model.selection.set_default", selection: { provider_id: "e2e", model_id: "mock", options: {} } },
    { preconditions: [{ kind: "config_revision", revision: modelAck.revision ?? revision + 2 }] },
  );
  if (defaultAck.status !== "accepted") throw new Error(`model.selection.set_default rejected: ${JSON.stringify(defaultAck)}`);
  console.log("[e2e] provider/model/default configured (CAS)");

  // 2. 建会话。
  const createAck = await submit(
    { kind: "global" },
    { type: "session.create", title: "napi-e2e", cwd: process.env.HOME },
  );
  if (createAck.status !== "accepted") throw new Error(`session.create rejected: ${JSON.stringify(createAck)}`);
  const sessionId = createAck.result?.session_id;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error(`session.create returned no session_id: ${JSON.stringify(createAck)}`);
  console.log(`[e2e] session created: ${sessionId}`);

  // 3. watch：open → bootstrap → 事件流。
  await client.watchSession(sessionId);

  // 4. 发消息 → 回合终态（隔离 daemon 无真实上游，允许 failed 终态——
  // 这里验证的是协议链路：turn_started/failed 事件必须经 SSE 抵达）。
  const sendAck = await submit(
    { kind: "session", session_id: sessionId },
    { type: "conversation.send_message", text: "e2e" },
  );
  if (sendAck.status !== "accepted") throw new Error(`send_message rejected: ${JSON.stringify(sendAck)}`);
  console.log(`[e2e] message accepted (command_id ${sendAck.command_id})`);

  const turn = await Promise.race([
    turnEnded,
    new Promise((_, reject) => setTimeout(() => reject(new Error("turn_ended timeout (90s)")), 90_000)),
  ]);
  console.log(`[e2e] turn_ended: ${JSON.stringify(turn)}`);

  // 5. 查询面。
  const bootstrap = await client.bootstrap(sessionId);
  console.log(`[e2e] bootstrap: state.seq=${bootstrap.state?.seq} timeline=${bootstrap.state?.timeline?.length} tools=${bootstrap.state?.tools?.length}`);
  const sessions = await client.serviceCall("session.list", {});
  console.log(`[e2e] session.list: ${Array.isArray(sessions) ? sessions.length : "?"} entries`);
  const meta = await client.serviceCall("session.meta", { session_id: sessionId });
  console.log(`[e2e] session.meta: ${meta?.session_id === sessionId ? "session_id round-trips" : JSON.stringify(meta)}`);

  const eventTypes = [...new Set(events.map((event) => event.type))];
  console.log(`[e2e] status path: ${statuses.join(" -> ")}`);
  console.log(`[e2e] event types: ${eventTypes.join(", ")}`);
  if (!statuses.includes("open")) throw new Error("stream never reached open state");
  if (!eventTypes.includes("turn_started")) throw new Error(`expected turn_started in event stream; got: ${eventTypes.join(", ")}`);

  client.close();
  console.log("[e2e] PASS");
  // tokio runtime 与 lease 句柄会挂住事件循环；验收完成即退。
  process.exit(0);
};

main().catch(fail);
