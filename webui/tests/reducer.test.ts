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
        call_id: "call-1", turn_id: "turn-1", tool_name: "read", args: { path: "README.md" }, status: "finished",
        output: inline('{"output":"README.md","exit_code":0}'), output_truncated: false, error: null, metrics: null,
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
  applySessionEvent(state, { seq: 4, type: "tool_started", call_id: "call1" });
  applySessionEvent(state, { seq: 5, type: "tool_finished", call_id: "call1", status: "finished", output: inline('{"output":"ok","exit_code":0}'), output_truncated: false, error: null, metrics: null });
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

test("forceSealTurn closes a stuck turn and recomputes the running count", () => {
  const state = emptySession();
  applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "stuck", input_id: "in1", mode: "normal" });
  applySessionEvent(state, { seq: 2, type: "message_delta", turn_id: "stuck", block_id: "answer", text: "partial" });
  applySessionEvent(state, { seq: 3, type: "timeline_appended", entry: {
    kind: "assistant_block", data: { turn_id: "stuck", block_id: "answer", block_kind: "answer", content: inline("partial"), model: "m", usage: null },
  } });
  expect(forceSealTurn(state, "stuck", "cancelled")).toBe(true);
  expect(state.turns.stuck).toMatchObject({ status: "aborted", answer: { text: "partial" } });
  expect(state.runningTurns).toBe(0);
});
