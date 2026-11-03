/** Pagination and window eviction logic over v3-materialized turns. */
import { describe, expect, test } from "vitest";
import { anchorScrollTop, clampPlaceholderHeight, evictForWindow, fillGapHeights, shouldLoadOlder } from "../src/session/pagination";
import { applySessionBootstrap, emptySession, recomputeDerived } from "../src/session/reducer";
import { gapHeight, type SessionState } from "../src/session/types";
import { inline, sessionBootstrap } from "./session-fixtures";

const spansOf = (state: SessionState): string[] => {
  const gap = state.slots.find((slot) => slot.kind === "gap");
  return gap?.kind === "gap" ? gap.spans.map((span) => span.key) : [];
};
const turnKeys = (state: SessionState): string[] => state.slots.filter((slot) => slot.kind === "turn").map((slot) => slot.key);
const gapCount = (state: SessionState): number => state.slots.filter((slot) => slot.kind === "gap").length;

function stateWith(count: number, runningLast = false) {
  const state = emptySession();
  applySessionBootstrap(state, sessionBootstrap("test", {
    seq: count,
    currentTurnId: runningLast ? `#${count - 1}` : null,
    turns: Array.from({ length: count }, (_, index) => ({
      turn_id: `#${index}`,
      input_id: `in${index}`,
      mode: "normal",
      outcome: runningLast && index === count - 1 ? null : {
        kind: "finished" as const,
        data: { terminal: "completed" as const, usage: null, error: null },
      },
    })),
    timeline: Array.from({ length: count }, (_, index) => ({
      kind: "input" as const,
      data: {
        block_id: `input-${index}`,
        turn_id: `#${index}`,
        purpose: "trigger_turn" as const,
        content: inline(`u${index}`),
        attachments: [],
        actor: { kind: "user" as const, id: `u${index}`, display_name: null },
      },
    })),
  }));
  return state;
}

describe("anchorScrollTop / shouldLoadOlder", () => {
  test("preserves the visible position after prepending a page", () => {
    expect(anchorScrollTop(100, 5_000, 6_200)).toBe(1_300);
    expect(anchorScrollTop(100, 6_200, 6_200)).toBe(100);
  });

  test("loads older turns within the viewport threshold", () => {
    expect(shouldLoadOlder(700, 500, true, false)).toBe(true);
    expect(shouldLoadOlder(760, 500, true, false)).toBe(false);
    expect(shouldLoadOlder(0, 500, false, false)).toBe(false);
    expect(shouldLoadOlder(0, 500, true, true)).toBe(false);
  });
});

describe("evictForWindow", () => {
  test("evicts only distant completed turns into one gap", () => {
    const state = stateWith(4);
    const offsetTopOf = (key: string): number => Number(key.replace("#", "")) * 1000;
    expect(evictForWindow(state, 2, 2, offsetTopOf, 3_500, 500)).toEqual(["#0", "#1"]);
    expect(state.slots).toHaveLength(3);
    expect(state.slots[0]).toMatchObject({ kind: "gap", key: "gap:#0", spans: [{ key: "#0" }, { key: "#1" }] });
    expect(turnKeys(state)).toEqual(["#2", "#3"]);
    expect(state.turns["#0"]).toBeUndefined();
    expect(state.turns["#1"]).toBeUndefined();
  });

  test("subsequent eviction extends the same gap and key", () => {
    const state = stateWith(5);
    const offsetTopOf = (key: string): number => Number(key.replace("#", "")) * 1000;
    evictForWindow(state, 3, 2, offsetTopOf, 3_500, 500);
    const firstGapKey = state.slots[0]!.key;
    evictForWindow(state, 2, 2, offsetTopOf, 4_500, 500);
    expect(gapCount(state)).toBe(1);
    expect(state.slots[0]!.key).toBe(firstGapKey);
    expect(spansOf(state)).toEqual(["#0", "#1", "#2"]);
    expect(turnKeys(state)).toEqual(["#3", "#4"]);
  });

  test("fills each gap height and sums its placeholder height", () => {
    const state = stateWith(4);
    evictForWindow(state, 2, 2, () => 0, 9_999, 500);
    fillGapHeights(state, new Map([["#0", 900], ["#1", 1_200]]));
    const gap = state.slots[0]!;
    expect(gap.kind === "gap" && gapHeight(gap.spans)).toBe(2_100);
    fillGapHeights(state, new Map([["#9", 500]]));
    expect(gap.kind === "gap" && gapHeight(gap.spans)).toBe(2_100);
  });

  test("evicting a failed turn recomputes status indicators", () => {
    const state = stateWith(4);
    state.turns["#0"]!.status = "failed";
    recomputeDerived(state);
    expect(state.failedTurns).toBe(1);
    expect(evictForWindow(state, 2, 2, () => 0, 9_999, 500)).toEqual(["#0", "#1"]);
    expect(state.failedTurns).toBe(0);
  });

  test("a running turn blocks eviction of later turns", () => {
    const state = stateWith(3);
    state.turns["#1"]!.status = "running";
    expect(evictForWindow(state, 0, 2, () => 0, 9_999, 500)).toEqual(["#0"]);
    expect(state.slots[1]).toMatchObject({ kind: "turn", key: "#1" });
  });

  test("keeps turns near the viewport and clamps very tall gaps", () => {
    const state = stateWith(4);
    expect(evictForWindow(state, 2, 2, () => 3_000, 3_500, 500)).toHaveLength(0);
    expect(clampPlaceholderHeight(50, 500)).toBe(50);
    expect(clampPlaceholderHeight(9_999, 500)).toBe(1_000);
  });
});
