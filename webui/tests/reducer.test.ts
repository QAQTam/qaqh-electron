/** Flattened v3 bootstrap and event reducer tests. */
import { describe, expect, test } from "vitest";
import {
  applySessionBootstrap,
  applySessionEvent,
  contentValueToText,
  emptySession,
  forceSealTurn,
  parseToolOutput,
} from "../src/session/reducer";
import { contentRef, inline, sessionBootstrap } from "./session-fixtures";
import type { ExecSessionView } from "../src/api/qaqh/ExecSessionView";

describe("tool output helpers", () => {
  test("parses the raw output payload and preserves an actual unified diff", () => {
    expect(parseToolOutput(JSON.stringify({ output: "parsed out", exit_code: 0 }))).toMatchObject({ text: "parsed out", exitCode: 0 });
    const rawDiff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(parseToolOutput(rawDiff).diffText).toBe(rawDiff);
  });

  test("content values resolve inline, referenced, unavailable, and null values", () => {
    expect(contentValueToText(inline("hello"))).toBe("hello");
    expect(contentValueToText(contentRef("sha256:ref"))).toBe("");
    expect(contentValueToText({ kind: "unavailable", data: { reason: "lost" } } as never)).toBe("正文不可用");
    expect(contentValueToText(null)).toBe("");
  });
});

describe("applySessionBootstrap", () => {
  test("materializes turns, inputs, model blocks, and tool results from the flat timeline", () => {
    const state = emptySession();
    const bootstrap = sessionBootstrap("session-1", {
      seq: 10,
      turns: [{ turn_id: "turn-1", input_id: "in-1", mode: "normal", outcome: {
        kind: "finished", data: { terminal: "completed", usage: null, error: null },
      } }],
      timeline: [
        { kind: "input", data: {
          block_id: "input-1", turn_id: "turn-1", purpose: "trigger_turn", content: inline("帮我检查代码"), attachments: [],
          actor: { kind: "user", id: "u1", display_name: "Alice" },
        } },
        { kind: "assistant_block", data: {
          turn_id: "turn-1", block_id: "think-1", block_kind: "reasoning", content: inline("先查看结构"), model: "m", usage: null,
        } },
        { kind: "tool_call", data: { turn_id: "turn-1", call_id: "call-1" } },
        { kind: "tool_result", data: { turn_id: "turn-1", call_id: "call-1", content: inline('{"output":"README.md","exit_code":0}') } },
        { kind: "assistant_block", data: {
          turn_id: "turn-1", block_id: "answer-1", block_kind: "answer", content: inline("检查完成"), model: "m", usage: null,
        } },
      ],
      tools: [{
        call_id: "call-1", turn_id: "turn-1", tool_name: "read", args: { path: "README.md" },
        state: { kind: "finished", outcome: { kind: "completed" } },
        output: inline('{"output":"README.md","exit_code":0}'), output_truncated: false, metrics: null,
      }],
    });

    applySessionBootstrap(state, bootstrap);
    const turn = state.turns["turn-1"]!;
    expect(state.watermark).toBe(10);
    expect(state.totalTurns).toBe(1);
    expect(turn.status).toBe("done");
    expect(turn.user.text).toBe("帮我检查代码");
    expect(turn.steps[0]).toMatchObject({ kind: "thinking", text: "先查看结构" });
    expect(turn.steps[1]).toMatchObject({ kind: "tool", name: "read", status: "finished", output: { text: "README.md" } });
    expect(turn.answer?.text).toBe("检查完成");
  });

  test("failed outcome retains its server error", () => {
    const state = emptySession();
    applySessionBootstrap(state, sessionBootstrap("session-2", {
      turns: [{ turn_id: "bad", outcome: { kind: "finished", data: {
        terminal: "failed", usage: null, error: { code: "provider_error", message: "request failed", retryable: true },
      } } }],
    }));
    expect(state.turns.bad).toMatchObject({ status: "failed", error: { message: "request failed" } });
  });
});

test("applySessionEvent reduces a flat turn, tool, assistant block, and terminal outcome", () => {
  const state = emptySession();
  applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "t1", input_id: "in1", mode: "normal" });
  applySessionEvent(state, { seq: 2, type: "timeline_appended", entry: {
    kind: "tool_call", data: { turn_id: "t1", call_id: "call1" },
  } });
  applySessionEvent(state, { seq: 3, type: "tool_arguments_delta", turn_id: "t1", call_id: "call1", text: '{"path":"README.md"}' });
  applySessionEvent(state, { seq: 4, type: "tool_state_changed", turn_id: "t1", call_id: "call1", state: { kind: "running" } });
  applySessionEvent(state, { seq: 5, type: "tool_finished", call_id: "call1", outcome: { kind: "completed" }, output: inline('{"output":"ok","exit_code":0}'), output_truncated: false, metrics: null });
  applySessionEvent(state, { seq: 6, type: "timeline_appended", entry: {
    kind: "assistant_block", data: { turn_id: "t1", block_id: "ans1", block_kind: "answer", content: inline("done"), model: "m", usage: null },
  } });
  applySessionEvent(state, { seq: 7, type: "turn_ended", turn_id: "t1", outcome: {
    kind: "finished", data: { terminal: "completed", usage: null, error: null },
  } });

  const turn = state.turns.t1!;
  expect(turn.status).toBe("done");
  expect(turn.steps).toMatchObject([{ kind: "tool", status: "finished", argsJson: '{"path":"README.md"}' }, { kind: "text", text: "done" }]);
  expect(turn.answer?.text).toBe("done");
});

test("first message deltas render immediately and sealed blocks replace streamed prefixes", () => {
  const state = emptySession();
  applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "t", input_id: "i", mode: "normal" });
  applySessionEvent(state, { seq: 2, type: "message_delta", turn_id: "t", block_id: "r", block_kind: "reasoning", text: "先检查" });
  expect(state.turns.t!.steps).toMatchObject([{ id: "r", kind: "thinking", text: "先检查" }]);
  expect(state.activeReasoningId).toBe("r");
  const structureVersion = state.structureVersion;
  applySessionEvent(state, { seq: 3, type: "message_delta", turn_id: "t", block_id: "r", block_kind: "reasoning", text: "先检查结构" });
  expect(state.structureVersion).toBe(structureVersion);
  applySessionEvent(state, { seq: 4, type: "timeline_appended", entry: {
    kind: "assistant_block", data: { turn_id: "t", block_id: "r", block_kind: "reasoning", content: inline("先检查结构和配置"), model: "m", usage: null },
  } });
  expect(state.activeReasoningId).toBeNull();
  applySessionEvent(state, { seq: 5, type: "message_delta", turn_id: "t", block_id: "a", block_kind: "answer", text: "正在检查" });
  expect(state.turns.t!.answer?.text).toBe("正在检查");
  applySessionEvent(state, { seq: 6, type: "timeline_appended", entry: {
    kind: "assistant_block", data: { turn_id: "t", block_id: "a", block_kind: "answer", content: inline("正在检查，完整尾部"), model: "m", usage: null },
  } });
  expect(state.turns.t!.steps).toMatchObject([
    { id: "r", kind: "thinking", text: "先检查结构和配置" },
    { id: "a", kind: "text", text: "正在检查，完整尾部" },
  ]);
  expect(state.turns.t!.answer?.text).toBe("正在检查，完整尾部");
});

test("tool progress creates an identity and declaration replaces partial args while retaining intermediate speech", () => {
  const state = emptySession();
  applySessionEvent(state, { seq: 1, type: "message_delta", turn_id: "t", block_id: "before", block_kind: "answer", text: "我先读取文件" });
  applySessionEvent(state, { seq: 2, type: "tool_arguments_delta", turn_id: "t", call_id: "c", tool_name: "read", text: '{"path":' });
  expect(state.turns.t!.answerStepId).toBeNull();
  expect(state.turns.t!.steps[1]).toMatchObject({ id: "c", kind: "tool", name: "read", argsJson: '{"path":', status: "declared" });
  applySessionEvent(state, { seq: 3, type: "tool_declared", turn_id: "t", call_id: "c", tool_name: "read", args: { path: "README.md" } });
  applySessionEvent(state, { seq: 4, type: "timeline_appended", entry: { kind: "tool_call", data: { turn_id: "t", call_id: "c" } } });
  applySessionEvent(state, { seq: 5, type: "tool_state_changed", turn_id: "t", call_id: "c", state: { kind: "running" } });
  applySessionEvent(state, { seq: 6, type: "tool_output_delta", call_id: "c", stream: "stdout", text: "file contents" });
  expect(state.turns.t!.steps[1]).toMatchObject({ name: "read", status: "running", progressTail: "file contents", seq: 1 });
  expect(JSON.parse((state.turns.t!.steps[1] as { argsJson: string }).argsJson)).toEqual({ path: "README.md" });
  applySessionEvent(state, { seq: 7, type: "tool_declared", turn_id: "t", call_id: "without-progress", tool_name: "pwd", args: {} });
  applySessionEvent(state, { seq: 8, type: "message_delta", turn_id: "t", block_id: "after", block_kind: "answer", text: "检查完成" });
  expect(state.turns.t!.steps.map(step => step.id)).toEqual(["before", "c", "without-progress", "after"]);
  expect(state.turns.t!.steps[0]).toMatchObject({ kind: "text", text: "我先读取文件" });
  expect(state.turns.t!.steps[2]).toMatchObject({ kind: "tool", name: "pwd", argsJson: "{}" });
  expect(state.turns.t!.answerStepId).toBe("after");
});

test("exec output offsets ignore duplicate frames and account for a lost range", () => {
  const state = emptySession();
  const session: ExecSessionView = {
    id: "exec-1",
    owner_session_id: "session-1",
    origin_turn_id: "turn-1",
    origin_call_id: "call-1",
    state: { kind: "running" },
    tty: false,
    command: "printf output",
    started_at_ms: 1,
    next_offset: 0,
    output_preview: "",
    preview_start_offset: 0,
    output_complete: false,
    capture_omitted_bytes: 0,
    stream_dropped_bytes: 0,
  };
  applySessionEvent(state, { seq: 1, type: "exec_session_started", session });
  const first = {
    exec_session_id: session.id,
    start_offset: 0,
    end_offset: 3,
    source: "stdout" as const,
    text: "abc",
  };
  applySessionEvent(state, { seq: 2, type: "exec_session_output_delta", ...first });
  applySessionEvent(state, { seq: 3, type: "exec_session_output_delta", ...first });
  applySessionEvent(state, {
    seq: 4,
    type: "exec_session_output_delta",
    exec_session_id: session.id,
    start_offset: 6,
    end_offset: 9,
    source: "stderr",
    text: "jkl",
  });

  expect(state.execSessions[session.id]).toMatchObject({
    output_preview: "abcjkl",
    next_offset: 9,
    stream_dropped_bytes: 3,
  });
});

test("bootstrap associates running exec transcripts by origin call before a tool has yielded", () => {
  const state = emptySession();
  const bootstrap = sessionBootstrap("s", {
    tools: [{ call_id: "c", turn_id: "t", tool_name: "exec_command", args: {},
      state: { kind: "running" }, exec_session_id: null, output: null, output_truncated: false }],
  });
  bootstrap.state.exec_sessions = [{
    id: "e", owner_session_id: "s", origin_turn_id: "t", origin_call_id: "c",
    state: { kind: "running" }, tty: false, command: "echo", started_at_ms: 1,
    next_offset: 3, output_preview: "中", preview_start_offset: 0,
    output_complete: false, capture_omitted_bytes: 0, stream_dropped_bytes: 0,
  }];
  applySessionBootstrap(state, bootstrap);
  expect(state.turns.t!.steps[0]).toMatchObject({ execSessionId: "e", execSession: { output_preview: "中" } });
  applySessionEvent(state, { seq: 1, type: "tool_finished", call_id: "c", outcome: { kind: "completed" },
    output: inline("中"), output_truncated: false, metrics: null });
  expect(state.turns.t!.steps[0]).toMatchObject({ execSessionId: "e", execSession: { output_preview: "中" } });
});

test("forceSealTurn closes a stuck turn and recomputes the running count", () => {
  const state = emptySession();
  applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "stuck", input_id: "in1", mode: "normal" });
  applySessionEvent(state, { seq: 2, type: "message_delta", turn_id: "stuck", block_id: "answer", block_kind: "answer", text: "partial" });
  applySessionEvent(state, { seq: 3, type: "timeline_appended", entry: {
    kind: "assistant_block", data: { turn_id: "stuck", block_id: "answer", block_kind: "answer", content: inline("partial"), model: "m", usage: null },
  } });
  expect(forceSealTurn(state, "stuck", "cancelled")).toBe(true);
  expect(state.turns.stuck).toMatchObject({ status: "aborted", answer: { text: "partial" } });
  expect(state.runningTurns).toBe(0);
});

test("timeline_truncated prunes the recalled turn and everything hanging off it", () => {
  const state = emptySession();
  applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "t1", input_id: "i1", mode: "normal" });
  applySessionEvent(state, { seq: 2, type: "message_delta", turn_id: "t1", block_id: "a1", block_kind: "answer", text: "留下的一条" });
  applySessionEvent(state, { seq: 3, type: "turn_ended", turn_id: "t1", outcome: {
    kind: "finished", data: { terminal: "completed", usage: null, error: null },
  } });
  // 被撤回的回合:工具步、执行会话、未决交互各挂一个,撤回时都得跟着消失——
  // 留着任何一件,UI 就在指向一条后端已经删掉的历史。
  applySessionEvent(state, { seq: 4, type: "turn_started", turn_id: "t2", input_id: "i2", mode: "normal" });
  applySessionEvent(state, { seq: 5, type: "tool_arguments_delta", turn_id: "t2", call_id: "call2", tool_name: "exec_command", text: '{"cmd":"ls"}' });
  applySessionEvent(state, { seq: 6, type: "exec_session_started", session: {
    id: "exec2", owner_session_id: "s", origin_turn_id: "t2", origin_call_id: "call2",
    state: { kind: "running" }, tty: false, command: "ls", started_at_ms: 1,
    next_offset: 0, output_preview: "", preview_start_offset: 0, output_complete: false,
    capture_omitted_bytes: 0, stream_dropped_bytes: 0,
  } });
  applySessionEvent(state, { seq: 7, type: "interaction_requested", interaction: {
    interaction_id: "ask2", kind: "ask", request: inline("选一个"), turn_id: "t2",
  } });
  const slotKeys = () => state.slots.map((slot) => (slot.kind === "turn" ? slot.key : "gap"));
  expect(slotKeys()).toEqual(["t1", "t2"]);

  applySessionEvent(state, { seq: 8, type: "timeline_truncated", from_turn_id: "t2", removed_turn_ids: ["t2"] });

  expect(state.turns.t1).toBeDefined();
  expect(state.turns.t2).toBeUndefined();
  expect(slotKeys()).toEqual(["t1"]);
  expect(state.waits).toEqual([]);
  expect(state.interactionIds).toEqual([]);
  expect(state.execSessions.exec2).toBeUndefined();
  expect(state.runningTurns).toBe(0);
});
