import type { ModelDef } from "@qaqh/sdk/protocol";
import type { ModelEntry } from "./model-catalog";

const positiveInteger = (value: number | undefined): value is number =>
  value != null && Number.isSafeInteger(value) && value > 0;

/** Remote limits/capabilities are facts; retain local preferences within those limits. */
export function mergeModelMetadata(entry: ModelEntry, existing?: ModelDef): ModelDef | null {
  const contextWindow = positiveInteger(entry.contextWindow) ? entry.contextWindow : existing?.context_window;
  const outputLimit = positiveInteger(entry.maxOutputTokens) ? entry.maxOutputTokens : existing?.max_output_tokens;
  if (contextWindow == null || outputLimit == null) return null;
  const levels = entry.reasoningLevels ?? existing?.reasoning_levels ?? [];
  const preferredEffort = existing?.defaults.reasoning_effort;
  const defaultEffort = preferredEffort != null && levels.includes(preferredEffort)
    ? preferredEffort
    : entry.defaultEffort != null && levels.includes(entry.defaultEffort) ? entry.defaultEffort : null;
  return {
    ...existing,
    enabled: existing?.enabled ?? true,
    display_name: entry.displayName.trim() || existing?.display_name || entry.slug,
    context_window: contextWindow,
    max_output_tokens: outputLimit,
    reasoning_levels: levels,
    capabilities: {
      tool_calls: existing?.capabilities.tool_calls ?? false,
      image_input: entry.imageInput ?? existing?.capabilities.image_input ?? false,
      native_web_search: existing?.capabilities.native_web_search ?? false,
      reasoning: entry.reasoningLevels == null ? existing?.capabilities.reasoning ?? false : levels.length > 0,
    },
    defaults: {
      ...existing?.defaults,
      max_output_tokens: Math.min(existing?.defaults.max_output_tokens ?? outputLimit, outputLimit),
      reasoning_effort: defaultEffort,
      native_web_search: existing?.defaults.native_web_search ?? false,
    },
  };
}
