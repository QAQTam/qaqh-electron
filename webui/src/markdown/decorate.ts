/**
 * Markdown 净化后的装饰层:行内代码文件名 → 语言 logo,GitHub 外链 → 站点标,
 * `path:line` 引用 → 可点击链接。
 *
 * 装饰必须发生在 HTML 字符串层面(renderMarkdownHtml 出口处),不能像
 * addCodeBlockHeaders 那样对已写入的 DOM 事后加工——tail 每帧拿模板树与现有
 * DOM 做节点 diff(patch.ts),事后加的图标会让下一帧 diff 错位、反复重建。
 * 图标进字符串即进 wanted tree,diff 天然幂等。文件引用同理。
 *
 * 语言图标直出彩色 SVG(Material Icon Theme @cb1dfb6d,MIT,与 zcode 同源审计);
 * GitHub 标走 CSS 遮罩跟链接色——与 tools.css .tool-command-icon 同机制
 * (Simple Icons 的 path 不带 fill,<img> 直出在深色主题下是纯黑)。
 */
import { extractFileRefs, type FileRef } from "./fileRefs";

const FILE_ICON_SRC: Record<string, string> = {
  rust: new URL("./icons/rust.svg", import.meta.url).href,
  nodejs: new URL("./icons/nodejs.svg", import.meta.url).href,
  typescript: new URL("./icons/typescript.svg", import.meta.url).href,
  python: new URL("./icons/python.svg", import.meta.url).href,
  docker: new URL("./icons/docker.svg", import.meta.url).href,
};
const GITHUB_MARK_SRC = new URL("../tools/icons/github.svg", import.meta.url).href;

// 起步只收品牌色的语言扩展名;json/yaml/md 这类无品牌色的保持素净不加图标。
const ICON_BY_EXTENSION: Record<string, string> = {
  rs: "rust",
  js: "nodejs", mjs: "nodejs", cjs: "nodejs",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python",
};
const ICON_BY_FILE_NAME: Record<string, string> = {
  "cargo.toml": "rust",
  dockerfile: "docker",
  "package.json": "nodejs",
  "tsconfig.json": "typescript",
};
const GITHUB_HOSTS = new Set(["github.com", "gist.github.com"]);

function fileIconSrcFor(codeText: string): string | null {
  const leaf = codeText.trim().split(/[\\/]/).pop() ?? "";
  if (leaf === "" || leaf.length > 64 || /\s/.test(leaf)) return null;
  const lower = leaf.toLowerCase();
  const icon =
    ICON_BY_FILE_NAME[lower] ??
    ICON_BY_EXTENSION[lower.slice(lower.lastIndexOf(".") + 1)];
  return icon == null ? null : FILE_ICON_SRC[icon] ?? null;
}

function createRefAnchor(ref: FileRef): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "md-file-ref";
  anchor.dataset.fileRef = ref.path;
  if (ref.line != null) anchor.dataset.line = String(ref.line);
  if (ref.col != null) anchor.dataset.col = String(ref.col);
  anchor.title = `${ref.path}${ref.line != null ? `:${ref.line}` : ""} · 打开代码`;
  return anchor;
}

/** 在净化后的 DOM 树上把文件引用变成 data 属性锚点;不产生 href,不触发导航。 */
function linkifyFileRefs(root: DocumentFragment): void {
  for (const code of Array.from(root.querySelectorAll("code"))) {
    if (code.closest("pre") != null) continue;
    const text = (code.textContent ?? "").trim();
    const refs = extractFileRefs(text);
    if (refs.length !== 1 || refs[0]!.raw !== text) continue;
    const anchor = createRefAnchor(refs[0]!);
    while (code.firstChild != null) anchor.append(code.firstChild);
    code.replaceWith(anchor);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let next = walker.nextNode();
  while (next != null) {
    textNodes.push(next as Text);
    next = walker.nextNode();
  }
  for (const node of textNodes) {
    const parent = node.parentElement;
    if (parent == null || parent.closest("pre, a, code, button") != null) continue;
    const refs = extractFileRefs(node.data);
    if (refs.length === 0) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const ref of refs) {
      if (ref.start > cursor) frag.append(node.data.slice(cursor, ref.start));
      const anchor = createRefAnchor(ref);
      anchor.textContent = ref.raw;
      frag.append(anchor);
      cursor = ref.end;
    }
    if (cursor < node.data.length) frag.append(node.data.slice(cursor));
    node.replaceWith(frag);
  }
}

/** 输入必须是 DOMPurify 净化后的 HTML;产物只经 innerHTML 写入已净化容器。 */
export function decorateMarkdownHtml(html: string): string {
  if (!html.includes("<code") && !html.includes("<a ") && !html.includes(".")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const code of template.content.querySelectorAll("code")) {
    if (code.closest("pre") != null) continue;
    const src = fileIconSrcFor(code.textContent ?? "");
    if (src == null) continue;
    const icon = document.createElement("img");
    icon.className = "md-inline-icon";
    icon.src = src;
    icon.alt = "";
    icon.draggable = false;
    code.insertBefore(icon, code.firstChild);
  }
  // sanitize hook 已保证剩下的 href 全是 http(s),URL 解析不会失败。
  for (const anchor of template.content.querySelectorAll("a[href]")) {
    const host = new URL(anchor.getAttribute("href") ?? "").hostname.toLowerCase();
    if (!GITHUB_HOSTS.has(host)) continue;
    const icon = document.createElement("span");
    icon.className = "md-inline-icon md-inline-icon-mark";
    icon.setAttribute("aria-hidden", "true");
    icon.style.setProperty("--md-inline-icon", `url("${GITHUB_MARK_SRC}")`);
    anchor.insertBefore(icon, anchor.firstChild);
  }
  linkifyFileRefs(template.content);
  return template.innerHTML;
}
