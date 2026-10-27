import { describe, expect, it } from "vitest";

import {
  answerOf,
  buildAnswers,
  countdownTone,
  formatCountdown,
  isAnswered,
  optionRows,
  parseAsk,
  remainingSec,
  type AskDraft,
  type AskQuestion,
} from "../src/approval/ask-state";

/** 真实落盘载荷(~/.qaqh/ringing/content)的骨架:3 问 batch、选项是长句。 */
const REAL = {
  mode: "batch",
  questions: [
    {
      id: "invalidation",
      question: "「401/40003 → 清凭据 + session-expired」这条链在仓里不存在。怎么处理？",
      options: ["另立项，暂不动（推荐：SIWC 也缺，一起做才对称）", "现在就补：两条路由一起接", "只给 DeepSeek 账号补（我接受不对称）"],
      allow_custom: true,
    },
    { id: "housekeeping", question: "前端 `.qaqh/` 要不要加 .gitignore？", options: ["加进前端 .gitignore（推荐）", "不加，我来处理"], allow_custom: true },
    { id: "commit", question: "现在统一提交吗？", options: ["后端 / 前端各一个提交", "先别提交"], allow_custom: false },
  ],
};

const question = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  id: "q1",
  question: "选哪个？",
  options: ["甲", "乙"],
  allowCustom: true,
  ...over,
});

describe("解析 details", () => {
  it("真实 batch 载荷原样落地,题序与 id 都不重排", () => {
    const model = parseAsk(REAL);
    expect(model.questions.map((item) => item.id)).toEqual(["invalidation", "housekeeping", "commit"]);
    expect(model.questions[0]?.options).toHaveLength(3);
    expect(model.questions[2]?.allowCustom).toBe(false);
  });

  it("缺 id 时按 q1..qn 补,与后端 normalize 的生成器同名", () => {
    const model = parseAsk({ questions: [{ question: "甲?" }, { question: "乙?" }] });
    expect(model.questions.map((item) => item.id)).toEqual(["q1", "q2"]);
  });

  it("allow_custom 缺省为 true(实测 20/20 个 ask 都允许自定义)", () => {
    expect(parseAsk({ questions: [{ id: "a", question: "?", options: [] }] }).questions[0]?.allowCustom).toBe(true);
  });

  it("脏选项被丢掉,但问题留着——不能因为一个空串就少一题", () => {
    const model = parseAsk({ questions: [{ id: "a", question: "?", options: ["甲", "", null, "乙"] }] });
    expect(model.questions[0]?.options).toEqual(["甲", "乙"]);
  });

  it("details 缺字段/形状不对只得到空模型,不抛", () => {
    expect(parseAsk(undefined).questions).toEqual([]);
    expect(parseAsk({ questions: "不是数组" }).questions).toEqual([]);
    expect(parseAsk({ questions: [null] }).questions[0]).toMatchObject({ id: "q1", options: [] });
  });
});

describe("行与答案", () => {
  it("「其它」恒为最后一行;allow_custom=false 时根本没有这一行", () => {
    expect(optionRows(question()).map((row) => row.kind)).toEqual(["option", "option", "custom"]);
    expect(optionRows(question({ allowCustom: false })).every((row) => row.kind === "option")).toBe(true);
  });

  it("空的自定义输入不算已答,填了才算", () => {
    expect(answerOf({ kind: "custom", value: "   " })).toBe("");
    expect(isAnswered({ kind: "custom", value: " 3000 " })).toBe(true);
    expect(answerOf({ kind: "custom", value: " 3000 " })).toBe("3000");
  });

  it("选项原文即答案,不做二次映射", () => {
    expect(answerOf({ kind: "option", value: "不加，我来处理" })).toBe("不加，我来处理");
    expect(answerOf(undefined)).toBe("");
  });
});

describe("提交载荷", () => {
  const questions = parseAsk(REAL).questions;

  it("全答完才产出完整载荷,顺序即题序", () => {
    const draft: AskDraft = {
      commit: { kind: "option", value: "先别提交" },
      invalidation: { kind: "option", value: "现在就补：两条路由一起接" },
      housekeeping: { kind: "custom", value: " 只加 .gitignore " },
    };
    const { answers, missing } = buildAnswers(questions, draft);
    expect(missing).toEqual([]);
    expect(answers).toEqual([
      { question_id: "invalidation", answer: "现在就补：两条路由一起接" },
      { question_id: "housekeeping", answer: "只加 .gitignore" },
      { question_id: "commit", answer: "先别提交" },
    ]);
  });

  it("漏答的题号进 missing,载荷里不留空答案", () => {
    const { answers, missing } = buildAnswers(questions, { invalidation: { kind: "option", value: "另立项，暂不动（推荐：SIWC 也缺，一起做才对称）" } });
    expect(missing).toEqual(["housekeeping", "commit"]);
    expect(answers).toHaveLength(1);
  });

  it("改选「其它」但还没打字 = 未答(旧实现会悄悄回落到上一个选项)", () => {
    const { answers, missing } = buildAnswers(
      [question()],
      { q1: { kind: "custom", value: "" } },
    );
    expect(missing).toEqual(["q1"]);
    expect(answers).toEqual([]);
  });
});

describe("草稿归位", () => {
  it("同一批问题的签名稳定,换一题就变", () => {
    expect(parseAsk(REAL).signature).toBe(parseAsk(REAL).signature);
    const edited = { ...REAL, questions: REAL.questions.map((item, index) => (index === 0 ? { ...item, question: `${item.question}（改）` } : item)) };
    expect(parseAsk(edited).signature).not.toBe(parseAsk(REAL).signature);
  });
});

describe("倒计时", () => {
  it("剩余只减不负,过期恒为 0", () => {
    expect(remainingSec(10_000, 4_000)).toBe(6);
    expect(remainingSec(10_000, 99_000)).toBe(0);
  });

  it("最后一分钟转 warn,归零即 dead", () => {
    expect(countdownTone(61)).toBe("normal");
    expect(countdownTone(60)).toBe("warn");
    expect(countdownTone(1)).toBe("warn");
    expect(countdownTone(0)).toBe("dead");
  });

  it("文本 m:ss,补零", () => {
    expect(formatCountdown(300)).toBe("5:00");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
