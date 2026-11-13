/**
 * 交接（handoff）链路的归约与事实层测试。
 *
 * 对位施工单 §三（渲染要新增识别的两个值）与 §一（识别交接交接）：
 * 看门狗提醒按**普通 input 条目**进 timeline（`purpose:"interject"` +
 * `actor.kind:"api"`），它是"最容易出问题的接缝"——所以这里断言的是
 * 「用户原话还在、插话另立一行、标签不是用户」，而不是快照里某个字符串。
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

// 与其余 UI 用例同一套：不指向 dev 构建时 `@solidjs/web` 会解析到 server 构建。
vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { applySessionBootstrap, applySessionEvent, emptySession } from "../src/session/reducer";
import { handoffFactsOfTurn, handoffFactOfToolCall, type HandoffFact } from "../src/session/handoff";
import { interjectionLabel, isSystemInterjection } from "../src/turn/interjection";
import { turnSegments } from "../src/turn/segments";
import { sessionBootstrap, inline } from "./session-fixtures";
import type { InterjectionStep, Step, ToolStep, Turn } from "../src/session/types";
import type { TimelineEntry } from "../src/api/qaqh/TimelineEntry";

/** 后端 `handoff.rs::success_output` 的形状：前半句人话 + 尾部 fenced JSON。 */
const REPORT = {
  handed_off: true,
  from_session_id: "ses_01AAA",
  turn_id: "turn_01BBB",
  work_summary: "把交接链路接通",
  handoff_doc: "## 当前任务\n继续 §七 的第 1 条自测。",
  handoff_path: "C:\\Users\\QAQTam\\.qaqh\\sessions\\ses_01AAA\\handoff\\handoff-11-10-190233.md",
  modified_files: ["webui/src/session/reducer.ts"],
  context_used_tokens: 960,
  context_window_tokens: 1000,
};
const SEALED = `已封箱交接。本会话到此为止，余下的路由到新开的那条线去谈。\n\n\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``;

const userTurn = (text: string): Turn => ({
  id: "turn_1",
  inputId: null,
  key: "turn_1",
  turnIndex: null,
  user: { text },
  steps: [],
  answer: null,
  answerStepId: null,
  status: "running",
  expanded: false,
});

const watchdogEntry = (blockId: string, text = "[系统] 上下文占用 96%（960 / 1000 tokens）本轮必须调用 handoff 写交接文档"): TimelineEntry => ({
  kind: "input",
  data: {
    block_id: blockId,
    turn_id: "turn_1",
    purpose: "interject",
    content: inline(text),
    attachments: [],
    actor: { kind: "api", id: "handoff-watchdog", display_name: "上下文看门狗" },
  },
});

const primaryEntry = (text = "帮我把测试跑通"): TimelineEntry => ({
  kind: "input",
  data: {
    block_id: "block_primary",
    turn_id: "turn_1",
    purpose: "trigger_turn",
    content: inline(text),
    attachments: [],
    actor: { kind: "user", id: "user", display_name: null },
  },
});

function turnOf(state: ReturnType<typeof emptySession>): Turn {
  const turn = state.turns.turn_1;
  if (turn == null) throw new Error("回合未落地");
  return turn;
}

function interjects(turn: Turn): InterjectionStep[] {
  return turn.steps.filter((step): step is InterjectionStep => step.kind === "interject");
}

describe("插话条目（看门狗 / 用户转向）", () => {
  test("实时路径：api actor 的 interject 不顶掉用户原话，另立一行系统插话", () => {
    const state = emptySession();
    applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "turn_1", input_id: "in_1", mode: "normal" });
    applySessionEvent(state, { seq: 2, type: "timeline_appended", entry: primaryEntry() });
    applySessionEvent(state, { seq: 3, type: "timeline_appended", entry: watchdogEntry("block_watchdog") });

    const turn = turnOf(state);
    // 用户原话必须还在：这是本条改动要防的第一种坏法。
    expect(turn.user.text).toBe("帮我把测试跑通");
    expect(turn.user.blockId).toBe("block_primary");
    const [interjection] = interjects(turn);
    expect(interjection).toMatchObject({
      kind: "interject",
      id: "block_watchdog",
      purpose: "interject",
      actorKind: "api",
      actorId: "handoff-watchdog",
      actorName: "上下文看门狗",
    });
    // 名字不能是"用户"，也不能是通用"系统插话"——display_name 给得更准。
    expect(isSystemInterjection(interjection!)).toBe(true);
    expect(interjectionLabel(interjection!)).toBe("上下文看门狗");
  });

  test("bootstrap 重放同一条 input 不产生第二行，正文就地更新", () => {
    const state = emptySession();
    applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "turn_1", input_id: "in_1", mode: "normal" });
    applySessionEvent(state, { seq: 2, type: "timeline_appended", entry: primaryEntry() });
    applySessionEvent(state, { seq: 3, type: "timeline_appended", entry: watchdogEntry("block_watchdog") });
    applySessionEvent(state, {
      seq: 4,
      type: "timeline_appended",
      entry: {
        ...watchdogEntry("block_watchdog"),
        data: { ...watchdogEntry("block_watchdog").data, content: inline("[系统] 上下文占用 99%（990 / 1000 tokens）") },
      },
    });

    const turn = turnOf(state);
    expect(interjects(turn)).toHaveLength(1);
    expect(interjects(turn)[0]!.text).toContain("99%");
    expect(turn.user.text).toBe("帮我把测试跑通");
  });

  test("用户自己的 steer 也是插话行，主输入不变；标签与系统插话分得开", () => {
    const state = emptySession();
    applySessionEvent(state, { seq: 1, type: "turn_started", turn_id: "turn_1", input_id: "in_1", mode: "normal" });
    applySessionEvent(state, { seq: 2, type: "timeline_appended", entry: primaryEntry() });
    applySessionEvent(state, {
      seq: 3,
      type: "timeline_appended",
      entry: {
        kind: "input",
        data: {
          block_id: "block_steer",
          turn_id: "turn_1",
          purpose: "steer",
          content: inline("先别动 lockfile"),
          attachments: [],
          actor: { kind: "user", id: "user", display_name: null },
        },
      },
    });

    const turn = turnOf(state);
    expect(turn.user.text).toBe("帮我把测试跑通");
    const steer = interjects(turn)[0]!;
    expect(steer).toMatchObject({ id: "block_steer", purpose: "steer", actorKind: "user" });
    expect(isSystemInterjection(steer)).toBe(false);
    expect(interjectionLabel(steer)).toBe("插话转向");
  });

  test("权威快照走同一条判定（bootstrap 与实时不分叉）", () => {
    const state = emptySession();
    applySessionBootstrap(state, sessionBootstrap("ses_A", {
      turns: [{ turn_id: "turn_1", outcome: { kind: "finished", data: { terminal: "completed", usage: null, error: null } } }],
      timeline: [primaryEntry(), watchdogEntry("block_watchdog")],
    }));
    const turn = turnOf(state);
    expect(turn.user.text).toBe("帮我把测试跑通");
    expect(interjects(turn)).toHaveLength(1);
  });

  test("只有看门狗开口时不造空的回合，插话单独成段不折进「已工作」", () => {
    const turn = userTurn("");
    turn.steps.push({
      kind: "interject",
      id: "block_watchdog",
      seq: 0,
      purpose: "interject",
      actorKind: "api",
      actorId: "handoff-watchdog",
      text: "[系统] 上下文占用 96%",
    });
    turn.steps.push({ kind: "tool", id: "call_handoff", seq: 1, name: "handoff", status: "running" } satisfies Step);
    const segments = turnSegments(turn.steps, false);
    expect(segments.map((segment) => segment.kind)).toEqual(["interject", "work"]);
  });
});

describe("交接事实识别（判据只有 tool_name + handed_off）", () => {
  const toolStep = (overrides: Partial<ToolStep> = {}): ToolStep => ({
    kind: "tool",
    id: "call_handoff",
    seq: 0,
    name: "handoff",
    argsJson: JSON.stringify({ handoff_doc: "ARGS 那份文档", work_summary: "ARGS 那份简述" }),
    status: "finished",
    output: { text: SEALED },
    ...overrides,
  });

  test("封箱结果：id 从 output 取，文档优先用 args 那份", () => {
    const fact = handoffFactOfToolCall(toolStep(), { sessionId: "ses_local", turnId: "turn_local" });
    expect(fact).not.toBeNull();
    expect(fact).toMatchObject({
      key: `${REPORT.from_session_id}|${REPORT.turn_id}`,
      fromSessionId: REPORT.from_session_id,
      turnId: REPORT.turn_id,
      // args（结构化那份）优先于 output 里的冗余字段。
      handoffDoc: "ARGS 那份文档",
      workSummary: "ARGS 那份简述",
      modifiedFiles: ["webui/src/session/reducer.ts"],
      contextUsedTokens: 960,
      contextWindowTokens: 1000,
    });
  });

  test("同回合重复调用只回人话：读不出机器面就退回推断，key 仍是同一条", () => {
    const fact = handoffFactOfToolCall(toolStep({ output: { text: `这一回合已经交接过了（${REPORT.from_session_id}），不再重复封箱。` } }), {
      sessionId: "ses_local",
      turnId: "turn_local",
    });
    // 推断那份不冒充机器面：路径/台账这些只有 output 里才有的字段一律为空。
    expect(fact).toMatchObject({
      key: "ses_local|turn_local",
      inferred: true,
      handoffPath: null,
      modifiedFiles: [],
      contextUsedTokens: null,
    });
    // 首封与重复调用落在同一个会话同一个回合 → 同一把 key → 回合里只有一条事实,
    // 也就只允许 fork 一次(§一·3)。
    const turn = {
      id: REPORT.turn_id, key: REPORT.turn_id, inputId: null, turnIndex: null,
      user: { text: "帮我把测试跑通" }, status: "done", expanded: false,
      answer: null, answerStepId: null,
      steps: [
        toolStep({ id: "call_sealed" }),
        toolStep({ id: "call_dup", output: { text: "这一回合已经交接过了，不再重复封箱。" } }),
      ],
    } as unknown as Turn;
    const facts = handoffFactsOfTurn(turn, REPORT.from_session_id);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.inferred).toBe(false);
    expect(facts[0]!.callId).toBe("call_sealed");
  });

  test("交接文档自己带代码栅栏时机器面照样读得出来（按配平取，不按栅栏切）", () => {
    const docWithFence = "先跑测试:\n\n```bash\npnpm test\n```\n\n坑：`{}` 出现在正文里也不该影响解析。";
    const report = { ...REPORT, handoff_doc: docWithFence };
    const output = `已封箱交接。\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
    const fact = handoffFactOfToolCall(toolStep({ argsJson: JSON.stringify({ handoff_doc: docWithFence, work_summary: "带栅栏的交接" }), output: { text: output } }), {
      sessionId: "ses_local",
      turnId: "turn_local",
    });
    expect(fact).toMatchObject({ inferred: false, handoffDoc: docWithFence, turnId: REPORT.turn_id });
  });

  test("handoff_invalid_args / write_failed 走 status error，没有封箱 JSON 就不成立", () => {
    expect(handoffFactOfToolCall(toolStep({ status: "failed", error: "handoff 缺少 `handoff_doc` 字段", output: undefined }), {
      sessionId: "ses_local",
      turnId: "turn_local",
    })).toBeNull();
  });

  test("非 handoff 工具即使带 handed_off 字样也不算（判据不放宽）", () => {
    expect(handoffFactOfToolCall(toolStep({ name: "read", argsJson: "{}" }), { sessionId: "s", turnId: "t" })).toBeNull();
  });

  test("只有 output 里没有 args 时退回冗余那份（老路径兜底）", () => {
    const fact = handoffFactOfToolCall(toolStep({ argsJson: undefined }), { sessionId: "s", turnId: "t" });
    expect(fact!.handoffDoc).toBe(REPORT.handoff_doc);
  });

  test("回合尾部入口：事实从已加载状态重建（数据全在 timeline，离线可用）", () => {
    const state = emptySession();
    applySessionBootstrap(state, sessionBootstrap(REPORT.from_session_id, {
      turns: [{ turn_id: REPORT.turn_id, outcome: { kind: "finished", data: { terminal: "completed", usage: null, error: null } } }],
      timeline: [
        primaryEntry(),
        { kind: "tool_call", data: { turn_id: REPORT.turn_id, call_id: "call_handoff" } },
      ],
      tools: [{
        call_id: "call_handoff",
        turn_id: REPORT.turn_id,
        tool_name: "handoff",
        args: { handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary },
        state: { kind: "finished", outcome: { kind: "completed" } },
        output: inline(SEALED),
        output_truncated: false,
        metrics: null,
      }],
    }));
    const turn = state.turns[REPORT.turn_id]!;
    const facts: HandoffFact[] = handoffFactsOfTurn(turn, REPORT.from_session_id);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe(`${REPORT.from_session_id}|${REPORT.turn_id}`);
  });

  test("占用页脚不落库：转录里没有 [#ctx …] 也照样读得出交接事实", () => {
    // 那条页脚只进发给模型的投影。前端不靠它判交接，也不该在 transcript 里找它。
    const step = toolStep({ output: { text: SEALED.replace(/\[#ctx[^\]]*\]/g, "") } });
    expect(handoffFactOfToolCall(step, { sessionId: "s", turnId: "t" })).not.toBeNull();
  });
});

describe("交接账本(升级前旧数据的只读遗留,ADR-016)", () => {
  beforeEach(() => {
    for (const key of Object.keys(localStorage)) localStorage.removeItem(key);
    localStorage.clear();
  });

  test("升级前写入的 localStorage fork 记录仍读得出 child→parent(徽标兼容兜底)", async () => {
    localStorage.setItem(`qaqh.handoff.fork.${REPORT.from_session_id}|${REPORT.turn_id}`, JSON.stringify({
      from_session_id: REPORT.from_session_id,
      turn_id: REPORT.turn_id,
      child_session_id: "ses_CHILD",
      delivered: true,
      work_summary: REPORT.work_summary,
      at_ms: 1_700_000_000_000,
    }));
    vi.resetModules();
    const reopened = await import("../src/session/handoff-journal");
    expect(reopened.parentSessionOf("ses_CHILD")).toBe(REPORT.from_session_id);
  });
});
