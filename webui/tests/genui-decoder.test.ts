import { describe, expect, it } from "vitest";
import { createContentDecoder, splitContentParts } from "../src/genui/source/decoder";

const TSX_FENCE = "```qaqh-ui v=0.1 format=tsx";
const JSONL_FENCE = "```qaqh-ui v=0.1 format=jsonl";
const COUNTER = [
  'ui.surface("counter", { root: "card", fallback: "计数器，初始值为 0。" });',
  'ui.node("card", <Card title="计数器" />);',
  "ui.end();",
].join("\n");

const kinds = (parts: ReturnType<typeof splitContentParts>) => parts.map((part) => part.kind);

describe("genui ContentDecoder 分帧", () => {
  it("无反引号文本走快路径,单一 markdown 分帧", () => {
    const parts = splitContentParts("普通回答,没有代码块。");
    expect(parts).toEqual([{ kind: "markdown", text: "普通回答,没有代码块。" }]);
    expect(splitContentParts("")).toEqual([]);
  });

  it("普通代码围栏仍是 markdown", () => {
    const text = "前文\n```tsx\nconst a = 1;\n```\n后文";
    expect(kinds(splitContentParts(text))).toEqual(["markdown"]);
  });

  it("闭合的 qaqh-ui 围栏夹在 markdown 之间 → 三段,提取 surfaceId/fallback", () => {
    const text = `说明文字\n${TSX_FENCE}\n${COUNTER}\n\`\`\`\n结尾`;
    const parts = splitContentParts(text);
    expect(kinds(parts)).toEqual(["markdown", "ui", "markdown"]);
    const ui = parts[1]!;
    if (ui.kind !== "ui") throw new Error("expected ui part");
    expect(ui.sealed).toBe(true);
    expect(ui.format).toBe("tsx");
    expect(ui.surfaceId).toBe("counter");
    expect(ui.fallback).toBe("计数器，初始值为 0。");
    expect(ui.source).toBe(COUNTER);
    expect(parts[0]).toEqual({ kind: "markdown", text: "说明文字" });
    expect(parts[2]).toEqual({ kind: "markdown", text: "结尾" });
  });

  it("未闭合围栏 → ui 分帧 sealed=false,不回流 markdown", () => {
    const parts = splitContentParts(`开头\n${TSX_FENCE}\nui.surface("a");`);
    expect(kinds(parts)).toEqual(["markdown", "ui"]);
    const ui = parts[1]!;
    if (ui.kind !== "ui") throw new Error("expected ui part");
    expect(ui.sealed).toBe(false);
    expect(ui.source).toBe('ui.surface("a");');
  });

  it("流式 holdback:裸 ``` 与 info 前缀尾行先缓冲,不渲染也不提前开 UI", () => {
    for (const tail of ["`", "``", "```", "```q", "```qaqh-ui", "```qaqh-ui v", "```qaqh-ui v=0.1 format=tsx"]) {
      const parts = splitContentParts(`正文\n${tail}`);
      expect(kinds(parts), `tail=${tail}`).toEqual(["markdown"]);
      const md = parts[0]!;
      if (md.kind !== "markdown") throw new Error("expected markdown part");
      expect(md.text.endsWith(tail), `tail=${tail} 不应进入渲染`).toBe(false);
    }
  });

  it("普通语言名不是 qaqh-ui info 前缀,不 holdback", () => {
    const parts = splitContentParts("```tsx");
    expect(kinds(parts)).toEqual(["markdown"]);
    const md = parts[0]!;
    if (md.kind !== "markdown") throw new Error("expected markdown part");
    expect(md.text).toBe("```tsx");
  });

  it("final 模式不再 holdback,尾行按字面渲染", () => {
    const parts = splitContentParts("正文\n```qaqh-u", { final: true });
    expect(kinds(parts)).toEqual(["markdown"]);
    const md = parts[0]!;
    if (md.kind !== "markdown") throw new Error("expected markdown part");
    expect(md.text).toBe("正文\n```qaqh-u");
  });

  it("围栏行终止后立即开 UI(生成中占位,source 可为空)", () => {
    const parts = splitContentParts(`回答\n${TSX_FENCE}\n`);
    expect(kinds(parts)).toEqual(["markdown", "ui"]);
    const ui = parts[1]!;
    if (ui.kind !== "ui") throw new Error("expected ui part");
    expect(ui.sealed).toBe(false);
    expect(ui.source).toBe("");
  });

  it("反引号长度配对:4 背针开门不被 3 背针关门截断;更长外层围栏展示语法不触发", () => {
    const longer = "````qaqh-ui v=0.1 format=tsx";
    const inner = "```" ;
    const parts = splitContentParts(`${longer}\n${inner}\n${COUNTER}\n\`\`\`\n\`\`\`\``.replace("````qaqh", "````qaqh"));
    const ui = parts.find((part) => part.kind === "ui");
    expect(ui).toBeDefined();
    if (ui?.kind !== "ui") throw new Error("expected ui part");
    expect(ui.sealed).toBe(true);
    expect(ui.source).toContain(COUNTER);

    const showcase = `\`\`\`\`\`md\n${TSX_FENCE}\n${COUNTER}\n\`\`\`\n\`\`\`\``;
    expect(kinds(splitContentParts(showcase))).toEqual(["markdown"]);
  });

  it("引用块与 4 空格缩进里的 qaqh-ui 围栏不触发", () => {
    expect(kinds(splitContentParts("> ```qaqh-ui v=0.1 format=tsx\n> ui.end();\n> ```"))).toEqual(["markdown"]);
    expect(kinds(splitContentParts("    ```qaqh-ui v=0.1 format=tsx\n    ui.end();\n    ```"))).toEqual(["markdown"]);
  });

  it("普通围栏内部出现 qaqh-ui 行不触发(fence 状态追踪)", () => {
    const text = "```md\n" + TSX_FENCE + "\n" + COUNTER + "\n```\n正文";
    expect(kinds(splitContentParts(text))).toEqual(["markdown"]);
  });

  it("info 串含反引号不是围栏(CommonMark),不触发", () => {
    expect(kinds(splitContentParts("```qaqh-ui `x`\nui.end();\n```"))).toEqual(["markdown"]);
  });

  it("jsonl 格式:从 surface.open 行提取 surfaceId/fallback", () => {
    const text = [
      JSONL_FENCE,
      '{"op":"surface.open","surface":"plan-card","fallback":"计划概览"}',
      '{"op":"node.upsert","surface":"plan-card","id":"root","node":{"type":"Card"}}',
      '{"op":"surface.seal","surface":"plan-card"}',
      "```",
    ].join("\n");
    const parts = splitContentParts(text);
    expect(kinds(parts)).toEqual(["ui"]);
    const ui = parts[0]!;
    if (ui.kind !== "ui") throw new Error("expected ui part");
    expect(ui.format).toBe("jsonl");
    expect(ui.sealed).toBe(true);
    expect(ui.surfaceId).toBe("plan-card");
    expect(ui.fallback).toBe("计划概览");
  });

  it("markdown 部分前缀稳定(流式增量不整块重写)", () => {
    let previous = "";
    const chunks = ["开头\n", "```qaqh-ui v=0.1 format=tsx\n", 'ui.surface("c");\n', "ui.end();\n", "```\n结尾"];
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      const parts = splitContentParts(text);
      const md = parts.find((part) => part.kind === "markdown" && part.text === previous);
      if (previous !== "" && md == null) {
        // markdown 分帧要么保持原文,要么被 UI 围栏截断后不再增长
        const closed = parts.find((part) => part.kind === "markdown");
        expect(closed == null || previous.startsWith(closed.kind === "markdown" ? closed.text : "")).toBe(true);
      }
      const current = parts.find((part) => part.kind === "markdown");
      previous = current?.kind === "markdown" ? current.text : "";
    }
  });

  it("非法 info(qaqh-ui 缺 v/format)按普通代码围栏处理", () => {
    expect(kinds(splitContentParts("```qaqh-ui\nui.end();\n```"))).toEqual(["markdown"]);
    expect(kinds(splitContentParts("```qaqh-ui v=2 format=tsx\nui.end();\n```"))).toEqual(["markdown"]);
  });
});

describe("genui ContentDecoder 增量水位", () => {
  const COUNTER_FULL = [
    'ui.surface("counter", { root: "card", fallback: "计数器，初始值为 0。" });',
    'const count = ui.state("count", "integer", 0);',
    'ui.node("card", <Card title="计数器" children={["value", "increment"]} />);',
    'ui.node("value", <Metric label="当前计数" value={count} />);',
    'ui.node("increment", <Button label="增加" onPress={ui.set("count", count + 1)} />);',
    "ui.end();",
  ].join("\n");
  const DOC = [
    "开头说明",
    "```tsx",
    "const x = 1;",
    "```",
    TSX_FENCE,
    COUNTER_FULL,
    "```",
    "结尾说明",
  ].join("\n");

  const assertSameAsPure = (text: string, final: boolean, parts: ReturnType<typeof splitContentParts>) => {
    expect(parts).toEqual(splitContentParts(text, { final }));
  };

  it("任意前缀序列上与纯函数深相等(含 holdback、seal、普通围栏)", () => {
    const decoder = createContentDecoder();
    const earlier = DOC.slice(0, DOC.indexOf(TSX_FENCE) + 12); // 断在围栏头中间
    for (let end = 1; end <= DOC.length; end += 1) {
      const text = DOC.slice(0, end);
      if (text === earlier) continue; // 已在前缀序列里,无特殊分支
      assertSameAsPure(text, false, decoder.push(text));
    }
    assertSameAsPure(DOC, true, decoder.push(DOC, true));
    // final 幂等
    expect(decoder.push(DOC, true)).toEqual(splitContentParts(DOC, { final: true }));
  });

  it("live 行瞬时 seal 与长出的闭合线不产生重复分帧", () => {
    const decoder = createContentDecoder();
    const head = `前文\n${TSX_FENCE}\nui.surface("s");\n`;
    let parts = decoder.push(head);
    expect(parts.at(-1)).toMatchObject({ kind: "ui", sealed: false });
    parts = decoder.push(`${head}\`\`\``); // live 行恰好是闭合线 → 瞬时 seal
    expect(parts.at(-1)).toMatchObject({ kind: "ui", sealed: true });
    expect(parts.filter((part) => part.kind === "ui")).toHaveLength(1);
    parts = decoder.push(`${head}\`\`\`\n`); // 落定:仍只有一个 ui 分帧
    expect(parts.filter((part) => part.kind === "ui")).toHaveLength(1);
    expect(parts.at(-1)).toMatchObject({ kind: "ui", sealed: true, source: 'ui.surface("s");' });
    assertSameAsPure(`${head}\`\`\`\n`, false, parts);
  });

  it("前缀被改写(非 startsWith)回退全量重扫并计数", () => {
    const decoder = createContentDecoder();
    decoder.push("abcdef\ngh\n");
    expect(decoder.stats().rescans).toBe(0);
    decoder.push("完全不同\n");
    expect(decoder.stats().rescans).toBe(1);
    assertSameAsPure("完全不同\n", false, decoder.push("完全不同\n"));
    decoder.push("完全不同\n第二行\n");
    expect(decoder.stats().rescans).toBe(1, "前缀追加不重扫");
    decoder.push("又改了\n");
    expect(decoder.stats().rescans).toBe(2);
  });

  it("stress:逐块流式推送 60KB 文档,总扫描量线性(水位生效)", () => {
    const body = Array.from({ length: 800 }, (_, index) => `第 ${index} 行说明文字,一些普通 markdown 内容。`).join("\n");
    const text = `${body}\n${TSX_FENCE}\n${COUNTER_FULL}\n\`\`\`\n收尾`;
    const decoder = createContentDecoder();
    const chunk = 64;
    for (let end = chunk; end < text.length; end += chunk) decoder.push(text.slice(0, end));
    const parts = decoder.push(text, true);
    expect(parts.at(-1)?.kind).toBe("markdown");
    const { scannedChars, rescans } = decoder.stats();
    expect(rescans).toBe(0);
    expect(scannedChars).toBeLessThanOrEqual(text.length + chunk); // 每个字符只扫一次,而非 O(n²)
  });
});
