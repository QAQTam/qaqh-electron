/**
 * 启动页发送侧的两块地基(阶段B):
 * 1. `startupAttachments` 升到 `PendingAttachment[]` —— 启动页与聊天页共用一份
 *    chip 状态机,暂存态的键就是本机路径(`ready` = 已暂存待传,不是已上传);
 * 2. `createSessionWithCwd` 把预检组装的 `tool_mode`/`custom_tools` 原样带上
 *    `session.create`(后端 `session.rs:159-185` 收这些入参;省略 = 回落默认)。
 */
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { flush } from "solid-js";
import { transport } from "../src/lib/transport";
import {
  clearStartupAttachments,
  createSessionWithCwd,
  removeStartupAttachment,
  stageStartupAttachments,
  startupAttachments,
} from "../src/tabs/store";

afterEach(() => {
  clearStartupAttachments();
  vi.restoreAllMocks();
});

test("暂存附件是 chip 形状:路径为键、末段为名、恒 ready 且没有 reference", async () => {
  stageStartupAttachments(["D:/tmp/shot.png", "D:/tmp/shot.png", "D:/notes/deep/a.md"]);
  await flush();
  const list = startupAttachments();
  expect(list.map((item) => item.id)).toEqual(["D:/tmp/shot.png", "D:/notes/deep/a.md"]);
  expect(list.map((item) => item.name)).toEqual(["shot.png", "a.md"]);
  expect(list.every((item) => item.state === "ready" && item.reference === null)).toBe(true);

  // 再挂同一个路径仍然只有两个 chip(键是路径)。
  stageStartupAttachments(["D:/tmp/shot.png"]);
  await flush();
  expect(startupAttachments().length).toBe(2);

  removeStartupAttachment("D:/notes/deep/a.md");
  await flush();
  expect(startupAttachments().map((item) => item.id)).toEqual(["D:/tmp/shot.png"]);
});

test("createSessionWithCwd 把 tool_mode/custom_tools 带上 session.create;省略即 null(后端回落)", async () => {
  const commands: Array<Record<string, unknown>> = [];
  vi.spyOn(transport, "command").mockImplementation(async (command) => {
    commands.push(structuredClone(command) as unknown as Record<string, unknown>);
    return { command_id: "c", status: "accepted", result: { session_id: "ses-new" } } as never;
  });
  vi.spyOn(transport, "sessions").mockImplementation(async () => [] as never);
  vi.spyOn(transport, "query").mockImplementation(async () => [] as never);

  await createSessionWithCwd({
    cwd: "D:/Projects/demo",
    modelSelection: null,
    toolMode: "custom",
    customTools: ["exec", "read"],
  });
  expect(commands[0]).toEqual({
    type: "session.create",
    cwd: "D:/Projects/demo",
    model_selection: null,
    title: null,
    tool_mode: "custom",
    custom_tools: ["exec", "read"],
  });

  // 老调用形状(裸字符串 cwd)不受影响:新字段落成 null,后端按未指定处理。
  await createSessionWithCwd("D:/Projects/legacy");
  expect(commands[1]).toEqual({
    type: "session.create",
    cwd: "D:/Projects/legacy",
    model_selection: null,
    title: null,
    tool_mode: null,
    custom_tools: null,
  });
});
