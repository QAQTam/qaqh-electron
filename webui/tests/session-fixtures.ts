import type { SessionBootstrap } from "../src/api/qaqh/SessionBootstrap";
import type { SessionEventFrame } from "../src/api/qaqh/SessionEventFrame";
import type { TimelineEntry } from "../src/api/qaqh/TimelineEntry";
import type { ToolCallView } from "../src/api/qaqh/ToolCallView";
import type { TurnView } from "../src/api/qaqh/TurnView";

export function sessionBootstrap(
  sessionId: string,
  options: {
    seq?: number;
    activity?: "idle" | "running" | "interrupted";
    currentTurnId?: string | null;
    turns?: TurnView[];
    timeline?: TimelineEntry[];
    tools?: ToolCallView[];
    interactions?: SessionBootstrap["state"]["interactions"];
    title?: string | null;
  } = {},
): SessionBootstrap {
  return {
    schema: "qaqh.Ringing",
    version: 2,
    server_epoch: "test-epoch",
    session_id: sessionId,
    state: {
      session_id: sessionId,
      seq: options.seq ?? 0,
      activity: options.activity ?? "idle",
      current_turn_id: options.currentTurnId ?? null,
      title: options.title ?? null,
      turns: options.turns ?? [],
      timeline: options.timeline ?? [],
      tools: options.tools ?? [],
      interactions: options.interactions ?? [],
      subagents: [],
    },
  };
}

export const inline = (text: string) => ({ kind: "inline" as const, data: { text } });
export const contentRef = (content_ref: string) => ({ kind: "ref" as const, data: { content_ref } });

export function applyFrame(store: unknown, event: SessionEventFrame): void {
  (store as { applyProjection(frame: SessionEventFrame): void }).applyProjection(event);
}
