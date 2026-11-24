/**
 * 从模型输出的纯文本里抽出 `path:line[:col]` 引用。
 *
 * 只认带扩展名的路径，先屏蔽 URL 区间，避免把 `https://x/y/a.ts:42` 误判成文件引用。
 * 这是纯文本正则层，不依赖 markdown AST——decorate 阶段拿到的就是净化后的 HTML 文本节点。
 */
export interface FileRef {
  path: string;
  line?: number;
  col?: number;
  raw: string;
  start: number;
  end: number;
}

const URL_RE = /\b(?:https?|file):\/\/[^\s<>()\]`"'，。！？；：、]+/gi;

const BOUNDARY = "\\s(\"'`“”‘’,.;:!?，。！？；：、\\[\\]";
const FILE_REF_RE = new RegExp(
  `(?:^|[${BOUNDARY}])` +
    `((?:(?:\\.{1,2}[\\\\/]|[a-zA-Z]:[\\\\/]|\\/|[\\p{L}\\p{N}\\p{M}_.@()-]+[\\\\/])` +
    `[\\p{L}\\p{N}\\p{M}_.@() -]*(?:[\\\\/][\\p{L}\\p{N}\\p{M}_.@() -]+)*|[\\p{L}\\p{N}\\p{M}_.@()-]+)` +
    `\\.[\\p{L}][\\p{L}\\p{N}]{0,15}(?::(\\d{1,6})(?::(\\d{1,6}))?)?)` +
    `(?=$|[${BOUNDARY}])`,
  "giu",
);

export function extractFileRefs(text: string): FileRef[] {
  if (text === "") return [];

  const protectedRanges: Array<[number, number]> = [];
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    protectedRanges.push([start, start + match[0].length]);
  }

  const refs: FileRef[] = [];
  for (const match of text.matchAll(FILE_REF_RE)) {
    const full = match[0] ?? "";
    const raw = match[1] ?? "";
    const start = (match.index ?? 0) + full.lastIndexOf(raw);
    const end = start + raw.length;
    if (protectedRanges.some(([from, to]) => start < to && end > from)) continue;

    const path = raw.replace(/:\d+(?::\d+)?$/, "");
    refs.push({
      path,
      ...(match[2] ? { line: Number(match[2]) } : {}),
      ...(match[3] ? { col: Number(match[3]) } : {}),
      raw,
      start,
      end,
    });
  }
  return refs;
}
