/** 输入必须经过 renderMarkdownHtml 净化。仅管理 Markdown 自己创建的 DOM,不触碰 Solid 子树。 */
export function patchMarkdown(host: HTMLElement, html: string): void {
  const template = host.ownerDocument.createElement("template");
  template.innerHTML = html;
  patchChildren(host, template.content);
}

function patchChildren(host: Node, next: Node): void {
  let current = host.firstChild;
  for (const wanted of Array.from(next.childNodes)) {
    if (current == null) { host.appendChild(wanted); continue; }
    const following = current.nextSibling;
    if (current.nodeType !== wanted.nodeType || current.nodeName !== wanted.nodeName) {
      host.replaceChild(wanted, current);
    } else if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
      if (current.nodeValue !== wanted.nodeValue) current.nodeValue = wanted.nodeValue;
    } else if (current instanceof Element && wanted instanceof Element) {
      for (const attr of Array.from(current.attributes)) {
        if (!wanted.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      }
      for (const attr of Array.from(wanted.attributes)) {
        if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      }
      patchChildren(current, wanted);
    }
    current = following;
  }
  while (current != null) {
    const following = current.nextSibling;
    host.removeChild(current);
    current = following;
  }
}
