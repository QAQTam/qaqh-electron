import { describe, expect, test } from "vitest";
import { extractTurnDeliverables, getTurnFileDiff, splitPath } from "../src/diff/deliverables";
import { diffReviewStore } from "../src/diff/review-store";
import type { ToolStep, Turn } from "../src/session/types";

describe("splitPath", () => {
  test("路径拆分目录与文件名", () => {
    expect(splitPath("src/stores/editorStore.ts")).toEqual({
      directory: "src/stores/",
      filename: "editorStore.ts",
    });
    expect(splitPath("package.json")).toEqual({
      directory: "",
      filename: "package.json",
    });
    expect(splitPath("nested\\win\\path.rs")).toEqual({
      directory: "nested/win/",
      filename: "path.rs",
    });
  });
});

describe("extractTurnDeliverables", () => {
  const sampleDiff1 = `diff --git a/src/stores/editorStore.ts b/src/stores/editorStore.ts
--- a/src/stores/editorStore.ts
+++ b/src/stores/editorStore.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

  const sampleDiff2 = `diff --git a/src/components/Editor.tsx b/src/components/Editor.tsx
--- a/src/components/Editor.tsx
+++ b/src/components/Editor.tsx
@@ -10,3 +10,4 @@
 function Editor() {
+  return <div />;
 }
`;

  test("无文件修改工具的回合返回 null", () => {
    const turn: Turn = {
      id: "t1",
      key: "t1",
      turnIndex: 0,
      user: { text: "hello" },
      steps: [
        {
          kind: "tool",
          id: "step1",
          seq: 1,
          name: "exec",
          status: "finished",
          output: { text: "done" },
        },
      ],
      answer: { text: "Hi" },
      answerStepId: "a1",
      status: "done",
      expanded: true,
    };

    expect(extractTurnDeliverables(turn)).toBeNull();
  });

  test("多文件成功修改时聚合出轻量指纹，包含统计与去重", () => {
    const turn: Turn = {
      id: "t2",
      key: "t2",
      turnIndex: 1,
      user: { text: "modify files" },
      steps: [
        {
          kind: "tool",
          id: "step1",
          seq: 1,
          name: "edit",
          status: "finished",
          output: { diffText: sampleDiff1 },
        },
        {
          kind: "tool",
          id: "step2",
          seq: 2,
          name: "edit",
          status: "finished",
          output: { diffText: sampleDiff2 },
        },
      ],
      answer: { text: "Done editing" },
      answerStepId: "a2",
      status: "done",
      expanded: true,
    };

    const deliverables = extractTurnDeliverables(turn);
    expect(deliverables).not.toBeNull();
    expect(deliverables!.totalFiles).toBe(2);
    expect(deliverables!.totalAdditions).toBe(3); // 2 + 1
    expect(deliverables!.totalDeletions).toBe(1); // 1 + 0
    expect(deliverables!.files).toHaveLength(2);

    const f1 = deliverables!.files.find((f) => f.path === "src/stores/editorStore.ts");
    expect(f1).toBeDefined();
    expect(f1!.filename).toBe("editorStore.ts");
    expect(f1!.directory).toBe("src/stores/");
    expect(f1!.additions).toBe(2);
    expect(f1!.deletions).toBe(1);
    expect(f1!.stepIds).toEqual(["step1"]);

    const f2 = deliverables!.files.find((f) => f.path === "src/components/Editor.tsx");
    expect(f2).toBeDefined();
    expect(f2!.filename).toBe("Editor.tsx");
    expect(f2!.directory).toBe("src/components/");
    expect(f2!.additions).toBe(1);
    expect(f2!.deletions).toBe(0);
    expect(f2!.stepIds).toEqual(["step2"]);
  });

  test("同一回合内同一文件被多次修改时合并统计与 stepIds", () => {
    const secondDiffForFile1 = `diff --git a/src/stores/editorStore.ts b/src/stores/editorStore.ts
--- a/src/stores/editorStore.ts
+++ b/src/stores/editorStore.ts
@@ -20,2 +20,4 @@
-oldLine
+newLine1
+newLine2
`;

    const turn: Turn = {
      id: "t3",
      key: "t3",
      turnIndex: 2,
      user: { text: "double edit" },
      steps: [
        {
          kind: "tool",
          id: "step1",
          seq: 1,
          name: "edit",
          status: "finished",
          output: { diffText: sampleDiff1 },
        },
        {
          kind: "tool",
          id: "step3",
          seq: 3,
          name: "edit",
          status: "finished",
          output: { diffText: secondDiffForFile1 },
        },
      ],
      answer: null,
      answerStepId: null,
      status: "done",
      expanded: true,
    };

    const deliverables = extractTurnDeliverables(turn);
    expect(deliverables).not.toBeNull();
    expect(deliverables!.totalFiles).toBe(1);
    expect(deliverables!.files[0]!.additions).toBe(4); // 2 + 2
    expect(deliverables!.files[0]!.deletions).toBe(2); // 1 + 1
    expect(deliverables!.files[0]!.stepIds).toEqual(["step1", "step3"]);
  });

  test("getTurnFileDiff 按需提取特定文件的 diff 文本", () => {
    const turn: Turn = {
      id: "t4",
      key: "t4",
      turnIndex: 3,
      user: { text: "fetch diff" },
      steps: [
        {
          kind: "tool",
          id: "step1",
          seq: 1,
          name: "edit",
          status: "finished",
          output: { diffText: sampleDiff1 },
        },
      ],
      answer: null,
      answerStepId: null,
      status: "done",
      expanded: true,
    };

    const diff = getTurnFileDiff(turn, "src/stores/editorStore.ts");
    expect(diff).not.toBeNull();
    expect(diff).toContain("const b = 3;");

    const missing = getTurnFileDiff(turn, "non/existent.ts");
    expect(missing).toBeNull();
  });
});

describe("v3 tool output and structured code deltas", () => {
  const cwd = "E:\\qaqh-backend";
  const wireDiff = `--- E:\\qaqh-backend\\crates\\qaqh-siwc\\Cargo.toml
+++ E:\\qaqh-backend\\crates\\qaqh-siwc\\Cargo.toml
@@ -0,0 +1,3 @@
+[package]
+name = "qaqh-siwc"
+version = "0.1.0"
`;

  function turnFromWriteTool(output?: ToolStep["output"], codeDelta?: ToolStep["codeDelta"]): Turn {
    const step: ToolStep = {
      kind: "tool",
      id: "w1",
      seq: 0,
      name: "write",
      status: "finished",
      output,
      codeDelta,
    };
    return {
      id: "t1",
      key: "t1",
      turnIndex: null,
      user: { text: "write" },
      steps: [step],
      answer: null,
      answerStepId: null,
      status: "done",
      expanded: false,
    };
  }

  test("raw unified diff provides file paths and code_delta supplies aggregate counts", () => {
    const turn = turnFromWriteTool(
      { text: "[OK] Cargo.toml written", diffText: wireDiff },
      { lines_added: 3, lines_removed: 0, files_created: 1, files_deleted: 0, file: null },
    );
    const step = turn.steps[0]!;
    if (step.kind !== "tool") throw new Error("expect tool");
    expect(step.output?.diffText).toBe(wireDiff);
    expect(step.output?.text).toContain("written");

    const deliverables = extractTurnDeliverables(turn, cwd);
    expect(deliverables).not.toBeNull();
    expect(deliverables!.files).toEqual([
      expect.objectContaining({
        path: "crates/qaqh-siwc/Cargo.toml",
        filename: "Cargo.toml",
        status: "added",
        additions: 3,
        deletions: 0,
      }),
    ]);
    expect(getTurnFileDiff(turn, "crates/qaqh-siwc/Cargo.toml", cwd)).toContain("+name = \"qaqh-siwc\"");
  });

  test("code_delta without raw diff does not invent a file row or unified diff", () => {
    const turn = turnFromWriteTool(undefined, {
      lines_added: 3, lines_removed: 1, files_created: 1, files_deleted: 0, file: null,
    });
    expect(extractTurnDeliverables(turn, cwd)).toBeNull();
    expect(getTurnFileDiff(turn, "crates/qaqh-siwc/Cargo.toml", cwd)).toBeNull();
  });
});

/**
 * Multi-file raw unified diff stays path-addressable; code_delta supplies the
 * aggregate net line count without being rendered as diff text.
 */
describe("apply_patch multi-file raw diff", () => {
  const wireApplyPatchDiff = `--- a/replica/src/App.tsx
+++ b/replica/src/App.tsx
@@ -1,3 +1,4 @@
 import { render } from "solid-js/web";
+import { Patch } from "./patch";
 render(<App />, root);
 export default App;
--- a/replica/src/created.ts
+++ b/replica/src/created.ts
@@ -0,0 +1,2 @@
+export const created = true;
+export const why = "apply_patch";
`;

  function applyPatchTurn(): Turn {
    const step: ToolStep = {
      kind: "tool",
      id: "p1",
      seq: 0,
      name: "apply_patch",
      status: "finished",
      codeDelta: { lines_added: 3, lines_removed: 0, files_created: 1, files_deleted: 0, file: null },
      output: { text: "[OK] apply_patch — applied: 2 file(s), +3 -0", diffText: wireApplyPatchDiff },
    };
    return {
      id: "t1",
      key: "t1",
      turnIndex: null,
      user: { text: "patch" },
      steps: [step],
      answer: null,
      answerStepId: null,
      status: "done",
      expanded: false,
    };
  }

  test("跨文件按 diff 段切成两个交付物,而不是只认 header 的 first_path", () => {
    const deliverables = extractTurnDeliverables(applyPatchTurn());
    expect(deliverables!.files.map((file) => file.path)).toEqual([
      "replica/src/App.tsx",
      "replica/src/created.ts",
    ]);
    expect(deliverables!.files[0]).toEqual(
      expect.objectContaining({ status: "modified", additions: 1, deletions: 0 })
    );
    // 新建段靠 `@@ -0,0` 判 added（后端不写 /dev/null）
    expect(deliverables!.files[1]).toEqual(
      expect.objectContaining({ status: "added", additions: 2, deletions: 0 })
    );
    expect(deliverables!.totalAdditions).toBe(3);
  });

  test("抽屉按文件取到各自原文,不会把第二个文件渲染成第一个", () => {
    const turn = applyPatchTurn();
    expect(getTurnFileDiff(turn, "replica/src/created.ts")).toContain("+export const created");

    diffReviewStore.open({ sessionId: "s1", turn, targetFilePath: "replica/src/created.ts" });
    expect(diffReviewStore.state().activeFilePath).toBe("replica/src/created.ts");
    const parsed = diffReviewStore.getActiveFileParsed();
    expect(parsed?.path).toBe("replica/src/created.ts");
    expect(parsed?.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).toContain(
      "export const why = \"apply_patch\";"
    );
    diffReviewStore.close();
  });
});
