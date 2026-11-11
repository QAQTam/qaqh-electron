/**
 * 活动 store 的交接检测：实时封箱与断线窗口结算都自动 fork，历史重放绝不自动 fork。
 *
 * 对位施工单 §一·2「立刻 fork」与 §五「后端不会自动开 B」那条兜底的边界：
 * - 事件流里封箱（`tool_finished` 带 `handed_off:true`）→ 上报给标签层；
 * - 断线/重开/resync 窗口里落地的封箱（快照里回合还在跑）→ 快照落地时结算,
 *   照样上报 —— 实时闸门要求 declare 走过事件流,重开后 declare 只在快照里,
   不结算就会「模型调用完卡在交接卡」谁也不 fork；
 * - 重新打开一个**已终态**的历史交接（bootstrap 重放）→ 不上报。少了这道闸门,
 *   每次切回标签都会照着历史再开一条会话；那条交接该走回合尾部的人点入口,
 *   且水位缺口（后端 B01）下的旧帧重发也不得翻案。
 * - 输出以引用下发（正文很长）时，等引用回填后再上报一次。
 */
import { afterEach, expect, test, vi } from "vitest";
import { desktopHostSurface, transport, type StreamHandlers } from "../src/lib/transport";
import { SessionStore } from "../src/session/store";
import { sessionBootstrap, contentRef, inline } from "./session-fixtures";
import type { SessionBootstrap } from "../src/api/qaqh/SessionBootstrap";
import type { TimelineEntry } from "../src/api/qaqh/TimelineEntry";
import type { HandoffFact } from "../src/session/handoff";

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
const DUPLICATE = `这一回合已经交接过了（${REPORT.from_session_id}），不再重复封箱。`;

const INPUT: TimelineEntry = {
  kind: "input",
  data: {
    block_id: "input-1", turn_id: "turn_live", purpose: "trigger_turn",
    content: inline("帮我把测试跑通"), attachments: [],
    actor: { kind: "user", id: "user", display_name: null },
  },
};

function sealedBootstrap(options: { outputInline: boolean; terminal?: boolean }): SessionBootstrap {
  const bootstrap = sessionBootstrap(REPORT.from_session_id, {
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
  return bootstrap;
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
  const reported: HandoffFact[] = [];
  store.onHandoffDetected = (fact) => reported.push(fact);
  stores.push(store);
  return {
    store,
    reported,
    emit(event: Parameters<StreamHandlers["onProjectionEvent"]>[1]) {
      handlers.onProjectionEvent(store.seed, event);
    },
  };
}

test("事件流里封箱：立刻上报给标签层去 fork", async () => {
  const { store, reported, emit } = fixture(sessionBootstrap(REPORT.from_session_id, { seq: 0 }));
  await store.activate();

  emit({ seq: 1, type: "turn_started", turn_id: REPORT.turn_id, input_id: "in-1", mode: "normal" });
  emit({ seq: 2, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_handoff", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  // 声明本身不触发 fork：handoff_invalid_args 之后模型可以改参数重试。
  expect(reported).toHaveLength(0);

  emit({ seq: 3, type: "tool_finished", call_id: "call_handoff", outcome: { kind: "completed" },
    output: inline(SEALED), output_truncated: false, metrics: null });
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({
    key: `${REPORT.from_session_id}|${REPORT.turn_id}`,
    handoffDoc: REPORT.handoff_doc,
    workSummary: REPORT.work_summary,
  });

  // 同回合再来一次（重放/补发）不得二次上报。
  emit({ seq: 4, type: "tool_finished", call_id: "call_handoff", outcome: { kind: "completed" },
    output: inline(SEALED), output_truncated: false, metrics: null });
  expect(reported).toHaveLength(1);
});

test("同回合重复调用：不再上报第二条事实（key 与首封同一条）", async () => {
  const { store, reported, emit } = fixture(sessionBootstrap(REPORT.from_session_id, { seq: 0 }));
  await store.activate();
  emit({ seq: 1, type: "turn_started", turn_id: REPORT.turn_id, input_id: "in-1", mode: "normal" });
  emit({ seq: 2, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_first", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  emit({ seq: 3, type: "tool_finished", call_id: "call_first", outcome: { kind: "completed" },
    output: inline(SEALED), output_truncated: false, metrics: null });
  expect(reported).toHaveLength(1);

  // 模型在同一回合又调一次：后端回人话（status 仍是 ok，不再发第二份 handed_off）。
  emit({ seq: 4, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_dup", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  emit({ seq: 5, type: "tool_finished", call_id: "call_dup", outcome: { kind: "completed" },
    output: inline(DUPLICATE), output_truncated: false, metrics: null });
  expect(reported).toHaveLength(1);
});

test("输出以引用下发：正文回填后才认封箱", async () => {
  const { store, reported, emit } = fixture(sessionBootstrap(REPORT.from_session_id, { seq: 0 }));
  await store.activate();
  emit({ seq: 1, type: "turn_started", turn_id: REPORT.turn_id, input_id: "in-1", mode: "normal" });
  emit({ seq: 2, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_ref", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  emit({ seq: 3, type: "tool_finished", call_id: "call_ref", outcome: { kind: "completed" },
    output: contentRef(REF), output_truncated: false, metrics: null });
  expect(reported).toHaveLength(0);
  await vi.waitFor(() => expect(reported).toHaveLength(1));
  expect(reported[0]!.handoffDoc).toBe(REPORT.handoff_doc);
});

test("重新打开已终态的历史交接：bootstrap 重放不自动 fork", async () => {
  const { store, reported } = fixture(sealedBootstrap({ outputInline: true, terminal: true }));
  await store.activate();
  await vi.waitFor(() => expect(store.state[0].turns[REPORT.turn_id]).toBeDefined());
  expect(reported).toHaveLength(0);
  // 但事实读得出来 —— 回合尾部那条「继续这条交接」正是靠这一条撑着。
  const turn = store.state[0].turns[REPORT.turn_id]!;
  expect(turn.steps.some((step) => step.kind === "tool" && step.name === "handoff")).toBe(true);
});

test("引用正文的历史会话重开：同样不自动 fork，也不丢事实", async () => {
  const { store, reported } = fixture(sealedBootstrap({ outputInline: false, terminal: true }));
  await store.activate();
  await vi.waitFor(() => expect(store.contentFailures === 0).toBe(true));
  expect(reported).toHaveLength(0);
});

test("断线窗口里落地的封箱（快照里回合还在跑）：重开也照样自动 fork", async () => {
  // 实时闸门原本要求 declare 走过事件流;重开/resync 后 declare 只在快照里,
  // 旧闸门会把这条封箱当历史跳过 —— 「模型调用完卡在交接卡」的根因。
  const { store, reported } = fixture(sealedBootstrap({ outputInline: true }));
  await store.activate();
  await vi.waitFor(() => expect(reported).toHaveLength(1));
  expect(reported[0]).toMatchObject({
    key: `${REPORT.from_session_id}|${REPORT.turn_id}`,
    handoffDoc: REPORT.handoff_doc,
  });
});

test("断线窗口里的封箱以引用下发：正文回填后照样 fork", async () => {
  const { store, reported } = fixture(sealedBootstrap({ outputInline: false }));
  await store.activate();
  await vi.waitFor(() => expect(reported).toHaveLength(1));
  expect(reported[0]!.handoffDoc).toBe(REPORT.handoff_doc);
});

test("历史封箱的旧帧重放（B01 水位缺口）：不得照历史再 fork", async () => {
  const { store, reported, emit } = fixture(sealedBootstrap({ outputInline: true, terminal: true }));
  await store.activate();
  await vi.waitFor(() => expect(store.state[0].turns[REPORT.turn_id]).toBeDefined());
  expect(reported).toHaveLength(0);
  // 后端重发水位以下的 declare/finished 旧帧:历史封箱不得翻案。
  emit({ seq: 4, type: "tool_declared", turn_id: REPORT.turn_id, call_id: "call_handoff", tool_name: "handoff",
    args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary } });
  emit({ seq: 5, type: "tool_finished", call_id: "call_handoff", outcome: { kind: "completed" },
    output: inline(SEALED), output_truncated: false, metrics: null });
  expect(reported).toHaveLength(0);
});
