import { expect, test } from "vitest";
import { terminalPlainText } from "../src/lib/terminal-text";

test("剥离 SGR 颜色与 OSC 标题,保留正文", () => {
  expect(terminalPlainText("\u001b[32mgreen\u001b[0m plain")).toBe("green plain");
  expect(terminalPlainText("\u001b]0;cargo build\u0007Compiling\u001b[0m")).toBe("Compiling");
});

test("独立 \\r 按覆写语义保留最后一次重绘(编译进度条)", () => {
  const raw = "Compiling a\r          \rCompiling b [3/10]\n";
  expect(terminalPlainText(raw)).toBe("Compiling b [3/10]");
});

test("\\r\\n 是正常换行,不触发覆写", () => {
  expect(terminalPlainText("a\r\nb")).toBe("a\nb");
});

test("apt 式滚动区/存取光标重绘:定位丢弃,内容按到达顺序排列", () => {
  const raw = "\u001b[1;23r\u001b[1;1Hlog\r\n\u001b7\u001b[24;1HProgress: 10%\u001b8";
  expect(terminalPlainText(raw)).toBe("log\nProgress: 10%");
});

test("退格删除前一码点(代理对整体删除),bell 与其它 C0 丢弃", () => {
  expect(terminalPlainText("ab\u0008c")).toBe("ac");
  expect(terminalPlainText("中\u0008")).toBe("");
  expect(terminalPlainText("a\u0007b")).toBe("ab");
  expect(terminalPlainText("a\tb")).toBe("a\tb");
});

test("stderr 分隔行(组件注入的 ANSI 头)转为纯文本", () => {
  expect(terminalPlainText("\u001b[1m\u001b[31m── stderr ──\u001b[22m\u001b[39m")).toBe("── stderr ──");
});

test("纯文本幂等直通,尾部空白修剪", () => {
  expect(terminalPlainText("plain\nlines\n")).toBe("plain\nlines");
  expect(terminalPlainText("")).toBe("");
  expect(terminalPlainText("text\u001b")).toBe("text");
});
