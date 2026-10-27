import { expect, test } from "vitest";
import { parseAnsi } from "../src/lib/ansi";

test("ANSI 默认/复位槽为 null 时仍解码，不能泄露控制序列", () => {
  const chunks = parseAnsi("\u001b[32mhello\u001b[0m world");
  expect(chunks.map((chunk) => chunk.text).join("")).toBe("hello world");
  expect(chunks.find((chunk) => chunk.text === "hello")?.color).toBe("rgb(0, 187, 0)");
  expect(chunks.find((chunk) => chunk.text === " world")?.color).toBeUndefined();
});

test("ANSI 同时保留粗体、斜体和背景色", () => {
  const chunk = parseAnsi("\u001b[1;3;44mhello\u001b[0m").find((item) => item.text === "hello");
  expect(chunk).toMatchObject({ bold: true, italic: true, background: "rgb(0, 0, 187)" });
});

test("同色多行输出合并节点，不按每个 reset/newline 成倍增长", () => {
  const chunks = parseAnsi(Array.from({ length: 100 }, (_, i) => `\u001b[32mtest ${i}\u001b[0m\n`).join(""));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text.split("\n")).toHaveLength(101);
  expect(chunks[0]!.color).toBe("rgb(0, 187, 0)");
});
