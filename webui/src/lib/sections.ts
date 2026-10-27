/**
 * exec 输出里 `=== 标题 ===` 分隔行的保守识别(纯展示层)。
 *
 * 模型有时用 `echo ==="标题"===` 给长输出分节。识别只做样式变换,不改写文本:
 * 原文始终留在 `raw`,不匹配的行原样透传给 ANSI 渲染。规则刻意收紧以避免误伤
 * 构建工具/测试框架自带的横幅:
 * - 两侧等号串必须等长且 ≥2(回溯引用),`===== x ==` 这类不对称行不算;
 * - 标题里不允许再出现 `=`,纯等号线(无标题)不算;
 * - 标题 ≤ 80 字符,超出视为排版横幅而不是分节。
 */

export type ShellSegment =
  | { kind: "text"; text: string }
  | { kind: "section"; title: string; raw: string };

const SECTION_LINE = /^\s*(={2,})\s*([^=]{1,80}?)\s*\1\s*$/;

/**
 * 把输出文本切成 text/section 段;相邻普通行合并成一段,交给 ANSI 解析自然成行。
 * 注意分节行两侧的换行符在这里被吞掉——渲染端把 section 段设为 `display: block`
 * 自成一行(tools.css `.tool-section-line`),不需要靠文本换行兜底。
 */
export function parseShellSections(text: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let buffer = "";
  for (const line of text.split("\n")) {
    const match = line.match(SECTION_LINE);
    if (match && match[2]) {
      if (buffer) {
        segments.push({ kind: "text", text: buffer });
        buffer = "";
      }
      segments.push({ kind: "section", title: match[2], raw: line });
    } else {
      buffer += (buffer ? "\n" : "") + line;
    }
  }
  if (buffer) segments.push({ kind: "text", text: buffer });
  return segments;
}
