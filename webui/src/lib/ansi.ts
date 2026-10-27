/**
 * ANSI SGR → DOM(spec §2.1:MUST NOT 向用户展示原始 `\x1b[...m` 转义序列)。
 * 用成熟库 anser 解析;输出以 textContent 构建节点,不经过 innerHTML。
 */
import Anser from "anser";

export interface AnsiChunk {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface AnserEntity {
  content: string;
  fg: string | null;
  bg: string | null;
  decoration: string | null;
  decorations?: string[];
}

export function parseAnsi(text: string): AnsiChunk[] {
  try {
    const entities = Anser.ansiToJson(text, { json: false }) as AnserEntity[];
    const chunks = entities.map((entity) => ({
      text: entity.content,
      // anser 的默认/复位片段为 null；彩色槽是 RGB 三元组而不是 CSS rgb()。
      color: entity.fg ? `rgb(${entity.fg})` : undefined,
      background: entity.bg ? `rgb(${entity.bg})` : undefined,
      bold: entity.decorations?.includes("bold") || entity.decoration === "bold",
      italic: entity.decorations?.includes("italic") || entity.decoration === "italic",
      underline: entity.decorations?.includes("underline") || entity.decoration === "underline",
    }));
    // 同色日志的 reset/newline 不应每行生成两套响应式节点。
    // 仅合并无可见字形的换行；有背景的空格/普通文本仍保留自己的样式。
    const merged: AnsiChunk[] = [];
    for (const chunk of chunks) {
      if (!chunk.text) continue;
      const previous = merged[merged.length - 1];
      const sameStyle = previous && previous.color === chunk.color && previous.background === chunk.background
        && previous.bold === chunk.bold && previous.italic === chunk.italic && previous.underline === chunk.underline;
      if (previous && (sameStyle || /^[\r\n]+$/.test(chunk.text))) previous.text += chunk.text;
      else merged.push(chunk);
    }
    return merged;
  } catch {
    return [{ text: Anser.ansiToText(text) }];
  }
}

/** 是否包含 ANSI 转义序列(纯文本可直接走 textContent 快路径)。 */
export function hasAnsi(text: string): boolean {
  return text.includes("\u001b[");
}
