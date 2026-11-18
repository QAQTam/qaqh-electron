/**
 * WorkGroup 展开体内的跨类型聚合（zcode `conversationAssistantWorkItems` 的极简版）：
 * 连续 ≥ minRun 个「同族且已终态」的步骤收成一枚统计组头，展开后是原来的
 * StepRow/WorkStep 列表（组只持有展开状态，摘要仍由原始行渲染器提供）。
 *
 * 族映射吃 `toolPresentation` 的事实分类，不另起词表：
 *  explore = read/search/skill ｜ run = shell ｜ change = edit ｜ think = thinking。
 * todo/goal/handoff/other/mcp 不聚合——各有专卡或语义独立，收进统计句反而丢信息。
 * 未终态的步骤永不进组（在飞的行保持单行 + shimmer，latest 语义不破）。
 */
import type { Step, ToolStatus } from "../session/types";
import { toolPresentation } from "../tools/presentation";

export type RunFamily = "explore" | "run" | "change" | "think";

export type WorkUnit =
  | { key: string; kind: "single"; step: Step }
  | { key: string; kind: "run"; family: RunFamily; steps: Step[] };

const ACTIVE: readonly ToolStatus[] = ["declared", "awaiting_permission", "running", "cancelling"];

function familyOf(step: Step): RunFamily | null {
  if (step.kind === "thinking") return step.endedAt == null ? null : "think";
  if (step.kind !== "tool") return null;
  if (ACTIVE.includes(step.status)) return null;
  if (step.name === "visualize") return null;
  const presentation = toolPresentation(step);
  if (presentation === "read" || presentation === "search" || presentation === "skill") return "explore";
  if (presentation === "edit") return "change";
  if (presentation === "shell") return "run";
  return null;
}

export function groupRuns(steps: Step[], minRun: number): WorkUnit[] {
  const units: WorkUnit[] = [];
  let runFamily: RunFamily | null = null;
  let run: Step[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= minRun && runFamily != null) {
      units.push({ key: `run:${runFamily}:${run[0]!.id}`, kind: "run", family: runFamily, steps: run });
    } else {
      for (const step of run) units.push({ key: `single:${step.id}`, kind: "single", step });
    }
    run = [];
    runFamily = null;
  };
  for (const step of steps) {
    const family = familyOf(step);
    if (family != null && family === runFamily) { run.push(step); continue; }
    flush();
    if (family == null) units.push({ key: `single:${step.id}`, kind: "single", step });
    else { runFamily = family; run = [step]; }
  }
  flush();
  return units;
}
