/**
 * AskUser 卡的纯状态层:解析 details、答案模型、提交载荷、倒计时档位。
 *
 * 不碰 Solid 也不碰 DOM —— 卡片只负责画,判定逻辑全部在这里,便于 node 环境直测。
 * 旧实现在提交时用 `querySelector('[data-qid]')` 从 DOM 反查勾选,
 * keyed 重挂载会把草稿抹掉,且"文本框覆盖 radio"这件事在界面上看不见。
 */
import type { AskAnswer } from "../api/qaqh/AskAnswer";

export type AskQuestion = {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
};

/** 一问的答案:选项原文,或「其它」行里的自由文本。 */
export type AskSelection =
  | { kind: "option"; value: string }
  | { kind: "custom"; value: string };

export type AskDraft = Record<string, AskSelection | undefined>;

export type AskModel = {
  questions: AskQuestion[];
  /**
   * 草稿跨 challenge 重签发归位用的 key。view 里没有稳定的 interaction id
   * (challenge 一次性,重签发就换 id),只能拿问题集合本身当签名。
   */
  signature: string;
};

/** 一行的落点:一个选项,或「其它」这条合成行。 */
export type AskRow = { kind: AskSelection["kind"]; value: string };

/**
 * 归一化网关 details。后端 `normalize_ask_user` 已保证 id 非空且唯一、
 * 选项去空白、"无选项必允许自定义";这里只兜形状(缺字段/非字符串),不做二次校验。
 * details.mode 由后端按 questions.length 推导,布局直接看长度即可,不必再读它。
 */
export function parseAsk(details: Record<string, unknown> | undefined): AskModel {
  const raw = Array.isArray(details?.questions) ? details.questions : [];
  const questions: AskQuestion[] = [];
  raw.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const options = Array.isArray(item.options)
      // 只收字符串:后端 normalize 已保证选项非空非重复,这里只挡 `String(null)==="null"`
      // 这种把脏值渲染成可选答案的形态。
      ? item.options.filter((option): option is string => typeof option === "string" && option.trim() !== "")
      : [];
    questions.push({
      id: item.id != null && String(item.id).trim() !== "" ? String(item.id) : `q${index + 1}`,
      question: String(item.question ?? ""),
      options,
      allowCustom: item.allow_custom !== false,
    });
  });
  return { questions, signature: questions.map((q) => `${q.id}\u0000${q.question}`).join("\u0001") };
}

/** 当前问题的可选行;`allow_custom` 时「其它」恒为最后一行,与选项互斥。 */
export function optionRows(question: AskQuestion): AskRow[] {
  const rows: AskRow[] = question.options.map((value) => ({ kind: "option", value }));
  if (question.allowCustom) rows.push({ kind: "custom", value: "" });
  return rows;
}

/** 落进载荷的答案文本;空的自定义输入不算已答。 */
export function answerOf(selection: AskSelection | undefined): string {
  if (selection == null) return "";
  return selection.kind === "custom" ? selection.value.trim() : selection.value;
}

export function isAnswered(selection: AskSelection | undefined): boolean {
  return answerOf(selection) !== "";
}

/** 载荷按问题原序构造;`missing` 是还没答的题号,用于跳过去。 */
export function buildAnswers(
  questions: AskQuestion[],
  draft: AskDraft,
): { answers: AskAnswer[]; missing: string[] } {
  const answers: AskAnswer[] = [];
  const missing: string[] = [];
  for (const question of questions) {
    const answer = answerOf(draft[question.id]);
    if (answer === "") missing.push(question.id);
    else answers.push({ question_id: question.id, answer });
  }
  return { answers, missing };
}

/** 剩余整秒;永不返回负数,过期后恒为 0。 */
export function remainingSec(expiresAtMs: number, atMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - atMs) / 1000));
}

export type CountdownTone = "normal" | "warn" | "dead";

/** 只剩一分钟起转 warn;0 秒是 dead —— 此时 challenge 必已被 TTL 清掉。 */
export function countdownTone(remaining: number): CountdownTone {
  if (remaining <= 0) return "dead";
  return remaining <= 60 ? "warn" : "normal";
}

/** `m:ss`;超过一小时的 TTL 也放得下。 */
export function formatCountdown(remaining: number): string {
  const safe = Math.max(0, remaining);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
