import { expect, test } from "vitest";
import { absoluteToolPath, isSkillStep, semanticLabel, shellContent, toolPaths, toolPhaseLabel } from "../src/tools/presentation";

test("v3 tool states have distinct phase labels", () => {
  expect(toolPhaseLabel({ status: "declared" })).toBe("准备工具调用");
  expect(toolPhaseLabel({ status: "awaiting_permission" })).toBe("等待授权");
  expect(toolPhaseLabel({ status: "running" })).toBe("执行中");
  expect(toolPhaseLabel({ status: "finished" })).toBeUndefined();
});

test("绝对路径仅使用明确 cwd；支持 Windows/UNC/Unix/父路径与多文件 diff", () => {
  expect(absoluteToolPath("src/../config.rs", "E:\\repo")).toBe("E:/repo/config.rs");
  expect(absoluteToolPath("C:\\repo\\file.rs", "E:/repo")).toBe("C:/repo/file.rs");
  expect(absoluteToolPath("../file.rs", "//server/share/project")).toBe("//server/share/file.rs");
  expect(absoluteToolPath("../file.rs", "/repo/src")).toBe("/repo/file.rs");
  expect(absoluteToolPath("/root.rs", "E:/repo")).toBe("E:/root.rs");
  expect(absoluteToolPath("src/file.rs")).toBe("src/file.rs");
  const diffText = "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-old\n+new\n--- a/src/b.rs\n+++ b/src/b.rs\n@@ -1 +1 @@\n-old\n+new";
  expect(toolPaths({ argsJson: '{"path":"src/a.rs"}', output: { diffText } }, "E:/repo")).toEqual(["E:/repo/src/a.rs", "E:/repo/src/b.rs"]);
});

test("待办与 skills 只给语义，不能将运行/失败说成已完成", () => {
  expect(semanticLabel({ name: "todo_write", status: "finished" })).toBe("已更新待办");
  expect(semanticLabel({ name: "todo_create", status: "finished" })).toBe("已创建待办");
  expect(semanticLabel({ name: "todo_update", status: "failed" })).toBe("更新待办");
  expect(semanticLabel({ name: "skill_activate", status: "finished" })).toBe("已调用 skills");
  expect(semanticLabel({ name: "skill_resource", status: "running" })).toBe("读取 skills");
  expect(semanticLabel({ name: "skill_list", status: "finished" })).toBe("已读取 skills");
  expect(semanticLabel({ name: "read", argsJson: '{"path":"C:/skills/example/SKILL.md"}', status: "finished" })).toBe("已读取 skills");
  expect(isSkillStep({ name: "read", argsJson: '{"path":"C:/repo/skill.ts"}' })).toBe(false);
});

test("exec 运行只展示 progress；终态替换而不叠加；无终态输出保留尾窗", () => {
  const input = { progressTail: "live order", progressTruncated: true, output: { text: "stdout", stderr: "stderr", truncated: false } };
  expect(shellContent({ ...input, status: "running" })).toEqual({ text: "live order", stderr: "", truncated: true });
  expect(shellContent({ ...input, status: "finished" })).toEqual({ text: "stdout", stderr: "stderr", truncated: false });
  expect(shellContent({ ...input, status: "failed", output: undefined }).text).toBe("live order");
  expect(shellContent({ ...input, status: "finished", output: { text: "", stderr: "", exitCode: 0 } }).text).toBe("");
});

test("exec 运行中 stderr 独立尾窗直接展示,不与 stdout 尾窗混排", () => {
  const input = { progressTail: "building…", progressStderrTail: "warning: deprecated", progressTruncated: false };
  expect(shellContent({ ...input, status: "running" })).toEqual({ text: "building…", stderr: "warning: deprecated", truncated: false });
  expect(shellContent({ ...input, status: "finished", output: { text: "done", truncated: false } })).toEqual({ text: "done", stderr: "", truncated: false });
});
