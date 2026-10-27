import type { Step, TextStep } from "../session/types";

export type WorkSegment = { key: string; kind: "work"; steps: Step[]; closed: boolean; until?: number };
export type TurnSegment = WorkSegment | { key: string; kind: "text"; step: TextStep };

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
