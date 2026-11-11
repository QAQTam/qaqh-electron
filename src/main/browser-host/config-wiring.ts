// browser-control 的 config.toml 接线：把 qaqh-browser MCP server 段写入
// <data_dir>/config.toml。后端 `config.save` 写模型刻意不含 mcp 段
// （qaqh-config-api ConfigPatch），所以桌面壳在 bootstrap 期直接做段级拼接；
// daemon 在会话唤醒时重读配置并重扫 MCP（qaqh-runtime service wake 路径）。
//
// 竞态约束（设计 docs/browser-control-design.md）：本模块只在壳启动期调用，
// 运行期壳不得再写 config.toml，也不得调用 config.save（后者会用 daemon 内存
// 里的旧 mcp 段整份覆盖磁盘）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** 壳注入的 MCP server 名（daemon server 名规则 [a-z0-9_-]）。 */
export const BROWSER_MCP_SERVER_NAME = "qaqh-browser";

/** 单个 section 头（含嵌套 table，如 [mcp.servers.x]）；注释/缩进容忍。 */
const SECTION_HEADER = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/;

/**
 * 段级拼接：确保 config 文本中存在
 *   [mcp] enabled = true
 *   [mcp.servers.qaqh-browser] url/headers/default_timeout_secs
 * 其余 section 原样保留（含注释与顺序）。url+token 完全一致时不做任何修改。
 */
export function spliceMcpSection(text: string, url: string, token: string): string {
  const serverBlock = [
    `[mcp.servers.${BROWSER_MCP_SERVER_NAME}]`,
    `url = ${tomlString(url)}`,
    `headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    `default_timeout_secs = 120`,
    "",
  ].join("\n");

  const lines = text.split("\n");
  const serverHeader = `[mcp.servers.${BROWSER_MCP_SERVER_NAME}]`;

  // 1) 已有本 server 子段：整段替换（到下一个 section 头）。
  //    [mcp] 头可能在该子段之前（常规），也可能之后（TOML 允许超表后置）——
  //    之后时把 [mcp] enabled 块插在本子段紧前面。
  const existing = findSection(lines, serverHeader);
  if (existing) {
    const before = lines.slice(0, existing.start);
    const after = lines.slice(existing.end);
    const mcpAhead = findSection(before, "[mcp]") != null;
    const mcpLines = mcpAhead ? upsertMcpEnabled(before) : [...before, "[mcp]", "enabled = true", ""];
    return [...mcpLines, ...serverBlockLines(serverBlock), ...after].join("\n");
  }

  // 2) 无本 server 子段：文末追加；[mcp] 段存在则只补 enabled，否则整段补。
  const mcpSection = findSection(lines, "[mcp]");
  const base = mcpSection ? upsertMcpEnabled(lines) : [...lines, "", "[mcp]", "enabled = true", ""];
  return [...stripTrailingBlank(base), ...serverBlockLines(serverBlock)].join("\n").replace(/\s*$/, "\n");
}

/** 追加形态下消掉旧文末与新增块之间的多余空行，保证整洁拼接。 */
function stripTrailingBlank(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") copy.pop();
  return copy;
}

/** 把拼接器产出的 server 块文本展开回行数组（块自带尾空行）。 */
function serverBlockLines(block: string): string[] {
  return block.split("\n");
}

/**
 * 在既有行数组中确保 `[mcp]` 段含 `enabled = true`：
 * - 已是 true：原样返回；
 * - enabled = false：改为 true；
 * - 无 enabled 键：紧跟 [mcp] 头后插入。
 * 仅当 [mcp] 段存在时生效；否则原样返回（调用方先补段）。
 */
function upsertMcpEnabled(lines: string[]): string[] {
  const section = findSection(lines, "[mcp]");
  if (!section) return lines;
  const body = lines.slice(section.start, section.end);
  const enabledLine = body.findIndex((line) => /^\s*enabled\s*=/.test(line));
  if (enabledLine >= 0) {
    if (/^\s*enabled\s*=\s*true\s*(#.*)?$/.test(body[enabledLine])) return lines;
    const patched = [...lines];
    patched[section.start + enabledLine] = "enabled = true";
    return patched;
  }
  const patched = [...lines];
  patched.splice(section.start + 1, 0, "enabled = true");
  return patched;
}

/** 定位一个 section（头行 start，到下一个任意 section 头或 EOF 的 end，左闭右开）。 */
function findSection(lines: string[], header: string): { start: number; end: number } | null {
  // 统一去掉方括号再比：调用方传 "[mcp]" 风格，正则捕获组不含括号。
  const target = header.replace(/\[|\]/g, "").trim();
  for (let i = 0; i < lines.length; i++) {
    const match = SECTION_HEADER.exec(lines[i]);
    if (match && match[1] === target) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (SECTION_HEADER.test(lines[j])) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

/** TOML 基本字符串（多行内容不可能是 url/token，直接 JSON 转义即可满足 TOML）。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 读改写 config.toml（幂等：内容一致不落盘）。返回是否写了磁盘。
 * 首次运行（文件不存在）时创建只含本段的最小配置。
 */
export function wireBrowserMcpConfig(configPath: string, url: string, token: string): boolean {
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = spliceMcpSection(current, url, token);
  if (next === current) return false;
  writeFileSync(configPath, next, "utf8");
  return true;
}
