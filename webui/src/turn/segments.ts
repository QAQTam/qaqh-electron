import type { InterjectionStep, Step, TextStep } from "../session/types";

export type WorkSegment = { key: string; kind: "work"; steps: Step[]; closed: boolean; until?: number };
export type InterjectSegment = { key: string; kind: "interject"; step: InterjectionStep };
export type TurnSegment = WorkSegment | { key: string; kind: "text"; step: TextStep } | InterjectSegment;

/** Completion order can differ from model/list order. Never stop the group
 * clock at the last listed tool while an earlier tool is still running. */
export function workSegmentEnd(group: WorkSegment): number | undefined {
  if (group.until != null) return group.until;
  if (!group.closed && group.steps.some((step) =>
    step.kind === "tool"
      ? step.status === "declared" || step.status === "awaiting_permission" || step.status === "running" || step.status === "cancelling"
      : step.kind === "thinking"
        ? step.endedAt == null
        : false)) return undefined;
  const ends = group.steps.flatMap((step) => step.endedAt == null ? [] : [step.endedAt]);
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

/** 控制面/收尾工具:模型常在输出完整最终回答后调用它们收尾,不应把前文正式回答降级卷入折叠窗。 */
const CLOSING_TOOLS = new Set(["handoff", "todo", "todo_write", "visualize", "goal", "goal_set", "goal_update"]);

/**
 * 判断被后续工作跨越的 text 步是否属于「短过场话术(Transitional Commentary)」:
 * 仅短过渡说明(如“我先去读一下 package.json…”)归并进工作段 4 行窗口;
 * 含代码块、标题、表格或超过 240 字的实质性阶段结论保留在主对话流外露。
 */
function isBriefCommentary(step: TextStep): boolean {
  const text = step.text.trim();
  if (text.length === 0) return true;
  if (text.length > 240) return false;
  if (text.includes("```") || text.includes("~~~")) return false;
  if (/^\s{0,3}#{1,6}\s/m.test(text)) return false;
  if (/\|.*\|.*\n\s*\|?\s*[-:]+/m.test(text)) return false;
  return true;
}

/**
 * 只读取结构和时间字段,不订阅 text/progress。文本长度变化不重排列表。
 *
 * 一问一答投影纪律(三条铁律)：
 * 1. 收尾/控制面工具(handoff/todo/visualize/goal)不剥夺前文作为最终回答的资格;
 * 2. 被后续检索/执行工作跨越的文本步,仅在属于「短过场话术」(isBriefCommentary)时归并进 WorkSegment,
 *    长篇阶段性结论/代码块保留为独立回答;
 * 3. 回合已终结(terminal === true)时,若末尾跟了普通工具导致无尾置文本,保底将最后一条 text 步作为最终回答外露。
 */
export function turnSegments(steps: Step[], terminal: boolean): TurnSegment[] {
  let lastWorkIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind === "thinking") {
      lastWorkIndex = i;
      break;
    }
    if (step.kind === "tool" && !CLOSING_TOOLS.has(step.name)) {
      lastWorkIndex = i;
      break;
    }
  }
  let finalTextIndex = -1;
  for (let i = steps.length - 1; i > lastWorkIndex; i--) {
    if (steps[i]!.kind === "text") {
      finalTextIndex = i;
      break;
    }
  }
  // 铁律 3:回合已结束(terminal)时保底外露最后一条 text 步,绝不让已完成回合的最终回答被工具吞没。
  if (terminal && finalTextIndex === -1) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]!.kind === "text") {
        finalTextIndex = i;
        break;
      }
    }
  }

  const segments: TurnSegment[] = [];
  let work: WorkSegment | null = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "text" && (i === finalTextIndex || !isBriefCommentary(step))) {
      if (work != null) { work.closed = true; work.until = step.startedAt ?? work.until; }
      segments.push({ key: `text:${step.id}`, kind: "text", step });
      work = null;
    } else if (step.kind === "interject") {
      // 插话条目单独成行,不折进「已工作」组:看门狗提示被藏在折叠行里等于没提示。
      if (work != null) { work.closed = true; work.until = step.startedAt ?? work.until; }
      segments.push({ key: `interject:${step.id}`, kind: "interject", step });
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
