// 轻量 Markdown 渲染器（M1 范围：标题/列表/代码/行内/引用/表格七类）。
// 输出经 DOM API 构建的节点，绝不 innerHTML 裸插（spec §9 MarkdownText）。

export interface CodeChunk {
  kind: "code";
  lang: string;
  code: string;
}
export interface TextChunk {
  kind: "text";
  md: string;
}

/** 按围栏代码块切块，代码块单独处理避免内部 markdown 误解析。 */
export function splitFences(src: string): Array<CodeChunk | TextChunk> {
  const chunks: Array<CodeChunk | TextChunk> = [];
  const lines = src.split("\n");
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = /^```(\w*)\s*$/.exec(lines[i] ?? "");
    if (fence) {
      if (text.length) chunks.push({ kind: "text", md: text.join("\n") });
      text = [];
      const lang = fence[1] ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // 跳过收尾 ```
      chunks.push({ kind: "code", lang, code: code.join("\n") });
    } else {
      text.push(lines[i] ?? "");
      i += 1;
    }
  }
  if (text.length) chunks.push({ kind: "text", md: text.join("\n") });
  return chunks;
}

/** 行内格式：`code`、**bold**、*em*、[link](url)。返回可挂载的节点数组。 */
export function renderInline(md: string, onOpenLink: (url: string) => void): Node[] {
  const nodes: Node[] = [];
  // 顺序：code > bold > em > link（code 内不再解析其它）
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) nodes.push(document.createTextNode(md.slice(last, m.index)));
    const tok = m[0] ?? "";
    if (tok.startsWith("`")) {
      const el = document.createElement("code");
      el.textContent = tok.slice(1, -1);
      nodes.push(el);
    } else if (tok.startsWith("**")) {
      const el = document.createElement("strong");
      el.textContent = tok.slice(2, -2);
      nodes.push(el);
    } else if (tok.startsWith("*")) {
      const el = document.createElement("em");
      el.textContent = tok.slice(1, -1);
      nodes.push(el);
    } else {
      const linkMatch = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok);
      if (linkMatch) {
        const el = document.createElement("a");
        el.textContent = linkMatch[1] ?? "";
        el.href = "#";
        el.addEventListener("click", (e) => {
          e.preventDefault();
          onOpenLink(linkMatch[2] ?? "");
        });
        nodes.push(el);
      }
    }
    last = m.index + tok.length;
  }
  if (last < md.length) nodes.push(document.createTextNode(md.slice(last)));
  return nodes;
}

function renderBlock(
  container: HTMLElement,
  md: string,
  onOpenLink: (url: string) => void,
  onCopyCode: (code: string) => void,
): void {
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const el = document.createElement(`h${h[1]!.length}`);
      for (const n of renderInline(h[2] ?? "", onOpenLink)) el.appendChild(n);
      container.appendChild(el);
      i += 1;
      continue;
    }
    // 引用
    if (line.startsWith("> ")) {
      const q = document.createElement("blockquote");
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
        buf.push((lines[i] ?? "").slice(2));
        i += 1;
      }
      for (const n of renderInline(buf.join("\n"), onOpenLink)) q.appendChild(n);
      container.appendChild(q);
      continue;
    }
    // 表格
    if (line.includes("|") && (lines[i + 1] ?? "").match(/^\s*\|?[\s:|-]+\|?\s*$/)) {
      const table = document.createElement("table");
      const header = splitRow(line);
      i += 2; // 跳过表头分隔行
      const tbody = document.createElement("tbody");
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const cell of header) {
        const th = document.createElement("th");
        for (const n of renderInline(cell, onOpenLink)) th.appendChild(n);
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        const tr = document.createElement("tr");
        for (const cell of splitRow(lines[i] ?? "")) {
          const td = document.createElement("td");
          for (const n of renderInline(cell, onOpenLink)) td.appendChild(n);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      container.appendChild(table);
      continue;
    }
    // 列表（有序/无序）
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        const li = document.createElement("li");
        const content = (lines[i] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, "");
        for (const n of renderInline(content, onOpenLink)) li.appendChild(n);
        list.appendChild(li);
        i += 1;
      }
      container.appendChild(list);
      continue;
    }
    // 水平线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      container.appendChild(document.createElement("hr"));
      i += 1;
      continue;
    }
    // 段落（连续非空行）
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,4})\s/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").startsWith("> ") &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    const p = document.createElement("p");
    for (const n of renderInline(para.join("\n"), onOpenLink)) p.appendChild(n);
    container.appendChild(p);
  }
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** 渲染整段 markdown 到容器（sealed 内容专用）。 */
export function renderMarkdown(
  container: HTMLElement,
  src: string,
  onOpenLink: (url: string) => void,
  onCopyCode: (code: string) => void,
): void {
  container.textContent = "";
  for (const chunk of splitFences(src)) {
    if (chunk.kind === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = chunk.code;
      pre.appendChild(code);
      if (chunk.lang) {
        const tag = document.createElement("span");
        tag.className = "code-lang";
        tag.textContent = chunk.lang;
        pre.appendChild(tag);
      }
      // copy 按钮最后 append（覆盖在 lang 之上时 hover 才显示，不冲突）
      const copy = document.createElement("button");
      copy.className = "code-copy";
      copy.textContent = "复制";
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        onCopyCode(chunk.code);
      });
      pre.appendChild(copy);
      container.appendChild(pre);
    } else {
      renderBlock(container, chunk.md, onOpenLink, onCopyCode);
    }
  }
}
