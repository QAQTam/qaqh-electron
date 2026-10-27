/** 展示分类仅决定信息层级，不改写入参，也不从请求推断执行结果。 */
import type { ToolStep } from "../session/types";
import { parseJsonish } from "../session/reducer";
import { parseUnifiedDiff } from "../diff/parse";

export type ToolPresentation = "shell" | "read" | "edit" | "search" | "todo" | "skill" | "other";

export function toolPresentation(step: Pick<ToolStep, "name" | "display">): ToolPresentation {
  if (["todo", "todo_write", "todo_update", "todo_list", "todo_create"].includes(step.name)) return "todo";
  if (["skills", "skill", "skills_list", "skill_list", "skill_read", "skill_resource", "skill_activate", "skill_validate"].includes(step.name)) return "skill";
  const header = step.display?.header;
  if (header?.kind === "shell") return "shell";
  if (header?.kind === "query") return "search";
  if (header?.kind === "path") {
    if (header.op === "read" || header.op === "list") return "read";
    if (["edit", "write", "patch", "delete"].includes(header.op)) return "edit";
  }
  if (["exec", "bash", "shell", "exec_command"].includes(step.name)) return "shell";
  if (["read", "read_file"].includes(step.name)) return "read";
  if (["edit", "edit_file", "write", "write_file", "apply_patch"].includes(step.name)) return "edit";
  if (["search", "grep", "glob", "web_search"].includes(step.name)) return "search";
  return "other";
}

export function isSkillStep(step: Pick<ToolStep, "name" | "display" | "argsJson">): boolean {
  if (toolPresentation(step) === "skill") return true;
  if (toolPresentation(step) !== "read") return false;
  const args = parseJsonish(step.argsJson);
  const path = step.display?.header?.kind === "path" ? step.display.header.path : args?.path ?? args?.file_path ?? args?.file ?? args?.filename;
  return typeof path === "string" && /(?:^|[\\/])SKILL\.md$/i.test(path);
}

export function semanticLabel(step: Pick<ToolStep, "name" | "display" | "argsJson" | "status">): string | undefined {
  const kind = isSkillStep(step) ? "skill" : toolPresentation(step);
  if (kind !== "todo" && kind !== "skill") return undefined;
  const action = kind === "todo"
    ? step.name === "todo_list" ? "读取待办" : step.name === "todo_create" ? "创建待办" : "更新待办"
    : step.name === "skill_activate" || step.name === "skill" ? "调用 skills" : "读取 skills";
  return step.status === "success" ? `已${action}` : action;
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

export function toolPaths(step: Pick<ToolStep, "argsJson" | "display" | "output">, cwd?: string | null): string[] {
  const args = parseJsonish(step.argsJson);
  const header = step.display?.header;
  const body = step.display?.body;
  const path = header?.kind === "path" ? header.path : args?.path ?? args?.file_path ?? args?.file ?? args?.filename;
  const files = body?.kind === "diff" && Array.isArray(body.files) && body.files.length ? body.files
    : step.output?.diffText ? parseUnifiedDiff(step.output.diffText).map((file) => file.path) : [];
  const base = typeof args?.cwd === "string" ? args.cwd : typeof args?.workdir === "string" ? args.workdir : cwd;
  return [...new Set([...(typeof path === "string" ? [path] : []), ...files].filter((p) => p !== "/dev/null").map((p) => absoluteToolPath(p, base)))];
}

export function shellContent(step: Pick<ToolStep, "status" | "output" | "progressTail" | "progressStderrTail" | "progressTruncated">) {
  const terminal = ["success", "error", "denied", "aborted", "backgrounded"].includes(step.status);
  const final = terminal && step.output != null;
  return {
    text: final ? step.output?.text ?? "" : step.progressTail ?? "",
    // 运行中 stderr 有独立尾窗(reducer 按 tool_progress.stream 分流);历史数据缺该窗时为空。
    stderr: final ? step.output?.stderr ?? "" : step.progressStderrTail ?? "",
    truncated: final ? step.output?.truncated === true : step.progressTruncated === true,
  };
}
