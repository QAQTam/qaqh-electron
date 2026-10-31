import type { Step, TextStep } from "../session/types";

export type WorkSegment = { key: string; kind: "work"; steps: Step[]; closed: boolean; until?: number };
export type TurnSegment = WorkSegment | { key: string; kind: "text"; step: TextStep };

/** Completion order can differ from model/list order. Never stop the group
 * clock at the last listed tool while an earlier tool is still running. */
export function workSegmentEnd(group: WorkSegment): number | undefined {
  if (group.until != null) return group.until;
  if (!group.closed && group.steps.some((step) =>
    step.kind === "tool"
      ? step.status === "pending" || step.status === "running"
      : step.endedAt == null)) return undefined;
  const ends = group.steps.flatMap((step) => step.endedAt == null ? [] : [step.endedAt]);
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

/** 只读取结构和时间字段,不订阅 text/progress。文本长度变化不重排列表。 */
export function turnSegments(steps: Step[], terminal: boolean): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let work: WorkSegment | null = null;
  for (const step of steps) {
    if (step.kind === "text") {
      if (work != null) { work.closed = true; work.until = step.startedAt; }
      segments.push({ key: `text:${step.id}`, kind: "text", step });
      work = null;
    } else {
      if (work == null) {
        work = { key: `work:${step.id}`, kind: "work", steps: [], closed: terminal };
        segments.push(work);
      }
      work.steps.push(step);
    }
  }
  return segments;
}
