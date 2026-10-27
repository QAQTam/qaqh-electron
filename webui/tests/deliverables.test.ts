import { describe, expect, test } from "vitest";
import { extractTurnDeliverables, getTurnFileDiff, splitPath } from "../src/diff/deliverables";
import { diffReviewStore } from "../src/diff/review-store";
import { applyEntry, emptySession } from "../src/session/reducer";
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
          status: "success",
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
          status: "success",
          output: { diffText: sampleDiff1 },
        },
        {
          kind: "tool",
          id: "step2",
          seq: 2,
          name: "edit",
          status: "success",
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
          status: "success",
          output: { diffText: sampleDiff1 },
        },
        {
          kind: "tool",
          id: "step3",
          seq: 3,
          name: "edit",
          status: "success",
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
          status: "success",
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

/**
 * 后端真实线上形状(取自 `~/.qaqh/ringing/ringing-timeline/*.json` 的 write 终态):
 * `body.kind` 恒为 `text`(工具收据文本),权威 unified diff 只挂在顶层
 * `display.diff`,`ToolBody::Diff` 没有任何生产者。此前测试全部手搓
 * `output: { diffText }`,于是抽屉在真数据上永远是骨架屏。
 */
describe("交付物提取接后端真实 wire 槽位", () => {
  const cwd = "E:\\qaqh-backend";
  const wireDiff = `--- E:\\qaqh-backend\\crates\\qaqh-siwc\\Cargo.toml
+++ E:\\qaqh-backend\\crates\\qaqh-siwc\\Cargo.toml
@@ -0,0 +1,3 @@
+[package]
+name = "qaqh-siwc"
+version = "0.1.0"
`;

  function turnFromWriteTool(tool: Record<string, unknown>): Turn {
    const state = emptySession();
    applyEntry(state, {
      timeline_seq: 1,
      turn_id: "t1",
      round_num: 0,
      event: { type: "block_opened", block: { block_id: "w1", kind: "tool", tool: { name: "write", state: "running" } } },
    });
    applyEntry(state, {
      timeline_seq: 2,
      turn_id: "t1",
      round_num: 0,
      event: { type: "tool_updated", block_id: "w1", tool: { name: "write", state: "succeeded", ...tool } },
    });
    return state.turns.t1!;
  }

  const display = {
    summary: "写入 crates/qaqh-siwc/Cargo.toml",
    diff: wireDiff,
    lines_added: 3,
    header: { kind: "path", path: "E:\\qaqh-backend\\crates\\qaqh-siwc\\Cargo.toml", op: "write" },
    body: { kind: "text", text: "[OK] Cargo.toml — 44 bytes, 3 lines (new file)", truncated: false },
  };

  test("display.diff 进 ToolOutput,卡片与抽屉都取得到内容", () => {
    const turn = turnFromWriteTool({ display });
    const step = turn.steps[0]!;
    if (step.kind !== "tool") throw new Error("expect tool");
    expect(step.output?.diffText).toBe(wireDiff);
    expect(step.output?.text).toContain("(new file)");

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

  test("归档 rebuild 后 legacy tool.diff 为 None,display.diff 仍能出图", () => {
    const turn = turnFromWriteTool({ diff: null, display });
    const step = turn.steps[0]!;
    if (step.kind !== "tool") throw new Error("expect tool");
    expect(step.output?.diffText).toBe(wireDiff);
    expect(extractTurnDeliverables(turn, cwd)?.totalFiles).toBe(1);
  });

  test("display.diff 缺席时回退 legacy tool.diff", () => {
    const turn = turnFromWriteTool({ diff: wireDiff, display: { ...display, diff: null } });
    const step = turn.steps[0]!;
    if (step.kind !== "tool") throw new Error("expect tool");
    expect(step.output?.diffText).toBe(wireDiff);
  });
});

/**
 * apply_patch 的线上形状（`qaqh-file-tools/src/apply_patch.rs` 的
 * `ApplyPatchOutput::display`）：header 只报**第一个**文件的 path，
 * `lines_added/removed` 是整张补丁的合计，逐文件原文只在 `display.diff`
 * ——一次补丁可命中多个文件，裸 unified（无 `diff --git` 头）逐段拼接。
 *
 * 修复前该槽恒为 None，抽屉里只剩指纹：文件列表有 `+N −M`，diff 区空态。
 */
describe("apply_patch 多文件 display.diff", () => {
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

  const display = {
    summary: "replica/src/App.tsx +3 −0",
    diff: wireApplyPatchDiff,
    lines_added: 3,
    lines_removed: 0,
    header: { kind: "path", path: "replica/src/App.tsx", op: "patch" },
    body: { kind: "text", text: "[OK] apply_patch — applied: 2 file(s), +3 -0", truncated: false },
  };

  function applyPatchTurn(): Turn {
    const state = emptySession();
    applyEntry(state, {
      timeline_seq: 1,
      turn_id: "t1",
      round_num: 0,
      event: {
        type: "block_opened",
        block: { block_id: "p1", kind: "tool", tool: { name: "apply_patch", state: "running" } },
      },
    });
    applyEntry(state, {
      timeline_seq: 2,
      turn_id: "t1",
      round_num: 0,
      event: {
        type: "tool_updated",
        block_id: "p1",
        tool: { name: "apply_patch", state: "succeeded", display },
      },
    });
    return state.turns.t1!;
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
