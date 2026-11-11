// 注入到目标页面的脚本（engine.ts 经 webContents.executeJavaScript 执行）。
// 纯字符串常量：不 import electron，单测可直接断言脚本形态/序列化器行为。
//
// 口径（docs/browser-control-design.md）：DOM snapshot → uid → act。
// uid 以 data-qaqh-uid 落在元素上，最新一次 snapshot 是唯一事实源；
// uid 失配时定位脚本报错，由模型重新 snapshot——不写任何兼容回退。

/** 页面内执行的 snapshot 脚本：返回 {url,title,lines,truncated}。函数表达式形态（runScript 统一包调用）。 */
export const SNAPSHOT_SCRIPT = String.raw`
() => {
  const UID_ATTR = "data-qaqh-uid";
  const MAX_LINES = 400;
  const SKIP_TAGS = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","CANVAS","LINK","META","HEAD"]);
  const lines = [];
  let uidCounter = 0;
  let truncated = false;

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const shortText = (el, max) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) + "…" : text;
  };

  const roleOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "summary";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button","submit","reset"].includes(type)) return "button";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading" + tag[1];
    if (el.isContentEditable) return "textbox";
    return tag;
  };

  const nameOf = (el) => {
    const named =
      el.getAttribute("aria-label") ||
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.placeholder : "") ||
      el.getAttribute("title") ||
      (el.tagName === "IMG" ? el.alt : "");
    if (named && named.trim()) return named.trim().slice(0, 80);
    if (el.tagName === "INPUT" && el.type !== "hidden") {
      const label = el.labels && el.labels[0];
      if (label) return shortText(label, 80);
    }
    if (/^(H[1-6]|P|SPAN|LI|TD|TH|DT|DD|STRONG|EM|BLOCKQUOTE|PRE|CODE)$/.test(el.tagName)) return shortText(el, 160);
    const inner = shortText(el, 80);
    if (inner && inner.length <= 80 && !el.querySelector("a,button,input,textarea,select")) return inner;
    return "";
  };

  const isInteractive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (["a","button","input","textarea","select","summary"].includes(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("ngclick")) return true;
    const role = el.getAttribute("role");
    if (role && ["button","link","tab","menuitem","checkbox","radio","switch","slider","textbox","option","combobox"].includes(role)) return true;
    if (tag === "label" && el.htmlFor) return true;
    return false;
  };

  const describe = (el, depth) => {
    const role = roleOf(el);
    const interactive = isInteractive(el);
    const name = nameOf(el);
    if (!interactive && !name && role === el.tagName.toLowerCase()) return;
    const parts = [];
    if (interactive) {
      const uid = ++uidCounter;
      el.setAttribute(UID_ATTR, String(uid));
      parts.push("[" + uid + "]");
    }
    parts.push(role);
    if (name) parts.push(JSON.stringify(name));
    if (el.tagName === "INPUT" && el.type !== "hidden") {
      if (el.type === "checkbox" || el.type === "radio") parts.push(el.checked ? "checked" : "unchecked");
      else if (el.value) parts.push("value=" + JSON.stringify(el.value.slice(0, 120)));
    }
    if (el.tagName === "TEXTAREA" && el.value) parts.push("value=" + JSON.stringify(el.value.slice(0, 120)));
    if (el.tagName === "SELECT" && el.selectedOptions[0]) parts.push("value=" + JSON.stringify(el.selectedOptions[0].text.slice(0, 80)));
    if (el.disabled) parts.push("disabled");
    if (el.tagName === "A" && el.getAttribute("href")) {
      const href = el.getAttribute("href");
      parts.push("href=" + JSON.stringify(href.length > 100 ? href.slice(0, 100) + "…" : href));
    }
    lines.push("  ".repeat(Math.min(depth, 10)) + "- " + parts.join(" "));
  };

  const walk = (root, depth) => {
    if (truncated) return;
    for (const el of root.children) {
      if (lines.length >= MAX_LINES) { truncated = true; return; }
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.tagName === "IFRAME") { lines.push("  ".repeat(Math.min(depth, 10)) + "- [iframe] " + JSON.stringify((el.title || "iframe").slice(0, 60))); continue; }
      if (!isVisible(el)) continue;
      describe(el, depth);
      walk(el, depth + 1);
    }
  };

  if (document.body) walk(document.body, 0);
  return {
    url: location.href,
    title: document.title,
    lines,
    truncated,
  };
}
`;

/** 页面内执行的定位脚本：uid → 视口坐标中心 + 元素元数据。错误以 {error} 返回——
 * executeJavaScript 的页面异常会被 Electron 吞成无细节的 "Script failed to execute"，
 * 模型需要可行动的原文错误。 */
export const LOCATE_SCRIPT_PREFIX = String.raw`
(uidText) => {
  const el = document.querySelector('[data-qaqh-uid="' + CSS.escape(uidText) + '"]');
  if (!el) return { error: "uid " + uidText + " 已失效，请重新调用 browser_snapshot" };
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { error: "uid " + uidText + " 元素不可见" };
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return { error: "uid " + uidText + " 元素不可见" };
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    tag: el.tagName.toLowerCase(),
    type: el.tagName === "INPUT" ? (el.type || "text") : "",
    editable: el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable,
  };
}
`;

/** 聚焦待输入元素：输入框全选（后续 char 事件覆盖输入），contenteditable 选中正文。返回元素元数据供 editable 校验。 */
export const FOCUS_SCRIPT_PREFIX = String.raw`
(uidText) => {
  const el = document.querySelector('[data-qaqh-uid="' + CSS.escape(uidText) + '"]');
  if (!el) return { error: "uid " + uidText + " 已失效，请重新调用 browser_snapshot" };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    el.select();
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return {
    tag: el.tagName.toLowerCase(),
    type: el.tagName === "INPUT" ? (el.type || "text") : "",
    editable: el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable,
  };
}
`;

/** 滚动主 frame。 */
export const SCROLL_SCRIPT_PREFIX = String.raw`
(direction, amount) => {
  const delta = Math.max(1, Math.min(5000, amount | 0));
  window.scrollBy(0, direction === "up" ? -delta : delta);
  return window.scrollY;
}
`;

/** snapshot 序列化：把脚本返回值压成 MCP 文本结果（纯函数，可单测）。 */
export function serializeSnapshot(result: { url: string; title: string; lines: string[]; truncated: boolean }): string {
  const head = `url: ${result.url}\ntitle: ${result.title}\nelements: ${result.lines.length}${result.truncated ? "（已截断，扩大窗口或翻页后重新 snapshot）" : ""}`;
  const body = result.lines.join("\n");
  return body ? head + "\n" + body : head;
}
