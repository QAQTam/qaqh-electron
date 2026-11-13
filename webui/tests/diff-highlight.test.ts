/**
 * diff 高亮宿主定向测试(真实 shiki core,node 环境)。
 * 立此存照的历史 bug:界面 mode(light/dark)曾被直接当 shiki 主题名传入,
 * 注册名实为 github-light/github-dark → 永远 throw → 静默退纯文本。
 * 本测试断言「内置对真的出彩色 token」,并覆盖插件主题包加载/回退。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { highlight } from "../src/diff/highlight";
import type { SyntaxPackRef } from "../src/plugins/loader";

const CODE = "const answer: number = 42; // 暖纸\nfunction greet(name: string) { return `hi ${name}`; }";

function dataUrl(json: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(json))}`;
}

function warmpaperPack(): SyntaxPackRef {
  const dir = resolve(__dirname, "../../plugins/qaqh-syntax-warmpaper");
  const light = JSON.parse(readFileSync(resolve(dir, "light.json"), "utf8"));
  const dark = JSON.parse(readFileSync(resolve(dir, "dark.json"), "utf8"));
  return { id: "qaqh-syntax-warmpaper", rev: "test", light: dataUrl(light), dark: dataUrl(dark) };
}

function flatColors(tokens: Awaited<ReturnType<typeof highlight>>): Set<string> {
  const colors = new Set<string>();
  for (const line of tokens) for (const token of line) if (token.color) colors.add(token.color.toUpperCase());
  return colors;
}

describe("diff 高亮宿主", () => {
  it("内置 light/dark 都出彩色 token(主题名映射回归)", async () => {
    const light = await highlight(CODE, "typescript", "light", null);
    const dark = await highlight(CODE, "typescript", "dark", null);
    expect(light.length).toBeGreaterThan(0);
    expect(flatColors(light).size).toBeGreaterThan(2);
    expect(flatColors(dark).size).toBeGreaterThan(2);
    // 文本守恒:token 拼回原文(§9.4 不得改变文本)。
    expect(light.map((line) => line.map((t) => t.content).join("")).join("\n")).toBe(CODE);
  });

  it("插件主题包:真实暖纸资产上色,keyword 走陶土红", async () => {
    const tokens = await highlight(CODE, "typescript", "light", warmpaperPack());
    const colors = flatColors(tokens);
    expect(colors.has("#9A4A2E")).toBe(true); // keyword
    expect(colors.has("#5E7042")).toBe(true); // string(模板串)
    const dark = await highlight(CODE, "typescript", "dark", warmpaperPack());
    expect(flatColors(dark).has("#E0906A")).toBe(true); // dark keyword 余烬橙
  });

  it("坏包回退内置对,高亮不全灭", async () => {
    const broken: SyntaxPackRef = { id: "broken", rev: "x", light: "data:application/json,not-json", dark: "data:application/json,not-json" };
    const tokens = await highlight(CODE, "typescript", "light", broken);
    expect(flatColors(tokens).size).toBeGreaterThan(2);
  });

  it("未知语言 throw(渲染层走纯文本兜底)", async () => {
    await expect(highlight(CODE, "brainfuck", "light", null)).rejects.toThrow();
  });
});
