/**
 * 工具注册表(spec §8.1):折叠行的「主参数」与展示名。
 *
 * 主参数只从原始 args 的具名字段读取。未知工具不把任意第一个字符串当摘要
 * （可能是源码）；完整入参仍在二次折叠中保留。
 * 展示层绝不改写参数含义——argv 展开仅用于预览,完整入参在二次折叠中保留。
 */
import { parseJsonish } from "../session/reducer";

const LABELS: Record<string, string> = {
  exec_command: "执行命令",
  read: "读取文件",
  read_file: "读取文件",
  write: "写入文件",
  write_file: "写入文件",
  edit: "修改文件",
  edit_file: "修改文件",
  apply_patch: "应用补丁",
  search: "搜索",
  grep: "搜索",
  glob: "搜索",
  browser: "浏览网页",
  web_search: "搜索",
  todo: "更新计划",
  todo_write: "更新计划",
  note: "记录",
  subagent: "子代理",
};

export function toolLabel(name: string): string {
  return LABELS[name] ?? name;
}

function firstString(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (value != null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = firstString(item, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

/** 展开态「输入」段的完整主参数(等宽、自动换行、不截断)。 */
export function primaryArgFull(argsJson: string | undefined): string {
  const args = parseJsonish(argsJson);
  if (args != null) {
    if (typeof args.cmd === "string" && args.cmd) return args.cmd;
    for (const key of ["path", "file_path", "file", "filename", "query", "pattern", "url", "name", "exec_session_id"]) {
      if (typeof args[key] === "string" && args[key]) return args[key];
    }
    if (Array.isArray(args.items) || Array.isArray(args.todos)) {
      return `${(args.items ?? args.todos).length} 项`;
    }
  }
  return "";
}

/** 折叠行主参数(单行截断仅为视觉,CSS ellipsis;title 给完整值)。 */
export function primaryArg(argsJson: string | undefined): string {
  const full = primaryArgFull(argsJson);
  return full.replace(/\s*\n\s*/g, " ").trim();
}

export { firstString as firstStringFallback };
