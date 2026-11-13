/** 展示分类仅决定信息层级，不改写入参，也不从请求推断执行结果。 */
import type { ToolStep } from "../session/types";
import { parseJsonish } from "../session/reducer";
import { HANDOFF_FIELD_SUMMARY, HANDOFF_TOOL } from "../session/handoff";
import { parseUnifiedDiff } from "../diff/parse";

export type ToolPresentation = "shell" | "read" | "edit" | "search" | "todo" | "skill" | "handoff" | "goal" | "other";

export function toolPresentation(step: Pick<ToolStep, "name">): ToolPresentation {
  // `handoff` 是控制面工具:后端不受 allowlist 约束(minimal/custom 档也照样声明),
  // 所以任何 tool_mode 下它都可能出现。图标/标签按**工具名**判定,绝不再套一层
  // 白名单——那会让"模型真会调的工具"少个图标。
  if (step.name === HANDOFF_TOOL) return "handoff";
  if (["create_goal", "update_goal", "get_goal"].includes(step.name)) return "goal";
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

/** 后端参数类工具的键名（`edit`→file_path、`write`/`read`/`delete`→path）。 */
const ARGS_PATH_KEYS = ["file_path", "path", "file", "filename"];

/**
 * `"key":"value"` 的 JSON 词法：值体 = 转义对 `\\.` 或非 `"`\` 字符，
 * 第二组是收尾引号（缺 = 这个值还在吐）。
 *
 * 不能写成 `([^"]*)`：本仓在 Windows 上，路径里的 `\` 会被那种写法当成
 * 普通字符连着吃，而收尾引号的判定也会跟着错位。
 */
const jsonBodyPattern = (key: string) =>
  new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)("?)`);

/** 解码 JSON 字符串体：末尾残缺的转义（`\`、`\u12`）丢掉——那一段还没吐完。 */
function decodeJsonBody(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== "\\") { out += ch; continue; }
    const esc = body[i + 1];
    if (esc === undefined) break;
    if (esc === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc === "b" || esc === "f" ? "" : esc;
    i += 1;
  }
  return out;
}

/**
 * 未闭合 JSON 前缀里的路径。
 *
 * `tool_arguments_delta.text` 是**累计前缀**，而 `parseJsonish` 要求完整 JSON 才
 * 能 parse——参数吐完之前它恒为 null。这就是"文件名要等调用结束才出现"的根因：
 * 不是没有流式信号，是信号到了却解不出值。`tool_declared` 之后仍走完整 JSON
 * 的权威分支，这里只负责把首帧时机提前。
 *
 * 只认**已闭合**的值：路径还在吐时报半截文件名，卡片会先跳到一个不存在的文件上。
 * 每个键只取首个命中（参数按 schema 顺序吐，真路径在最前；`old_string` 之类
 * 正文里万一含 `"path":"…"` 不会被当第二个来源）。`read` 例外——批量形态
 * `{"requests":[{"path":…},…]}` 的 path 本来就该逐个出。
 */
function scanArgsPrefix(name: string, text: string): string[] {
  const found: string[] = [];
  for (const key of ARGS_PATH_KEYS) {
    const match = jsonBodyPattern(key).exec(text);
    if (!match || !match[2]) continue;
    found.push(decodeJsonBody(match[1]!));
    if (key === "path" && name === "read") {
      for (const nested of text.matchAll(new RegExp(jsonBodyPattern(key).source, "g"))) {
        if (nested[2]) found.push(decodeJsonBody(nested[1]!));
      }
    }
  }
  return found;
}

/**
 * `apply_patch` 的目标文件不再在这里数：补丁文法的唯一事实源是后端补丁引擎，
 * 它把已经数完的结论随参数流一起发下来（`tool_arguments_delta.target_files`）。
 * 客户端再养一份 header 正则，就是两份文法各自漂移的开始。
 */
export function toolPaths(
  step: Pick<ToolStep, "name" | "argsJson" | "output" | "targetFiles">,
  cwd?: string | null,
): string[] {
  const args = parseJsonish(step.argsJson);
  const fromArgs: string[] = [];
  let base = cwd;
  if (args) {
    // 权威形态：顶层键直读，无歧义。
    const path = args.path ?? args.file_path ?? args.file ?? args.filename;
    if (typeof path === "string") fromArgs.push(path);
    if (Array.isArray(args.requests)) {
      for (const request of args.requests) {
        const nested = (request as { path?: unknown } | null)?.path;
        if (typeof nested === "string") fromArgs.push(nested);
      }
    }
    base = typeof args.cwd === "string" ? args.cwd : typeof args.workdir === "string" ? args.workdir : cwd;
  } else if (typeof step.argsJson === "string") {
    fromArgs.push(...scanArgsPrefix(step.name, step.argsJson));
  }
  // 内核的结论排在最前：补丁类调用参数里没有路径字段，只有它能给出文件名。
  fromArgs.unshift(...(step.targetFiles ?? []));
  const files = step.output?.diffText ? parseUnifiedDiff(step.output.diffText).map((file) => file.path) : [];
  return [...new Set([...fromArgs, ...files].filter((p) => p !== "/dev/null").map((p) => absoluteToolPath(p, base)))];
}

export function shellLive(session: import("../api/contract").ExecSessionView): boolean {
  return session.state.kind !== "finished";
}

/**
 * 抽屉专用:执行会话正文。运行中读 16 KiB 尾窗(带 offset 窗口供 xterm 增量写),
 * 终态优先权威输出(inline 已水合;ref 未回来之前仍显示尾窗)。
 */
export function execSessionContent(session: import("../api/contract").ExecSessionView) {
  const finalText = session.state.kind === "finished" && session.output?.kind === "inline" ? session.output.data.text : undefined;
  return {
    text: finalText ?? session.output_preview,
    live: shellLive(session),
    truncated: finalText != null ? session.capture_omitted_bytes > 0
      : session.preview_start_offset > 0 || session.stream_dropped_bytes > 0,
    stream: { startOffset: session.preview_start_offset, endOffset: session.next_offset,
      data: session.output_preview, offsetEncoding: "utf8" as const },
  };
}

/**
 * 消息区 exec 行唯一保留的事实:命令(行首已有)+ exit code(状态位徽章)。
 * 输出正文一律只在抽屉看;`live` 徽章同样直达抽屉。
 */
export type ExecBadge = { label: string; tone: "ok" | "err" | "live" };

export function execRowBadge(step: Pick<ToolStep, "name" | "status" | "state" | "execSessionState" | "output">): ExecBadge | undefined {
  if (toolPresentation(step) !== "shell") return undefined;
  const yielded = step.state?.kind === "finished" && step.state.outcome.kind === "yielded";
  const state = step.execSessionState;
  if (state) {
    if (state.kind === "running") return { label: yielded ? "后台运行" : "执行中", tone: "live" };
    if (state.kind === "stopping") return { label: "正在停止", tone: "live" };
    const outcome = state.outcome;
    if (outcome.kind === "exited") return { label: `exit ${outcome.exit_code}`, tone: outcome.exit_code === 0 ? "ok" : "err" };
    if (outcome.kind === "cancelled") return { label: outcome.exit_code == null ? "已取消" : `已取消 · ${outcome.exit_code}`, tone: "err" };
    if (outcome.kind === "timed_out") return { label: outcome.exit_code == null ? "已超时" : `已超时 · ${outcome.exit_code}`, tone: "err" };
    return { label: "已中断", tone: "err" };
  }
  // 会话视图缺席(后台保留了裁剪策略的极旧数据):退到工具终态本身的解析结果。
  if (yielded) return { label: "后台运行", tone: "live" };
  if (step.status !== "finished") return undefined;
  if (step.output?.exitCode != null) return { label: `exit ${step.output.exitCode}`, tone: step.output.exitCode === 0 ? "ok" : "err" };
  return { label: "已完成", tone: "ok" };
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

/**
 * spawn_subagent 的上下文 fork 徽标:「继承历史」= 子会话被种子化父级已完成
 * 回合前缀(无损,不含在飞回合)。与 handoff 的文档 fork 是两回事,并存不合并
 * (subagent-team 施工单 §〇·2)。fresh/缺省不标。
 */
export function spawnForkBadge(step: Pick<ToolStep, "name" | "argsJson">): string | null {
  if (step.name !== "spawn_subagent") return null;
  const args = parseJsonish(step.argsJson);
  return args?.mode === "fork" ? "继承历史" : null;
}
