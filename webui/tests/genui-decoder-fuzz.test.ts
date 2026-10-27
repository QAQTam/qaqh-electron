/**
 * ContentDecoder 不变量 fuzz(确定性种子,锁分帧契约):
 *  1. final 行账:分帧结果的行集合 == 原文行集合 − 结构行(UI 围栏开/关门行);
 *     空 part 不携带内容,空行只参与 part 边界。
 *  2. live 不发明:未 seal 的分帧行 ⊆ 原文行(holdback 允许整段缺失,不许无中生有)。
 *  3. 增量 == 纯函数:任何前缀上 createContentDecoder.push 与 splitContentParts 深相等。
 *  4. final 幂等:push(text, true) 后重复 push 不追加内容。
 *  5. 定向:同一文本两次完整围栏 → 两个独立 ui part(seal 不串扰)。
 */
import { describe, expect, it } from "vitest";
import { splitContentParts, createContentDecoder } from "../src/genui/source/decoder";

/** 独立 oracle(与 decoder 不同的实现路径):返回被消费的「结构行」下标集合——
 * UI 围栏的开门/关门行不进任何 part;普通围栏开门/关门行保留在 md 内容里。 */
function structuralLines(text: string): Set<number> {
  const lines = text.split("\n");
  const eaten = new Set<number>();
  let fenceLen = 0;
  let uiLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,})(.*)$/.exec(lines[i]!);
    const info = (open?.[2] ?? "").trim();
    if (uiLen > 0) {
      if (open != null && open[1]!.length >= uiLen && info === "") { eaten.add(i); uiLen = 0; }
      continue;
    }
    if (fenceLen > 0) {
      if (open != null && open[1]!.length >= fenceLen && info === "") fenceLen = 0;
      continue;
    }
    if (open != null && info !== "" && info.startsWith("qaqh-ui")) { eaten.add(i); uiLen = open[1]!.length; continue; }
    if (open != null) fenceLen = open[1]!.length;
  }
  return eaten;
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const FENCE = "```qaqh-ui v=0.1 format=tsx\nui.surface(\"s\");\nui.end();\n```\n";

describe("decoder 不变量 fuzz", () => {
  it("20000 组随机围栏文本:final 行账 == oracle / live 不发明 / 增量 == 纯函数", () => {
    const tokens = [
      "```qaqh-ui v=0.1 format=tsx\n", "```qaqh-ui v=0.1 format=jsonl\n", "```\n", "```\n\n",
      "ui.surface(\"s\");\n", "ui.node(\"a\", <Text text=\"x\" />);\n", "ui.end();\n",
      "{\"op\":\"surface.open\",\"surface\":\"t\"}\n", "{\"op\":\"surface.close\"}\n",
      "正文行\n", "```tsx\n", "code\n", "`", "``", "```", "\n", " ",
    ];
    let seed = 20261012;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let round = 0; round < 20000; round++) {
      const n = 1 + Math.floor(rnd() * 8);
      let text = "";
      for (let j = 0; j < n; j++) text += tokens[Math.floor(rnd() * tokens.length)];

      const eaten = structuralLines(text);
      const bodyLines = text.split("\n").filter((_, index) => !eaten.has(index)).filter((line) => line !== "" && !/^ {0,3}`{3,}/.test(line));
      const final = splitContentParts(text, { final: true });
      const gotLines = final
        .map((part) => (part.kind === "markdown" ? part.text : part.source))
        .flatMap((chunk) => (chunk === "" ? [] : chunk.split("\n")))
        .filter((line) => line !== "" && !/^ {0,3}`{3,}/.test(line));
      if (!eq(gotLines.slice().sort(), bodyLines.slice().sort())) {
        expect({ case: round, text, got: gotLines, want: bodyLines }).toEqual({ case: round, text: "", got: bodyLines, want: bodyLines });
      }

      const live = splitContentParts(text, { final: false });
      const liveLines = live.map((part) => (part.kind === "markdown" ? part.text : part.source));
      const bodySet = new Set(text.split("\n"));
      const orphans = liveLines.filter((line) => line !== "" && !bodySet.has(line) && !line.split("\n").every((row) => bodySet.has(row)));
      expect(orphans, `case ${round}: ${JSON.stringify(text)}`).toEqual([]);

      const decoder = createContentDecoder();
      for (let cut = 1; cut <= text.length; cut++) {
        const prefix = text.slice(0, cut);
        const actual = decoder.push(prefix);
        const expected = splitContentParts(prefix, { final: false });
        if (!eq(actual, expected)) {
          expect({ case: round, prefix, decoder: actual, pureFn: expected }).toEqual({ case: round, prefix, decoder: expected, pureFn: expected });
        }
      }
      const sealedDecoder = createContentDecoder();
      sealedDecoder.push(text, true);
      expect(sealedDecoder.push(text, true), `case ${round} final 幂等`).toEqual(final);
    }
  }, 30_000);

  it("定向:同一文本两次完整围栏 → 两个独立 ui part(seal 不串扰)", () => {
    const parts = splitContentParts(FENCE + FENCE, { final: true });
    expect(parts.filter((part) => part.kind === "ui")).toHaveLength(2);
  });

  it("定向:围栏头后的空行不被 live 行替换吞掉(空行计入 source)", () => {
    const decoder = createContentDecoder();
    // 流式:开门行 + 空行都已确认,live 行 "u" 追加时不得吃掉空行。
    decoder.push("```qaqh-ui v=0.1 format=tsx\n\n");
    const live = decoder.push("```qaqh-ui v=0.1 format=tsx\n\nu");
    expect(live).toEqual([{ kind: "ui", version: "0.1", format: "tsx", source: "\nu", sealed: false }]);
  });
});
