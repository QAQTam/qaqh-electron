import { afterEach, expect, test, vi } from "vitest";
import { transport, desktopHostSurface, type StreamHandlers } from "../src/lib/transport";
import { SessionStore } from "../src/session/store";
import { ContentLoader } from "../src/session/content-loader";
import type { ContentValue } from "../src/api/qaqh/ContentValue";
import type { ExecSessionView } from "../src/api/qaqh/ExecSessionView";
import type { SessionBootstrap } from "../src/api/qaqh/SessionBootstrap";
import type { TimelineEntry } from "../src/api/qaqh/TimelineEntry";
import { contentRef, inline, sessionBootstrap } from "./session-fixtures";

const refs = Array.from({ length: 4 }, (_, index) => `sha256:${String(index + 1).repeat(64)}`);
const bodies = ["你好", "检查项目结构", "你好！我是 QAQ。", '{"output":"正文","exit_code":0}'];
const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

function snapshot(sessionId = "content-session"): SessionBootstrap {
  const timeline: TimelineEntry[] = [
    { kind: "input", data: {
      block_id: "input-1", turn_id: "t1", purpose: "trigger_turn", content: contentRef(refs[0]!), attachments: [],
      actor: { kind: "user", id: "u1", display_name: null },
    } },
    { kind: "assistant_block", data: {
      turn_id: "t1", block_id: "reason", block_kind: "reasoning", content: contentRef(refs[1]!), model: "m", usage: null,
    } },
    { kind: "tool_call", data: { turn_id: "t1", call_id: "call1" } },
    { kind: "tool_result", data: { turn_id: "t1", call_id: "call1", content: contentRef(refs[3]!) } },
    { kind: "assistant_block", data: {
      turn_id: "t1", block_id: "answer", block_kind: "answer", content: contentRef(refs[2]!), model: "m", usage: null,
    } },
  ];
  return sessionBootstrap(sessionId, {
    seq: 5,
    activity: "running",
    currentTurnId: "t1",
    turns: [{ turn_id: "t1", input_id: "in1", mode: "normal", outcome: null }],
    timeline,
    tools: [{
      call_id: "call1", turn_id: "t1", tool_name: "read", args: { path: "README.md" },
      state: { kind: "finished", outcome: { kind: "completed" } },
      output: contentRef(refs[3]!), output_truncated: false, metrics: null,
    }],
  });
}

function fixture(initial = snapshot()) {
  let handlers!: StreamHandlers;
  vi.spyOn(desktopHostSurface(transport)!, "subscribe").mockImplementation(async (value) => {
    handlers = value;
    return () => {};
  });
  vi.spyOn(transport, "attach").mockImplementation(async () => handlers.onProjectionBootstrap?.(initial.session_id, initial));
  vi.spyOn(transport, "approvals").mockResolvedValue([]);
  vi.spyOn(transport, "query").mockImplementation(async (method) =>
    (method === "todo.list" ? { items: [] } : {}) as never);
  const bootstrap = vi.spyOn(transport, "sessionBootstrap").mockResolvedValue(initial);
  const read = vi.spyOn(transport, "readContentText").mockImplementation(async (id) => bodies[refs.indexOf(id)]!);
  const store = new SessionStore(initial.session_id);
  stores.push(store);
  return {
    store,
    read,
    bootstrap,
    emit(event: Parameters<StreamHandlers["onProjectionEvent"]>[1]) { handlers.onProjectionEvent(store.seed, event); },
  };
}

test("flat bootstrap and cursor arrive together; referenced content hydrates on first activation", async () => {
  const { store, read, bootstrap } = fixture();
  await store.activate();
  await vi.waitFor(() => expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]));
  const turn = store.state[0].turns.t1!;
  expect(turn.user.text).toBe(bodies[0]);
  expect(turn.steps[0]).toMatchObject({ kind: "thinking", text: bodies[1] });
  expect(turn.steps[1]).toMatchObject({ kind: "tool", argsJson: '{\n  "path": "README.md"\n}', output: { text: "正文", exitCode: 0 } });
  expect(read).toHaveBeenCalledTimes(4);
  expect(bootstrap).not.toHaveBeenCalled();
  await store.loadBootstrap();
  expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]);
  expect(read).toHaveBeenCalledTimes(4);
});

test("completed exec session output references hydrate from bootstrap", async () => {
  const initial = sessionBootstrap("exec-content-session");
  const execSession: ExecSessionView = {
    id: "exec-1",
    owner_session_id: initial.session_id,
    origin_turn_id: "turn-1",
    origin_call_id: "call-1",
    state: { kind: "finished", outcome: { kind: "exited", exit_code: 0 } },
    tty: false,
    command: "printf output",
    started_at_ms: 1,
    finished_at_ms: 2,
    next_offset: 6,
    output_preview: "output",
    preview_start_offset: 0,
    output_complete: true,
    capture_omitted_bytes: 0,
    stream_dropped_bytes: 0,
    output: contentRef(refs[3]!),
  };
  initial.state.exec_sessions = [execSession];
  const { store, read } = fixture(initial);

  await store.activate();
  await vi.waitFor(() => expect(store.state[0].execSessions[execSession.id]?.output).toEqual(inline(bodies[3]!)));
  expect(read).toHaveBeenCalledTimes(1);
});

test("a replaced live content reference cannot be overwritten by its older download", async () => {
  const empty = sessionBootstrap("content-session");
  const { store, read, emit } = fixture(empty);
  let finishOld!: (text: string) => void;
  read.mockImplementation((id) => id === refs[1]
    ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(bodies[2]!));
  await store.activate();
  emit({ seq: 1, type: "turn_started", turn_id: "t1", input_id: "in1", mode: "normal" });
  const answer = (content: ContentValue) => ({ kind: "assistant_block" as const, data: {
    turn_id: "t1", block_id: "answer", block_kind: "answer" as const, content, model: "m", usage: null,
  } });
  emit({ seq: 2, type: "timeline_appended", entry: answer(contentRef(refs[1]!)) });
  await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
  emit({ seq: 3, type: "timeline_appended", entry: answer(contentRef(refs[2]!)) });
  await vi.waitFor(() => expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]));
  finishOld("过期答案");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]);
});

test("content read failures keep the reference and can be retried", async () => {
  const base = snapshot();
  const state = sessionBootstrap(base.session_id, {
    seq: 1,
    turns: base.state.turns,
    timeline: [base.state.timeline[4]!],
    tools: [],
  });
  const { store, read } = fixture(state);
  read.mockRejectedValueOnce(new Error("content not found"));
  await store.activate();
  await vi.waitFor(() => expect(store.contentStatus[0]()[refs[2]!]).toBe("failed"));
  expect(store.state[0].turns.t1?.answer?.text).toBe("");
  store.retryContent();
  await vi.waitFor(() => expect(store.state[0].turns.t1?.answer?.text).toBe(bodies[2]));
  expect(read).toHaveBeenCalledTimes(2);
});

test("a late explicit bootstrap cannot replace the retained view after deactivation", async () => {
  const state = sessionBootstrap("content-session", {
    turns: [{ turn_id: "t1", input_id: "in1", mode: "normal", outcome: null }],
    timeline: [{ kind: "assistant_block", data: {
      turn_id: "t1", block_id: "answer", block_kind: "answer", content: inline("old answer"), model: "m", usage: null,
    } }],
  });
  const { store, bootstrap } = fixture(state);
  await store.activate();
  let finishBootstrap!: (value: SessionBootstrap) => void;
  bootstrap.mockImplementation(() => new Promise(resolve => { finishBootstrap = resolve; }));
  const loading = store.loadBootstrap();
  store.deactivate();
  finishBootstrap(sessionBootstrap("content-session", { seq: 99 }));
  await loading;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.state[0].turns.t1?.answer?.text).toBe("old answer");
  expect(store.hydrated[0]()).toBe(true);
});

test("content batches have bounded concurrency and coalesce duplicate references", async () => {
  const finishers: Array<(value: string) => void> = [];
  const read = vi.fn((_ref: string, _signal: AbortSignal) => new Promise<string>(resolve => finishers.push(resolve)));
  const write = vi.fn();
  const loader = new ContentLoader(read, write);
  for (let index = 0; index < 6; index += 1) { loader.request(String(index)); loader.request(String(index)); }
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  loader.clear();
  for (const finish of finishers) finish("stale");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(read).toHaveBeenCalledTimes(4);
  expect(write.mock.calls).toEqual([]);
});
