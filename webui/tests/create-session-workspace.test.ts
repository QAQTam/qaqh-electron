/**
 * 「在此工作区新建会话」的落点。
 *
 * 侧栏/菜单那两颗「+」只做一件事:把目标目录换成该工作区,然后交回启动页。
 * 真正的 `session.create` 要等首条消息(见 `tabs/store.ts:createSession` 的注释),
 * 所以这里断言的是**目标 + 视图 + 焦点**这三样,而不是"会话被建出来了"。
 *
 * 用 happy-dom 而不是 node:node 环境下 Solid 走服务端渲染分支,写信号会报
 * `SERVER_WRITE`(值仍然可读,但生产的反应式路径没被走一遍)。这里要验的正是
 * 「回到启动页」这条真实路径,别拿一个降级环境当证据。
 */
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

// 与其余 UI 用例同一套:不显式指向客户端 dev 构建时,`@solidjs/web` 会解析到
// server 构建,`tabs/store → ui/toast → ~icons` 这条链在导入期就撞 client-only API。
vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createSession, focusToken, isStartup, newSessionCwd } from "../src/tabs/store";
import { flush } from "solid-js";

afterEach(() => {
  try { localStorage.removeItem("qaqh.workspace.cwd"); } catch { /* 存储不可用时无可清除 */ }
});

test("带路径的 createSession 换粘性目标、回启动页、把焦点交回输入区", async () => {
  const before = focusToken();
  createSession("D:/Projects/qaqh-backend");
  await flush(); // 实测:不 flush 就读不到本轮的写入(第一条用例读到 null,第二条读到的是上一条的值)。断言别拿未提交的读当证据。
  expect(newSessionCwd()).toBe("D:/Projects/qaqh-backend");
  expect(isStartup()).toBe(true);
  expect(focusToken()).toBeGreaterThan(before);
});

test("不带路径的 createSession 只回启动页,不动已经选定的目标", async () => {
  createSession("D:/Projects/qaqh-telegram");
  await flush();
  const afterFirst = focusToken();
  createSession();
  await flush();
  expect(newSessionCwd()).toBe("D:/Projects/qaqh-telegram");
  expect(isStartup()).toBe(true);
  // 焦点令牌仍然递增:回到启动页就该把光标放进输入框,哪怕目录没变。
  expect(focusToken()).toBeGreaterThan(afterFirst);
});
