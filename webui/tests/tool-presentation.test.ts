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
  expect(toolPaths({ name: "edit", argsJson: '{"path":"src/a.rs"}', output: { diffText } }, "E:/repo")).toEqual(["E:/repo/src/a.rs", "E:/repo/src/b.rs"]);
});

test("路径在参数吐完之前就亮出来:未闭合 JSON 前缀与内核下发的补丁文件", () => {
  // edit 的 file_path 值一闭合就该有路径,不等 tool_declared。
  const partial = '{"file_path":"crates/qaqh-workspace/src/todo/store.rs","old_string":"let x = 1;';
  expect(toolPaths({ name: "edit", argsJson: partial, targetFiles: undefined })).toEqual(["crates/qaqh-workspace/src/todo/store.rs"]);
  // read 批量形态的 path 逐个都算(前缀里已闭合的)。
  expect(toolPaths({ name: "read", argsJson: '{"requests":[{"path":"a.rs"},{"path":"b.rs' })).toEqual(["a.rs"]);
  // apply_patch 的参数里没有路径字段:文件名由内核随参数流发下来。
  expect(toolPaths({ name: "apply_patch", argsJson: '{"patch":"*** Begin Patch\\n*** Update File: src/policy.ts\\n@@\\n-old\\n+new\\n*** End Pa', targetFiles: ["src/policy.ts"] }, "E:/repo")).toEqual(["E:/repo/src/policy.ts"]);
  // 客户端不再自己数补丁头:内核没给,这一行就没有文件名。
  expect(toolPaths({ name: "apply_patch", argsJson: "*** Begin Patch\n*** Add File: D:\\repo\\new.rs\n+hello\n" })).toEqual([]);
  // header 未收尾时内核也不报(空数组 = 还没认出来),客户端不得拿旧前缀凑。
  expect(toolPaths({ name: "apply_patch", argsJson: '{"patch":"*** Begin Patch\\n*** Update File: src/pol"}', targetFiles: undefined })).toEqual([]);
  expect(toolPaths({ name: "write", argsJson: '{"path":"doc.md","content":"*** Update File: fake.rs' })).toEqual(["doc.md"]);
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
