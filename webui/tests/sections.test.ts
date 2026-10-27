/** `=== 标题 ===` 分隔行的保守识别(纯展示层,原文不丢)。 */
import { describe, expect, test } from "vitest";
import { parseShellSections } from "../src/lib/sections";

describe("parseShellSections", () => {
  test("识别等长等号包夹的分节行,普通行合并透传", () => {
    const segments = parseShellSections("before\n=== 构建 ===\nstep 1\nstep 2\n==== 测试 ====\nafter");
    expect(segments).toEqual([
      { kind: "text", text: "before" },
      { kind: "section", title: "构建", raw: "=== 构建 ===" },
      { kind: "text", text: "step 1\nstep 2" },
      { kind: "section", title: "测试", raw: "==== 测试 ====" },
      { kind: "text", text: "after" },
    ]);
  });

  test("不对称等号/纯等号线/超长标题都按普通文本,不误伤构建横幅", () => {
    const input = "==== x ==\n======\n= short =\n" + `=== ${"y".repeat(90)} ===\nnormal`;
    const segments = parseShellSections(input);
    expect(segments).toEqual([{ kind: "text", text: input }]);
  });

  test("标题内含等号不识别;尾行是分节行时不产生空尾段", () => {
    const segments = parseShellSections("=== a=b ===");
    expect(segments).toEqual([{ kind: "text", text: "=== a=b ===" }]);
    expect(parseShellSections("text\n=== end ===")).toEqual([
      { kind: "text", text: "text" },
      { kind: "section", title: "end", raw: "=== end ===" },
    ]);
  });
});
