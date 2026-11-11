/** 展示分类仅决定信息层级，不改写入参，也不从请求推断执行结果。 */
import type { ToolStep } from "../session/types";
import { parseJsonish } from "../session/reducer";
import { HANDOFF_FIELD_SUMMARY, HANDOFF_TOOL } from "../session/handoff";
import { parseUnifiedDiff } from "../diff/parse";

export type ToolPresentation = "shell" | "read" | "edit" | "search" | "todo" | "skill" | "handoff" | "other";

export function toolPresentation(step: Pick<ToolStep, "name">): ToolPresentation {
  // `handoff` 是控制面工具:后端不受 allowlist 约束(minimal/custom 档也照样声明),
  // 所以任何 tool_mode 下它都可能出现。图标/标签按**工具名**判定,绝不再套一层
  // 白名单——那会让"模型真会调的工具"少个图标。
  if (step.name === HANDOFF_TOOL) return "handoff";
  if (["todo", "todo_write", "todo_update", "todo_list", "todo_create"].includes(step.name)) return "todo";
  if (["skills", "skill", "skills_list", "skill_list", "skill_read", "skill_resource", "skill_activate", "skill_validate"].includes(step.name)) return "skill";
  if (step.name === "exec_command") return "shell";
  if (["read", "read_file"].includes(step.name)) return "read";
  if (["edit", "edit_file", "write", "write_file", "apply_patch"].includes(step.name)) return "edit";
  if (["search", "grep", "glob", "web_search"].includes(step.name)) return "search";
  return "other";
}

export function toolPhaseLabel(step: Pick<ToolStep, "status">): string | undefined {
  if (step.status === "awaiting_permission") return "等待授权";
  if (step.status === "cancelling") return "正在停止";
  if (step.status === "running") return "执行中";
  if (step.status === "declared") return "准备工具调用";
  return undefined;
}

export function isSkillStep(step: Pick<ToolStep, "name" | "argsJson">): boolean {
  if (toolPresentation(step) === "skill") return true;
  if (toolPresentation(step) !== "read") return false;
  const args = parseJsonish(step.argsJson);
  const path = args?.path ?? args?.file_path ?? args?.file ?? args?.filename;
  return typeof path === "string" && /(?:^|[\\/])SKILL\.md$/i.test(path);
}

export function semanticLabel(step: Pick<ToolStep, "name" | "argsJson" | "status">): string | undefined {
  const kind = isSkillStep(step) ? "skill" : toolPresentation(step);
  if (kind !== "todo" && kind !== "skill") return undefined;
  const action = kind === "todo"
    ? step.name === "todo_list" ? "读取待办" : step.name === "todo_create" ? "创建待办" : "更新待办"
    : step.name === "skill_activate" || step.name === "skill" ? "调用 skills" : "读取 skills";
  return step.status === "finished" ? `已${action}` : action;
}

/** 不用浏览器 location 猜目录；相对路径只以明确 cwd 解析。 */
export function absoluteToolPath(path: string, cwd?: string | null): string {
  const clean = path.replaceAll("\\", "/");
  const base = cwd?.replaceAll("\\", "/");
  const absolute = /^(?:[A-Za-z]:\/|\/)/.test(clean);
  if (!absolute && (!base || !/^(?:[A-Za-z]:\/|\/)/.test(base))) return clean;
  // Windows 当前盘根路径需要 cwd 里的盘符；不能误读成 Unix 绝对路径。
  const full = clean.startsWith("/") && !clean.startsWith("//") && /^[A-Za-z]:\//.test(base ?? "")
    ? `${base!.slice(0, 2)}${clean}` : absolute ? clean : `${base}/${clean}`;
  const root = full.match(/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of full.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `${root.replace(/\/$/, "")}/${parts.join("/")}`;
}

export function toolPaths(step: Pick<ToolStep, "argsJson" | "output">, cwd?: string | null): string[] {
  const args = parseJsonish(step.argsJson);
  const path = args?.path ?? args?.file_path ?? args?.file ?? args?.filename;
  const files = step.output?.diffText ? parseUnifiedDiff(step.output.diffText).map((file) => file.path) : [];
  const base = typeof args?.cwd === "string" ? args.cwd : typeof args?.workdir === "string" ? args.workdir : cwd;
  return [...new Set([...(typeof path === "string" ? [path] : []), ...files].filter((p) => p !== "/dev/null").map((p) => absoluteToolPath(p, base)))];
}

export function shellLive(step: Pick<ToolStep, "status" | "execSession">): boolean {
  return step.execSession != null ? step.execSession.state.kind !== "finished"
    : ["declared", "awaiting_permission", "running", "cancelling"].includes(step.status);
}

export function shellContent(step: Pick<ToolStep, "status" | "output" | "progressTail" | "progressStderrTail" | "progressTruncated" | "execSession">) {
  const session = step.execSession;
  if (session) {
    const finalText = session.state.kind === "finished" && session.output?.kind === "inline" ? session.output.data.text : undefined;
    return {
      text: finalText ?? session.output_preview,
      stderr: "",
      truncated: finalText != null ? session.capture_omitted_bytes > 0
        : session.preview_start_offset > 0 || session.stream_dropped_bytes > 0,
      stream: { startOffset: session.preview_start_offset, endOffset: session.next_offset,
        data: session.output_preview, offsetEncoding: "utf8" as const },
    };
  }
  const terminal = ["finished", "failed", "cancelled", "interrupted"].includes(step.status);
  const final = terminal && step.output != null;
  return {
    text: final ? step.output?.text ?? "" : step.progressTail ?? "",
    // 运行中 stderr 有独立尾窗(reducer 按 tool_output_delta.stream 分流)。
    stderr: final ? step.output?.stderr ?? "" : step.progressStderrTail ?? "",
    truncated: final ? step.output?.truncated === true : step.progressTruncated === true,
  };
}

/**
 * 交接行的摘要 = 模型亲手写的 `work_summary`(折叠行本来就该一行的东西)。
 *
 * 拿 `primaryArg` 会把整段 `handoff_doc` 的第一个字符串当摘要——那是一篇文档。
 */
export function handoffSummary(step: Pick<ToolStep, "argsJson">): string {
  const args = parseJsonish(step.argsJson);
  const value = args?.[HANDOFF_FIELD_SUMMARY];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
