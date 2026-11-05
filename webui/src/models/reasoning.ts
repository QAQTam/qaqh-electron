/** Protocol vocabulary only. Model capabilities come from the user's catalog. */
export type ReasoningTier = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const EFFORT_LADDER: readonly ReasoningTier[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function reasoningTiers(levels: readonly string[] = []): readonly ReasoningTier[] {
  return EFFORT_LADDER.filter((tier) => levels.includes(tier));
}
