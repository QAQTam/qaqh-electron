/**
 * 活动 store 的封箱投影(ADR-016 切片 4):fork 权威在内核,store 只立两个只读
 * 信号——「已封箱」(`isHandoffSealed`,composer 置灰依据)与「链已接」
 * (`handoffSealed`,HandoffSealed 事件投影),供卡片续接态与自动跳转消费。
 *
 * 封箱事实三路收口:
 * - 事件流实时封箱(`tool_finished` 带 `handed_off:true`);
 * - 断线窗口封箱(bootstrap 快照里回合还在跑——重开/resync 后 declare 只在快照里);
 * - 输出以引用下发时的正文回填。
 * 以及 HandoffSealed 事件的 A/B 双流幂等与历史重放不翻案。
 */
import { afterEach, expect, test, vi } from "vitest";
import { desktopHostSurface, transport, type StreamHandlers } from "../src/lib/transport";
import { SessionStore } from "../src/session/store";
import { sessionBootstrap, contentRef, inline } from "./session-fixtures";
import type { SessionBootstrap } from "../src/api/qaqh/SessionBootstrap";
import type { TimelineEntry } from "../src/api/qaqh/TimelineEntry";

const REF = "sha256:9e1f5a3b0000000000000000000000000000000000000000000000000000abcd";

const REPORT = {
  handed_off: true,
  from_session_id: "ses_live",
  turn_id: "turn_live",
  work_summary: "把交接链路接通",
  handoff_doc: "## 当前任务\n继续 §七 第 1 条",
  handoff_path: "C:\\Users\\QAQTam\\.qaqh\\sessions\\ses_live\\handoff\\handoff-11-10-190233.md",
  modified_files: ["webui/src/session/reducer.ts"],
  context_used_tokens: 960,
  context_window_tokens: 1000,
};
const SEALED = `已封箱交接。本会话到此为止。\n\n\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``;

const INPUT: TimelineEntry = {
  kind: "input",
  data: {
    block_id: "input-1", turn_id: "turn_live", purpose: "trigger_turn",
    content: inline("帮我把测试跑通"), attachments: [],
    actor: { kind: "user", id: "user", display_name: null },
  },
};

function sealedBootstrap(options: { outputInline: boolean; terminal?: boolean }): SessionBootstrap {
  return sessionBootstrap(REPORT.from_session_id, {
    seq: 3,
    turns: [{
      turn_id: REPORT.turn_id,
      // outcome 为 null = 回合还在跑(断线/重开窗口里封箱刚落地);
      // terminal = 回合已终态(真正的历史交接)。
      outcome: options.terminal
        ? { kind: "finished", data: { terminal: "completed", usage: null, error: null } }
        : null,
    }],
    currentTurnId: REPORT.turn_id,
    timeline: [INPUT, { kind: "tool_call", data: { turn_id: REPORT.turn_id, call_id: "call_handoff" } }],
    tools: [{
      call_id: "call_handoff", turn_id: REPORT.turn_id, tool_name: "handoff",
      args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary },
      state: { kind: "finished", outcome: { kind: "completed" } },
      output: options.outputInline ? inline(SEALED) : contentRef(REF),
      output_truncated: false, metrics: null,
    }],
  });
}

const stores: SessionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

function fixture(initial: SessionBootstrap, body = SEALED) {
  let handlers!: StreamHandlers;
  vi.spyOn(desktopHostSurface(transport)!, "subscribe").mockImplementation(async (value) => {
    handlers = value;
    return () => {};
  });
  // 宿主契约:attach 之后由宿主推 bootstrap(与 content-hydration 用例同一夹具做法)。
  vi.spyOn(transport, "attach").mockImplementation(async () => {
    handlers.onProjectionBootstrap?.(initial.session_id, initial);
  });
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "query").mockImplementation(async (method) => (method === "todo.list" ? { items: [] } : {}) as never);
  vi.spyOn(transport, "sessionBootstrap").mockResolvedValue(initial);
  vi.spyOn(transport, "readContentText").mockImplementation(async () => body);
  const store = new SessionStore(initial.session_id);
  stores.push(store);
  return {
    store,
    emit(event: Parameters<StreamHandlers["onProjectionEvent"]>[1]) {
      handlers.onProjectionEvent(store.seed, event);
    },
  };
}

test("事件流里封箱:立「已封箱」投影,声明与重复重放都不翻案", async () => {
  const { store, emit } = fixture(sessionBootstrap(REPORT.from_session_id, { seq: 0 }));
  await store.activate();
  expect(store.isHandoffSealed()).toBe(false);

  emit({ seq: 1, type: "turn_started", turn_id: REPORT.turn_id, input_id: "in-1", mode: "normal" });
  emit({ seq: 2, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_handoff", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  // 声明本身不封箱:handoff_invalid_args 之后模型可以改参数重试。
  expect(store.isHandoffSealed()).toBe(false);

  emit({ seq: 3, type: "tool_finished", call_id: "call_handoff", outcome: { kind: "completed" },
    output: inline(SEALED), output_truncated: false, metrics: null });
  expect(store.isHandoffSealed()).toBe(true);

  // 同回合再来一次(重放/补发):已立起的投影不翻案。
  emit({ seq: 4, type: "tool_finished", call_id: "call_handoff", outcome: { kind: "completed" },
    output: inline(SEALED), output_truncated: false, metrics: null });
  expect(store.isHandoffSealed()).toBe(true);
});

test("HandoffSealed 事件(A 侧):立「链已接」,composer 置灰,重发幂等", async () => {
  const { store, emit } = fixture(sessionBootstrap(REPORT.from_session_id, { seq: 0 }));
  await store.activate();
  emit({ seq: 1, type: "handoff_sealed", sealed_session_id: REPORT.from_session_id, chain_root: REPORT.from_session_id,
    successor_session_id: "ses_CHILD", turn_id: REPORT.turn_id, work_summary: REPORT.work_summary, at_ms: 1_700_000_000_000 });
  expect(store.handoffSealed()).toMatchObject({ sealedSessionId: REPORT.from_session_id, successorSessionId: "ses_CHILD" });
  expect(store.isHandoffSealed()).toBe(true);

  // 双发/重发同一条 (sealed, turn):幂等,不翻案。
  emit({ seq: 2, type: "handoff_sealed", sealed_session_id: REPORT.from_session_id, chain_root: REPORT.from_session_id,
    successor_session_id: "ses_CHILD", turn_id: REPORT.turn_id, work_summary: REPORT.work_summary, at_ms: 1_700_000_000_000 });
  expect(store.handoffSealed()).toMatchObject({ sealedSessionId: REPORT.from_session_id, successorSessionId: "ses_CHILD" });
});

test("HandoffSealed 事件(B 侧,successor==本会话):composer 不置灰", async () => {
  const { store, emit } = fixture(sessionBootstrap("ses_CHILD", { seq: 0 }));
  await store.activate();
  emit({ seq: 1, type: "handoff_sealed", sealed_session_id: REPORT.from_session_id, chain_root: REPORT.from_session_id,
    successor_session_id: "ses_CHILD", turn_id: REPORT.turn_id, work_summary: REPORT.work_summary, at_ms: 1_700_000_000_000 });
  expect(store.handoffSealed()).toMatchObject({ sealedSessionId: REPORT.from_session_id });
  // 后继是活会话:置灰口径只认「封箱的是本会话」。
  expect(store.isHandoffSealed()).toBe(false);
});

test("输出以引用下发:正文回填后才认封箱", async () => {
  const { store, emit } = fixture(sessionBootstrap(REPORT.from_session_id, { seq: 0 }));
  await store.activate();
  emit({ seq: 1, type: "turn_started", turn_id: REPORT.turn_id, input_id: "in-1", mode: "normal" });
  emit({ seq: 2, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_ref", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  emit({ seq: 3, type: "tool_finished", call_id: "call_ref", outcome: { kind: "completed" },
    output: contentRef(REF), output_truncated: false, metrics: null });
  expect(store.isHandoffSealed()).toBe(false);
  await vi.waitFor(() => expect(store.isHandoffSealed()).toBe(true));
});

test("重新打开已终态的历史交接:bootstrap 重放立置灰,fork 权威在内核", async () => {
  const { store } = fixture(sealedBootstrap({ outputInline: true, terminal: true }));
  await store.activate();
  await vi.waitFor(() => expect(store.state[0].turns[REPORT.turn_id]).toBeDefined());
  expect(store.isHandoffSealed()).toBe(true);
  // 事实读得出来 —— 回合尾部那条卡片入口正是靠这一条撑着(离线可重建)。
  const turn = store.state[0].turns[REPORT.turn_id]!;
  expect(turn.steps.some((step) => step.kind === "tool" && step.name === "handoff")).toBe(true);
});

test("引用正文的历史会话重开:同样立置灰,不丢事实", async () => {
  const { store } = fixture(sealedBootstrap({ outputInline: false, terminal: true }));
  await store.activate();
  // 引用回填是异步的:直接等投影立起来,而不是等 contentFailures 清零(它先于回填)。
  await vi.waitFor(() => expect(store.isHandoffSealed()).toBe(true));
  expect(store.contentFailures === 0).toBe(true);
});

test("断线窗口里落地的封箱(快照里回合还在跑):重开也立置灰", async () => {
  const { store } = fixture(sealedBootstrap({ outputInline: true }));
  await store.activate();
  await vi.waitFor(() => expect(store.isHandoffSealed()).toBe(true));
});

test("断线窗口里的封箱以引用下发:正文回填后照样立置灰", async () => {
  const { store } = fixture(sealedBootstrap({ outputInline: false }));
  await store.activate();
  await vi.waitFor(() => expect(store.isHandoffSealed()).toBe(true));
});
