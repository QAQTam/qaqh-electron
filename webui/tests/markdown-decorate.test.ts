// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { renderMarkdownHtml } from "../src/markdown/render";

function htmlOf(src: string): HTMLDivElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdownHtml(src);
  return host;
}

test("行内代码文件名前置语言 logo", () => {
  // src 在 vitest 下是内联 data URL、生产构建下是打包资产 URL,断言只看映射关系不看形态。
  const host = htmlOf("改 `main.rs` 和 `index.js`,参考 `Cargo.toml`");
  const codes = host.querySelectorAll("code");
  expect(codes).toHaveLength(3);
  const rs = codes[0]!.querySelector("img.md-inline-icon")?.getAttribute("src");
  const js = codes[1]!.querySelector("img.md-inline-icon")?.getAttribute("src");
  const toml = codes[2]!.querySelector("img.md-inline-icon")?.getAttribute("src");
  expect(rs).toBeTruthy();
  expect(js).toBeTruthy();
  expect(js).not.toBe(rs);
  expect(toml).toBe(rs);
});

test("普通命令词与块级代码不加图标", () => {
  const host = htmlOf("跑 `--mode yolo`,再看:\n\n```rust\nfn main() {}\n```\n");
  expect(host.querySelectorAll("img.md-inline-icon")).toHaveLength(0);
});

test("GitHub 外链前置猫猫头,其他站点不加", () => {
  const host = htmlOf("[repo](https://github.com/x/y)、[gist](https://gist.github.com/a/1) 与 [docs](https://example.com)");
  const links = host.querySelectorAll("a");
  expect(links).toHaveLength(3);
  expect(links[0]!.firstElementChild?.classList.contains("md-inline-icon-mark")).toBe(true);
  expect(links[1]!.firstElementChild?.classList.contains("md-inline-icon-mark")).toBe(true);
  expect(links[2]!.firstElementChild).toBeNull();
});
