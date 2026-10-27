/** diff 配对与词级高亮(spec §1.3 允许的纯逻辑单测)。 */
import { describe, expect, test } from "vitest";
import { fileTotalLines, findWordPairs, flattenFileRows, languageOf, omittedLinesBefore, pairLines, parseUnifiedDiff, trailingWhitespace, wordSegments } from "../src/diff/parse";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
\\ No newline at end of file
diff --git a/bin/img b/bin/img
new file mode 100644
Binary files /dev/null and b/bin/img differ
`;

describe("parseUnifiedDiff", () => {
  test("多文件、行号、统计、noeol、二进制", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(2);
    const first = files[0]!;
    expect(first.path).toBe("src/a.ts");
    expect(first.status).toBe("modified");
    expect(first.stats).toEqual({ add: 2, del: 1 });
    expect(first.hunks[0]!.lines).toHaveLength(5);
    const del = first.hunks[0]!.lines[1]!;
    expect(del).toMatchObject({ t: "del", oldNo: 2, text: "const b = 2;" });
    const add = first.hunks[0]!.lines[2]!;
    expect(add).toMatchObject({ t: "add", newNo: 2, text: "const b = 3;" });
    // noeol 标在最后一个 ctx 行(原始文本无行尾换行)
    const last = first.hunks[0]!.lines[4]!;
    expect(last.noeol).toBe(true);
    const binary = files[1]!;
    expect(binary.binary).toBe(true);
    expect(binary.status).toBe("added");
    expect(binary.hunks).toHaveLength(0);
  });

  test("省略行数 = 相邻 hunk 行号差", () => {
    const text = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-a
+b
@@ -20,1 +20,1 @@
-x
+y
`;
    const file = parseUnifiedDiff(text)[0]!;
    expect(omittedLinesBefore(file, 0)).toBe(0);
    expect(omittedLinesBefore(file, 1)).toBe(17); // 20 - (1+2)
  });
});

// 后端 `file_shared::unified_diff`(similar)产出**不带** `diff --git` 头,只有
// `--- a/x` / `+++ b/x` / `@@` —— 曾经整段解析成 0 文件,正文渲染为空。
describe("裸 unified diff(无 diff --git 头)", () => {
  const BARE = `--- a/src/a.rs
+++ b/src/a.rs
@@ -1,2 +1,3 @@
 keep
-old
+new
+extra
`;

  test("无 diff --git 头也能建文件、解析 hunk、统计行差", () => {
    const files = parseUnifiedDiff(BARE);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/a.rs");
    expect(files[0]!.stats).toEqual({ add: 2, del: 1 });
    expect(files[0]!.hunks[0]!.lines).toHaveLength(4);
  });

  test("hunk 内以 -- / ++ 开头的内容行不被当成文件头", () => {
    const text = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
--- foo
+++ bar
`;
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]!.stats).toEqual({ add: 1, del: 1 });
  });

  test("多个裸文件相邻(拼接导出)按 --- 边界切开", () => {
    const text = `${BARE}--- b/src/b.rs
+++ b/src/b.rs
@@ -1 +1 @@
-x
+y
`;
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(["src/a.rs", "src/b.rs"]);
    expect(files[0]!.stats).toEqual({ add: 2, del: 1 });
    expect(files[1]!.stats).toEqual({ add: 1, del: 1 });
  });
});

describe("findWordPairs / wordSegments(§9.3 宁缺毋滥)", () => {
  test("等长 del/add 连续段按下标配对;不等长不配对(§9.3)", () => {
    const text = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,5 +1,5 @@
-del one
-del two
+add one
+add two
 ctx
@@ -10,2 +10,3 @@
-del x
+add x
+extra
`;
    const hunks = parseUnifiedDiff(text)[0]!.hunks;
    const equal = findWordPairs(hunks[0]!);
    expect(equal).toHaveLength(2);
    expect(equal[0]!.del.text).toBe("del one");
    expect(equal[0]!.add.text).toBe("add one");
    expect(equal[1]!.del.text).toBe("del two");
    // 2 删 3 增:行数不等 → 整段不配对(宁缺毋滥)
    expect(findWordPairs(hunks[1]!)).toHaveLength(0);
  });

  test("超 2000 字符的行不做词级配对", () => {
    const long = "x".repeat(2_001);
    const text = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-${long}
+${long}y
`;
    const hunk = parseUnifiedDiff(text)[0]!.hunks[0]!;
    expect(findWordPairs(hunk)).toHaveLength(0);
  });

  test("词级片段包含 removed/added 标记", () => {
    const { del, add } = wordSegments("const a = 1;", "const a = 2;");
    expect(del.some((segment) => segment.kind === "removed")).toBe(true);
    expect(add.some((segment) => segment.kind === "added")).toBe(true);
  });

  test("行尾空白检测", () => {
    expect(trailingWhitespace("abc  ")).toBe("  ");
    expect(trailingWhitespace("abc")).toBeNull();
  });

  test("语言推断", () => {
    expect(languageOf("a/b/c.rs")).toBe("rust");
    expect(languageOf("noext")).toBeNull();
  });
});

describe("flattenFileRows(虚拟化)", () => {
  const SAMPLE = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 ctx one
-del one
+add one
 ctx two
@@ -20,2 +20,2 @@
-del x
+add x
`;

  test("flattenFileRows:hunk 间省略行与 hunk 头各占一行,行对象共享引用", () => {
    const file = parseUnifiedDiff(SAMPLE)[0]!;
    const rows = flattenFileRows(file);
    // hunkhead×2 + 行 4+2 + hunk 间省略 16 行 = 9(首 hunk 前无省略,不出 omit 行)
    expect(rows).toHaveLength(9);
    expect(rows[0]!.kind).toBe("hunkhead");
    expect(rows[1]).toMatchObject({ kind: "line", line: { text: "ctx one" } });
    const omit = rows.find((row) => row.kind === "omit" && row.count > 0);
    expect(omit).toEqual({ kind: "omit", count: 16 });
  });

  test("超过富渲染门槛的行集仍全量展开(降级只砍每行代价,不藏行)", () => {
    // DiffFileView 的 rich 门槛是 1200 行;超限后过去会被 head/tail 截到 800 行,
    // 中段行用户永远看不到。现在两条路径都走固定行高虚拟开窗,DOM 只挂可见行,
    // 所以行集必须保持完整——这里锁住「flatten 不产生截断 omit」这条前提。
    const total = 1300;
    const body = Array.from({ length: total }, (_, i) => `+line ${i}`).join("\n");
    const file = parseUnifiedDiff(`--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,${total} @@\n${body}\n`)[0]!;
    expect(fileTotalLines(file)).toBe(total);
    const rows = flattenFileRows(file);
    expect(rows).toHaveLength(total + 1); // +1 = hunk 头
    expect(rows.some((row) => row.kind === "omit")).toBe(false);
  });

  test("pairLines:廉价映射,含超长行守卫", () => {
    const text = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-del one
+add one
-${"x".repeat(2_001)}
+${"x".repeat(2_001)}y
`;
    const hunk = parseUnifiedDiff(text)[0]!.hunks[0]!;
    const pairs = pairLines(hunk);
    expect(pairs.size).toBe(2); // 只有第一对;超长行不入映射
    expect(pairs.get(hunk.lines[0]!)).toBe(hunk.lines[1]);
  });
});
