/**
 * ord 权威排序回归:重连丢帧后迟到的 reasoning seal 必须插回 answer 之前,
 * 而非按到达序追加到答案之下(「思考链落到最终作答之下」的根因修复)。
 * ord 来自后端 blocks.ord,经 timeline_appended 携带;message_delta(流式未 seal)无 ord。
 */
import { describe, expect, it } from "vitest";
import { applySessionEvent, emptySession } from "../src/session/reducer";
import type { SessionEventFrame } from "../src/api/contract";
import type { SessionState } from "../src/session/types";

const delta = (seq: number, block: string, kind: "reasoning" | "answer", text: string): SessionEventFrame =>
  ({ seq, type: "message_delta", turn_id: "T1", block_id: block, block_kind: kind, text });

const sealed = (seq: number, block: string, kind: "reasoning" | "answer", ord: number, text: string): SessionEventFrame =>
  ({
    seq,
    type: "timeline_appended",
    entry: {
      kind: "assistant_block",
      data: {
        block_id: block, turn_id: "T1", ord, block_kind: kind,
        content: { kind: "inline", data: { text } },
        model: "m", usage: null, generated_ms: null, opaque: [],
      },
    },
  });

const stepsOf = (draft: SessionState): string[] => {
  const turn = Object.values(draft.turns).find((t) => t.id === "T1");
  return (turn?.steps ?? []).map((s) => s.id);
};

describe("reducer assistant-block ord ordering", () => {
  it("重连竞态:answer 先在流(无 ord),迟到的 reasoning seal 插回其前", () => {
    const draft = emptySession();
    applySessionEvent(draft, delta(0, "A", "answer", "answer text"));
    applySessionEvent(draft, sealed(1, "R", "reasoning", 1, "thinking"));
    applySessionEvent(draft, sealed(2, "A", "answer", 2, "answer text"));
    expect(stepsOf(draft)).toEqual(["R", "A"]);
  });

  it("正常流式序保持:reasoning 先于 answer", () => {
    const draft = emptySession();
    applySessionEvent(draft, delta(0, "R", "reasoning", "think"));
    applySessionEvent(draft, delta(1, "A", "answer", "ans"));
    applySessionEvent(draft, sealed(2, "R", "reasoning", 1, "think"));
    applySessionEvent(draft, sealed(3, "A", "answer", 2, "ans"));
    expect(stepsOf(draft)).toEqual(["R", "A"]);
  });

  it("多块按 ord 全序:迟到的中间 reasoning 插到正确位置", () => {
    const draft = emptySession();
    applySessionEvent(draft, sealed(0, "R1", "reasoning", 1, "r1"));
    applySessionEvent(draft, sealed(1, "A", "answer", 4, "ans"));
    // R2(ord2)/R3(ord3)迟到,必须落在 R1 与 A 之间且彼此有序
    applySessionEvent(draft, sealed(2, "R3", "reasoning", 3, "r3"));
    applySessionEvent(draft, sealed(3, "R2", "reasoning", 2, "r2"));
    expect(stepsOf(draft)).toEqual(["R1", "R2", "R3", "A"]);
  });
});