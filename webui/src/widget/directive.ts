/**
 * widget-directive §1：正文 widget marker 的 marked extension。
 *
 * wire 文法（单行 block，出现在 assistant 正文希望渲染 widget 的位置）：
 *
 *   <U+E200> visualize <U+E202>{"path":"<绝对路径>.html","mode":"wide","title":"…"}<U+E201>
 *
 * 解析规则（对齐 Codex markdown-it codexDirective）：
 *  - block：marker 独占一行才挂载 widget（渲染 div 挂载点，widget/host.ts 水合）；
 *  - inline / 未识别 type / 未闭合碎片：静默吞成空文本，绝不显示原始串；
 *  - JSON 解析失败或 path 非法：整行降级为一行占位文本，不报错、不阻断回合。
 *
 * marked 派发约束：tokenizer 返回的 token.type 必须等于 extension.name，
 * 故两种 level 各一个 name，内部以 `kind` 字段分流渲染。
 *
 * 本模块零外部依赖、纯 ASCII 源码：三个 PUA 码位只以 \u 转义出现。
 */
import type { Token } from "marked";

export const MARKER_OPEN = "\uE200"; // U+E200 起始
export const MARKER_SPLIT = "\uE202"; // U+E202 type/payload 分隔
export const MARKER_CLOSE = "\uE201"; // U+E201 结束

/** v1 type 白名单（spec §1）：仅 visualize。 */
const KNOWN_TYPES = new Set(["visualize"]);

type WidgetToken = Token & {
  type: "qqhWidget" | "qqhWidgetInline";
  raw: string;
  kind: "mount" | "fallback" | "hidden";
  path?: string;
  title?: string;
  mode?: string;
};

/** marker 载荷的 JSON 形状（宽容解析：只有 path 是硬要求）。 */
interface MarkerPayload {
  path?: unknown;
  title?: unknown;
  mode?: unknown;
}

// block：行首（允许 ≤3 空格缩进）到行尾整行匹配。
const BLOCK_RE = new RegExp(
  `^(?: {0,3})${MARKER_OPEN}\\s*([a-z][a-z0-9_-]*)\\s*${MARKER_SPLIT}\\s*([^${MARKER_CLOSE}\\r\\n]*?)\\s*${MARKER_CLOSE}[ \\t]*(?:\\r?\\n|$)`,
);
// inline：完整终止段；或未闭合时吞到行尾（流式渲染不闪现裸 PUA）。
const INLINE_RE = new RegExp(`^${MARKER_OPEN}[^${MARKER_CLOSE}\\r\\n]*${MARKER_CLOSE}`);
const INLINE_UNCLOSED_RE = new RegExp(`^${MARKER_OPEN}[^${MARKER_CLOSE}]*(?:\\r?\\n|$)`);

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function basenameOf(rawPath: string): string {
  const segments = rawPath.split(/[/\\]+/);
  return segments[segments.length - 1] ?? rawPath;
}

function parsePayload(json: string): MarkerPayload | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MarkerPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/** block token：独占行 marker。 */
function blockTokenizer(src: string): WidgetToken | undefined {
  const match = BLOCK_RE.exec(src);
  if (!match) return undefined;
  const [, markerType, payloadText] = match;
  const hidden = (raw: string): WidgetToken =>
    ({ type: "qqhWidget", raw, kind: "hidden" }) as WidgetToken;
  if (!markerType || !KNOWN_TYPES.has(markerType)) {
    // 未识别 type：按 inline 规则吞掉（多端前向兼容）。
    return hidden(match[0]);
  }
  const payload = parsePayload(payloadText ?? "");
  const path = typeof payload?.path === "string" ? payload.path : "";
  const title = typeof payload?.title === "string" ? payload.title : undefined;
  const mode = typeof payload?.mode === "string" ? payload.mode : undefined;
  if (!payload || !path || !path.toLowerCase().endsWith(".html")) {
    return {
      type: "qqhWidget",
      raw: match[0],
      kind: "fallback",
      title,
      path: path || undefined,
    } as WidgetToken;
  }
  return { type: "qqhWidget", raw: match[0], kind: "mount", path, title, mode } as WidgetToken;
}

/** inline token：行内 marker / 未闭合碎片一律吞成空文本。 */
function inlineTokenizer(src: string): WidgetToken | undefined {
  const terminated = INLINE_RE.exec(src);
  if (terminated) {
    return { type: "qqhWidgetInline", raw: terminated[0], kind: "hidden" } as WidgetToken;
  }
  const unterminated = INLINE_UNCLOSED_RE.exec(src);
  if (unterminated) {
    return { type: "qqhWidgetInline", raw: unterminated[0], kind: "hidden" } as WidgetToken;
  }
  return undefined;
}

function blockRenderer(token: WidgetToken): string {
  switch (token.kind) {
    case "mount":
      return (
        `<div class="qqh-widget-mount" data-qqh-path="${escapeAttribute(token.path ?? "")}"` +
        ` data-qqh-title="${escapeAttribute(token.title ?? basenameOf(token.path ?? ""))}"` +
        (token.mode ? ` data-qqh-mode="${escapeAttribute(token.mode)}"` : "") +
        `></div>`
      );
    case "fallback": {
      const label = token.title || (token.path ? basenameOf(token.path) : "widget");
      return `<div class="qqh-widget-fallback">widget: ${escapeAttribute(label)}</div>`;
    }
    case "hidden":
    default:
      return "";
  }
}

/** 注册到全局 marked 实例（render.ts 调用一次）。 */
export function useWidgetDirective(markedUse: (options: Record<string, unknown>) => void): void {
  markedUse({
    extensions: [
      {
        name: "qqhWidget",
        level: "block",
        start(src: string) {
          const index = src.indexOf(MARKER_OPEN);
          return index < 0 ? undefined : index;
        },
        tokenizer: blockTokenizer as never,
        renderer: blockRenderer as never,
      },
      {
        name: "qqhWidgetInline",
        level: "inline",
        start(src: string) {
          const index = src.indexOf(MARKER_OPEN);
          return index < 0 ? undefined : index;
        },
        tokenizer: inlineTokenizer as never,
        renderer: () => "",
      },
    ],
  });
}
