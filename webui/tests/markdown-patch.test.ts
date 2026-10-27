// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { patchMarkdown } from "../src/markdown/patch";

test("growing inline Markdown retains paragraph and strong nodes", () => {
  const host = document.createElement("div");
  patchMarkdown(host, "<p>Hello <strong>world</strong></p>");
  const paragraph = host.firstChild;
  const strong = host.querySelector("strong");
  const text = strong!.firstChild;
  patchMarkdown(host, "<p>Hello <strong>world and more</strong></p>");
  expect(host.firstChild).toBe(paragraph);
  expect(host.querySelector("strong")).toBe(strong);
  expect(strong!.firstChild).toBe(text);
  expect(host.textContent).toBe("Hello world and more");
});

test("table append preserves existing rows; replacements remove stale nodes and attrs", () => {
  const host = document.createElement("div");
  patchMarkdown(host, '<table><tbody><tr><td>a</td></tr></tbody></table><a href="https://example.com">x</a>');
  const row = host.querySelector("tr");
  patchMarkdown(host, '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table><a>x</a>');
  expect(host.querySelector("tr")).toBe(row);
  expect(host.querySelectorAll("tr")).toHaveLength(2);
  expect(host.querySelector("a")!.hasAttribute("href")).toBe(false);
  patchMarkdown(host, "<p>replacement</p>");
  expect(host.textContent).toBe("replacement");
  expect(host.querySelector("table")).toBeNull();
});
