/**
 * 工具注册表(spec §8.1):折叠行的「主参数」与展示名。
 *
 * 主参数只从原始 args 的具名字段读取。未知工具不把任意第一个字符串当摘要
 * （可能是源码）；完整入参仍在二次折叠中保留。
 * 展示层绝不改写参数含义——argv 展开仅用于预览,完整入参在二次折叠中保留。
 */
import { parseJsonish } from "../session/reducer";
import { STR } from "../lib/strings";

/** qaqh-browser MCP 工具（wire 名 mcp__qaqh-browser__<tool>）的展示名。 */
const BROWSER_TOOL_LABELS: Record<string, string> = {
  browser_navigate: "打开网页",
  browser_snapshot: "读取页面",
  browser_click: "点击页面",
  browser_type: "输入文本",
  browser_press_key: "按键",
  browser_scroll: "滚动页面",
  browser_screenshot: "网页截图",
  browser_console: "页面控制台",
  browser_close: "关闭浏览器",
};

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
  spawn_subagent: "派子代理",
  // goal 模式(ADR-0015,仅根会话声明)。
  create_goal: "创建目标",
  update_goal: "更新目标",
  get_goal: "查看目标",
  // 子代理任务板/留言板(ADR-0014 本批复活)。
  task_create: "创建任务",
  task_claim: "认领任务",
  task_update: "更新任务",
  task_close: "关闭任务",
  task_list: "列出任务",
  board_channel_create: "创建频道",
  board_thread_create: "创建话题",
  board_post: "留言",
  board_subscribe: "订阅留言",
  board_list: "查看留言",
  // 控制面工具:任何 tool_mode 都会被后端声明,所以任何档位都可能撞上这一行。
  handoff: STR.handoffTool,
};

export function toolLabel(name: string): string {
  if (name.startsWith("mcp__qaqh-browser__")) {
    const tool = name.slice("mcp__qaqh-browser__".length);
    return BROWSER_TOOL_LABELS[tool] ?? tool;
  }
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
    if (typeof args.command === "string" && args.command) return args.command;
    if (Array.isArray(args.argv) && args.argv.length > 0
      && args.argv.every((entry) => typeof entry === "string")) {
      return args.argv.join(" ");
    }
    for (const key of ["path", "file_path", "file", "filename", "query", "pattern", "url", "name", "exec_session_id", "uid", "key", "direction"]) {
      if (typeof args[key] === "string" && args[key]) return args[key];
    }
    if (Array.isArray(args.items) || Array.isArray(args.todos)) {
      return `${(args.items ?? args.todos).length} 项`;
    }
    // 任务板/留言板/goal 的主参数。追加在既有键之后,不改变既有工具的命中序。
    for (const key of ["task_id", "thread_id", "channel_id", "objective", "title", "name", "status", "state", "action"]) {
      if (typeof args[key] === "string" && args[key]) return args[key];
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
