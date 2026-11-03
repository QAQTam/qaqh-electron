/**
 * Ringing v2 reducer 单元测试 (SPEC-2026-10-29-PURGE):
 * 验证 applyConversationSnapshot 与 applyConversationDelta 纯血单流状态机。
 */
import { describe, expect, test } from "vitest";
import {
  applyConversationDelta,
  applyConversationSnapshot,
  contentValueToText,
  emptySession,
  forceSealTurn,
  normalizeToolStatus,
  outputFromDisplay,
  parseJsonish,
  parseToolOutput,
  recomputeDerived,
} from "../src/session/reducer";
import type { ConversationSnapshot } from "../src/api/qaqh/ConversationSnapshot";
import type { ConversationDelta } from "../src/api/qaqh/ConversationDelta";

describe("outputFromDisplay & parseToolOutput", () => {
  test("显式 body:none 不应复活旧输出；缺失/unknown 仍兼容 legacy", () => {
    const legacy = { text: "raw stdout", stderr: "raw stderr" };
    expect(outputFromDisplay({ body: { kind: "none" } }, legacy)).toBeUndefined();
    expect(outputFromDisplay(undefined, legacy)).toBe(legacy);
    expect(outputFromDisplay({ body: { kind: "unknown" } }, legacy)).toBe(legacy);
  });

  test("streams 与 shell 输出投影解析", () => {
    const streamsOut = outputFromDisplay({
      body: { kind: "streams", stdout: "hello stdout", stderr: "some error", exit_code: 1, truncated: false },
    }, undefined);
    expect(streamsOut).toMatchObject({
      text: "hello stdout",
      stderr: "some error",
      exitCode: 1,
      truncated: false,
    });

    const shellOut = outputFromDisplay({
      body: { kind: "shell", output: "ok", exit_code: 0, truncated: false },
    }, undefined);
    expect(shellOut).toMatchObject({ text: "ok", exitCode: 0 });
  });

  test("parseToolOutput 解析 JSON、统一 diff 与标准流", () => {
    const jsonOutput = JSON.stringify({ output: "parsed out", exit_code: 0, diff: "--- a\n+++ b" });
    expect(parseToolOutput(jsonOutput)).toMatchObject({
      text: "parsed out",
      exitCode: 0,
      diffText: "--- a\n+++ b",
    });

    const rawDiff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
    expect(parseToolOutput(rawDiff)).toMatchObject({
      diffText: rawDiff,
    });
  });

  test("normalizeToolStatus 状态映射", () => {
    expect(normalizeToolStatus("succeeded")).toBe("success");
    expect(normalizeToolStatus("failed")).toBe("error");
    expect(normalizeToolStatus("cancelled")).toBe("aborted");
    expect(normalizeToolStatus("denied")).toBe("denied");
    expect(normalizeToolStatus("backgrounded")).toBe("backgrounded");
    expect(normalizeToolStatus("prepared")).toBe("pending");
    expect(normalizeToolStatus("running")).toBe("running");
  });

  test("contentValueToText 转换", () => {
    expect(contentValueToText({ kind: "inline", data: { text: "hello" } })).toBe("hello");
    expect(contentValueToText({ kind: "ref", data: { content_ref: "sha256:abc" } })).toBe("");
    expect(contentValueToText({ kind: "unavailable", data: { reason: "lost" } })).toBe("正文不可用");
    expect(contentValueToText(null)).toBe("");
  });
});

describe("applyConversationSnapshot (全量快照物化)", () => {
  test("物化完整对话历史：回合、输入、思考过程、工具调用与结果、作答", () => {
    const state = emptySession();
    const snapshot: ConversationSnapshot = {
      session_id: "session-1",
      revision: 4,
      last_fact_seq: 10,
      compaction: null,
      current_turn_id: null,
      turns: [
        {
          turn_id: "turn-1",
          input_id: "in-1",
          mode: "normal",
          recovery_ref: null,
          outcome: {
            kind: "finished",
            data: { terminal: "completed", usage: null, error: null },
          },
        },
      ],
      context: [
        {
          source_fact_seq: 1,
          kind: {
            kind: "input",
            data: {
              input_id: "in-1",
              input_kind: "user_text",
              input_purpose: "trigger_turn",
              content: { kind: "inline", data: { text: "帮我检查代码" } },
              attachments: [],
              actor: { kind: "user", id: "u1", display_name: "Alice" },
            },
          },
        },
        {
          source_fact_seq: 2,
          kind: {
            kind: "assistant_block",
            data: {
              turn_id: "turn-1",
              block_id: "blk-thinking",
              block_kind: "reasoning",
              content: { kind: "inline", data: { text: "思考一下项目结构..." } },
              model: "claude-3-7-sonnet",
              usage: null,
            },
          },
        },
        {
          source_fact_seq: 3,
          kind: {
            kind: "tool_call",
            data: {
              call_id: "call-1",
              turn_id: "turn-1",
              tool_name: "read",
              args: { kind: "inline", data: { text: JSON.stringify({ path: "README.md" }) } },
              args_hash: "hash-1",
              result: {
                terminal_status: "succeeded",
                output: { kind: "inline", data: { text: "# README\nProject Docs" } },
                error: null,
                metrics: { started_at_ms: 1000, finished_at_ms: 1050, retry_count: 0, output_bytes: 50, progress_bytes_total: 50 },
                reconciled: false,
              },
            },
          },
        },
        {
          source_fact_seq: 4,
          kind: {
            kind: "assistant_block",
            data: {
              turn_id: "turn-1",
              block_id: "blk-answer",
              block_kind: "answer",
              content: { kind: "inline", data: { text: "README 已检查，一切正常。" } },
              model: "claude-3-7-sonnet",
              usage: null,
            },
          },
        },
      ],
    };

    applyConversationSnapshot(state, snapshot);

    expect(state.slots).toHaveLength(1);
    const turn = state.turns["turn-1"]!;
    expect(turn).toBeDefined();
    expect(turn.status).toBe("done");
    expect(turn.user.text).toBe("帮我检查代码");
    expect(turn.steps).toHaveLength(3);

    // 思考步骤
    expect(turn.steps[0]).toMatchObject({
      kind: "thinking",
      id: "blk-thinking",
      text: "思考一下项目结构...",
    });

    // 工具步骤
    expect(turn.steps[1]).toMatchObject({
      kind: "tool",
      id: "call-1",
      name: "read",
      status: "success",
      elapsedMs: 50,
      output: { text: "# README\nProject Docs" },
    });

    // 正文步骤
    expect(turn.steps[2]).toMatchObject({
      kind: "text",
      id: "blk-answer",
      text: "README 已检查，一切正常。",
    });
    expect(turn.answer?.text).toBe("README 已检查，一切正常。");
    expect(turn.answerStepId).toBe("blk-answer");

    expect(state.runningTurns).toBe(0);
    expect(state.failedTurns).toBe(0);
  });

  test("失败回合在快照中正确记录错误信息", () => {
    const state = emptySession();
    const snapshot: ConversationSnapshot = {
      session_id: "session-2",
      revision: 1,
      last_fact_seq: 2,
      compaction: null,
      current_turn_id: null,
      turns: [
        {
          turn_id: "turn-fail",
          input_id: "in-2",
          mode: "normal",
          recovery_ref: null,
          outcome: {
            kind: "finished",
            data: {
              terminal: "failed",
              usage: null,
              error: { code: "context_overflow", message: "上下文超出模型窗口限制" },
            },
          },
        },
      ],
      context: [],
    };

    applyConversationSnapshot(state, snapshot);
    const turn = state.turns["turn-fail"]!;
    expect(turn.status).toBe("failed");
    expect(turn.error?.message).toBe("上下文超出模型窗口限制");
    expect(state.failedTurns).toBe(1);
  });
});

describe("applyConversationDelta (单流增量驱动)", () => {
  test("完整回合原子生命周期：input_accepted -> turn_started -> tool declared/finished -> assistant block sealed -> turn_finished", () => {
    const state = emptySession();

    // 1. 用户输入落地
    applyConversationDelta(state, {
      kind: "input_accepted",
      data: {
        revision: 1,
        input_id: "input-01",
        input_kind: "user_text",
        input_purpose: "trigger_turn",
        content: { kind: "inline", data: { text: "请执行测试" } },
        attachments: [],
        actor: { kind: "user", id: "user-1", display_name: "Bob" },
      },
    });

    expect(state.slots).toHaveLength(1);
    expect(state.runningTurns).toBe(1);
    const initialTurnKey = state.slots[0]!.key;
    expect(state.turns[initialTurnKey]!.user.text).toBe("请执行测试");
    expect(state.turns[initialTurnKey]!.status).toBe("running");

    // 2. 回合开启，绑定正式 turn_id
    applyConversationDelta(state, {
      kind: "turn_started",
      data: {
        revision: 2,
        turn_id: "turn-real-01",
        input_id: "input-01",
        mode: "normal",
      },
    });

    expect(state.slots).toHaveLength(1);
    expect(state.turns["turn-real-01"]).toBeDefined();
    expect(state.turns["turn-real-01"]!.id).toBe("turn-real-01");
    expect(state.turns["turn-real-01"]!.user.text).toBe("请执行测试");
    expect(state.turns["turn-real-01"]!.status).toBe("running");

    // 3. 思考块密封
    applyConversationDelta(state, {
      kind: "assistant_block_sealed",
      data: {
        revision: 3,
        turn_id: "turn-real-01",
        block_id: "blk-think-1",
        block_kind: "reasoning",
        content: { kind: "inline", data: { text: "准备调用 cargo test 命令" } },
        model: "model-x",
        usage: null,
      },
    });

    let turn = state.turns["turn-real-01"]!;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]).toMatchObject({
      kind: "thinking",
      id: "blk-think-1",
      text: "准备调用 cargo test 命令",
    });

    // 4. 工具意图声明
    applyConversationDelta(state, {
      kind: "tool_call_declared",
      data: {
        revision: 4,
        turn_id: "turn-real-01",
        call_id: "call-exec-1",
        tool_name: "exec",
        args: { kind: "inline", data: { text: JSON.stringify({ command: "cargo test" }) } },
        args_hash: "hash-exec",
      },
    });

    turn = state.turns["turn-real-01"]!;
    expect(turn.steps).toHaveLength(2);
    expect(turn.steps[1]).toMatchObject({
      kind: "tool",
      id: "call-exec-1",
      name: "exec",
      status: "running",
    });

    // 5. 工具执行完成
    applyConversationDelta(state, {
      kind: "tool_finished",
      data: {
        revision: 5,
        call_id: "call-exec-1",
        terminal_status: "succeeded",
        output: { kind: "inline", data: { text: "test result: ok. 10 passed" } },
        error: null,
        metrics: { started_at_ms: 100, finished_at_ms: 300, retry_count: 0, output_bytes: 27, progress_bytes_total: 27 },
        reconciled: false,
      },
    });

    turn = state.turns["turn-real-01"]!;
    expect(turn.steps[1]).toMatchObject({
      kind: "tool",
      id: "call-exec-1",
      status: "success",
      elapsedMs: 200,
      output: { text: "test result: ok. 10 passed" },
    });

    // 6. 模型回复正文密封
    applyConversationDelta(state, {
      kind: "assistant_block_sealed",
      data: {
        revision: 6,
        turn_id: "turn-real-01",
        block_id: "blk-ans-1",
        block_kind: "answer",
        content: { kind: "inline", data: { text: "测试全部通过！" } },
        model: "model-x",
        usage: null,
      },
    });

    turn = state.turns["turn-real-01"]!;
    expect(turn.steps).toHaveLength(3);
    expect(turn.answer?.text).toBe("测试全部通过！");
    expect(turn.answerStepId).toBe("blk-ans-1");

    // 7. 回合收尾终态
    applyConversationDelta(state, {
      kind: "turn_finished",
      data: {
        revision: 7,
        turn_id: "turn-real-01",
        terminal: "completed",
        usage: null,
        error: null,
      },
    });

    turn = state.turns["turn-real-01"]!;
    expect(turn.status).toBe("done");
    expect(state.runningTurns).toBe(0);
  });

  test("回合中断 turn_interrupted 标记 aborted 状态", () => {
    const state = emptySession();
    applyConversationDelta(state, {
      kind: "turn_started",
      data: { revision: 1, turn_id: "t-abort", input_id: "in-abort", mode: "normal" },
    });
    expect(state.runningTurns).toBe(1);

    applyConversationDelta(state, {
      kind: "turn_interrupted",
      data: {
        revision: 2,
        turn_id: "t-abort",
        reason: "user_cancel",
        last_fact_seq: 5,
        recovery_ref: "rec-1",
      },
    });

    expect(state.turns["t-abort"]!.status).toBe("aborted");
    expect(state.runningTurns).toBe(0);
  });
});

describe("forceSealTurn", () => {
  test("就地收口 running 回合并提升最后文本块为 answer", () => {
    const state = emptySession();
    state.turns["t1"] = {
      id: "t1",
      key: "t1",
      turnIndex: null,
      user: { text: "hi" },
      steps: [{ kind: "text", id: "step-1", seq: 0, text: "output text" }],
      answer: null,
      answerStepId: null,
      status: "running",
      expanded: false,
    };
    state.slots.push({ kind: "turn", key: "t1" });
    state.runningTurns = 1;

    expect(forceSealTurn(state, "t1", "completed")).toBe(true);
    expect(state.turns["t1"]!.status).toBe("done");
    expect(state.turns["t1"]!.answer?.text).toBe("output text");
    expect(state.runningTurns).toBe(0);
  });
});
