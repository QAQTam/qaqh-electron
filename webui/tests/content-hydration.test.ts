import { afterEach, expect, test, vi } from "vitest";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";
import { SessionStore } from "../src/session/store";
import { ContentLoader } from "../src/session/content-loader";
import type { ContentValue } from "../src/api/qaqh/ContentValue";
import type { ConversationSnapshot } from "../src/api/qaqh/ConversationSnapshot";
import type { ConversationDelta } from "../src/api/qaqh/ConversationDelta";

const refs = Array.from({ length: 5 }, (_, i) => `sha256:${String(i + 1).repeat(64)}`);
const ref = (index: number): ContentValue => ({ kind: "ref", data: { content_ref: refs[index]! } });
const bodies = ["你好", "检查项目结构", "你好！我是 QAQ。", '{"path":"README.md"}', '{"output":"正文","exit_code":0}'];
const stores: SessionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

function snapshot(): ConversationSnapshot {
  return {
    session_id: "content-session", revision: 6, last_fact_seq: 6,
    compaction: null, current_turn_id: null,
    turns: [{ turn_id: "t1", input_id: "in1", mode: "normal", recovery_ref: null, outcome: null }],
    context: [
      { source_fact_seq: 1, kind: { kind: "input", data: {
        input_id: "in1", input_kind: "user_text", input_purpose: "trigger_turn",
        content: ref(0), attachments: [], actor: { kind: "user", id: "u1" },
      } } },
      { source_fact_seq: 2, kind: { kind: "assistant_block", data: {
        turn_id: "t1", block_id: "reason", block_kind: "reasoning", content: ref(1), model: "m", usage: null,
      } } },
      { source_fact_seq: 3, kind: { kind: "tool_call", data: {
        turn_id: "t1", call_id: "call1", tool_name: "read", args: ref(3), args_hash: refs[3]!,
        result: { terminal_status: "succeeded", output: ref(4), error: null, reconciled: false,
          metrics: { started_at_ms: 1, finished_at_ms: 2 } },
      } } },
      { source_fact_seq: 4, kind: { kind: "assistant_block", data: {
        turn_id: "t1", block_id: "answer", block_kind: "answer", content: ref(2), model: "m", usage: null,
      } } },
    ],
  };
}

function fixture(state = snapshot()) {
  let handlers!: StreamHandlers;
  vi.spyOn(desktopHostSurface(transport)!, "subscribe").mockImplementation(async (value) => {
    handlers = value;
    return () => {};
  });
  vi.spyOn(transport, "attach").mockImplementation(async () => {
    handlers.onProjectionBootstrap?.("content-session", { conversation: { state }, control: { state: { activity: "idle" } } });
  });
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  const bootstrap = vi.spyOn(transport, "sessionBootstrap").mockResolvedValue({ conversation: { state } });
  const read = vi.spyOn(transport, "readContentText").mockImplementation(async (id) => bodies[refs.indexOf(id)]!);
  const store = new SessionStore("content-session");
  stores.push(store);
  return { store, read, bootstrap, emit(delta: ConversationDelta) {
    handlers.onProjectionEvent(store.seed, {
      stream_key: { kind: "channel", data: "conversation" }, payload: { kind: "conversation_delta", data: delta },
    });
  } };
}

test("bootstrap and cursor arrive together; reference hydration happens on first activation", async () => {
  const { store, read, bootstrap } = fixture();
  await store.activate();
  await vi.waitFor(() => expect(store.state[0].turns["#0"]?.answer?.text).toBe(bodies[2]));
  const turn = store.state[0].turns["#0"]!;
  expect(turn.user.text).toBe(bodies[0]);
  expect(turn.steps[0]).toMatchObject({ kind: "thinking", text: bodies[1] });
  expect(turn.steps[1]).toMatchObject({ kind: "tool", argsJson: bodies[3], output: { text: "正文", exitCode: 0 } });
  expect(read).toHaveBeenCalledTimes(5);
  expect(bootstrap).not.toHaveBeenCalled();
  await store.loadBootstrap();
  expect(store.state[0].turns["#0"]?.answer?.text).toBe(bodies[2]);
  expect(read).toHaveBeenCalledTimes(5);
});

test("实时块下载完成前被新引用替换，旧正文不得覆盖新块", async () => {
  const empty = snapshot(); empty.context = []; empty.turns = [];
  const { store, read, emit } = fixture(empty);
  let finishOld!: (text: string) => void;
  read.mockImplementation((id) => id === refs[1]
    ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(bodies[2]!));
  await store.activate();
  emit({ kind: "turn_started", data: { revision: 1, turn_id: "t1", input_id: "in1", mode: "normal" } });
  const answer = (content: ContentValue): ConversationDelta => ({ kind: "assistant_block_sealed", data: {
    revision: 2, turn_id: "t1", block_id: "answer", block_kind: "answer", content, model: "m", usage: null,
  } });
  emit(answer(ref(1)));
  await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
  emit(answer(ref(2)));
  await vi.waitFor(() => expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]));
  finishOld("过期答案");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]);
});

test("正文加载失败保留引用正文状态且支持独立重试", async () => {
  const state = snapshot();
  state.context = [state.context[3]!];
  const { store, read } = fixture(state);
  read.mockRejectedValueOnce(new Error("content not found"));
  await store.activate();
  await vi.waitFor(() => expect(store.contentStatus[0]()[refs[2]!]).toBe("failed"));
  expect(store.state[0].turns["#0"]?.answer?.text).toBe("");
  store.retryContent();
  await vi.waitFor(() => expect(store.state[0].turns["#0"]?.answer?.text).toBe(bodies[2]));
  expect(read).toHaveBeenCalledTimes(2);
});

test("切走会话保留已读转录，迟到的 bootstrap 不覆盖", async () => {
  const state = snapshot();
  state.context = [state.context[3]!];
  const { store, read, bootstrap } = fixture(state);
  let finish!: (text: string) => void;
  read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await store.activate();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  let finishBootstrap!: (value: unknown) => void;
  bootstrap.mockImplementation(() => new Promise(resolve => { finishBootstrap = resolve; }));
  const loading = store.loadBootstrap();
  store.deactivate();
  finish(bodies[2]!);
  finishBootstrap({ conversation: { state } });
  await loading;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.state[0].slots.length).toBeGreaterThan(0);
  expect(store.hydrated[0]()).toBe(true);
});

test("批量引用并发有界且重复请求合并", async () => {
  const finishers: Array<(value: string) => void> = [];
  const read = vi.fn((_ref: string, _signal: AbortSignal) => new Promise<string>(resolve => finishers.push(resolve)));
  const write = vi.fn();
  const loader = new ContentLoader(read, write);
  for (let i = 0; i < 6; i++) { loader.request(String(i)); loader.request(String(i)); }
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  loader.clear();
  for (const finish of finishers) finish("stale");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(read).toHaveBeenCalledTimes(4);
  expect(write.mock.calls).toEqual([]);
});
