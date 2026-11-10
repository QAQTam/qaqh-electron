// @vitest-environment happy-dom
//  草稿持久化节流回归(2026-11-10 性能修复):打字期间不再每键全量写 localStorage,
//  尾沿合并只写最新值;空草稿落为 removeItem;窗口隐藏(pagehide)立即冲刷。
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// @solidjs/web 必须是浏览器构建(toast→icons 在模块顶层调 template());
// solid-js 则保持默认解析——dev bundle 对「无 owner 写入」判 inert,会掩盖 store 真实语义。
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { draftOf, setDraftOf } from "../src/tabs/store";

const SEED = "seed-persist-test";
const KEY = `qaqh.draft.${SEED}`;

beforeEach(() => {
  // 只冻结宏任务计时器;solid store 的写入调度依赖微任务,不能一起冻。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

test("连击只挂一个尾沿计时器,到期写最后一次值", () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  setDraftOf(SEED, "a");
  setDraftOf(SEED, "ab");
  setDraftOf(SEED, "abc");
  expect(draftOf(SEED)).toBe("abc"); // store 同步更新
  expect(setItem).not.toHaveBeenCalled(); // 键级不写盘
  vi.advanceTimersByTime(500);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(setItem).toHaveBeenCalledWith(KEY, "abc");
});

test("清空草稿在尾沿到期时落为 removeItem", () => {
  setDraftOf(SEED, "text");
  vi.advanceTimersByTime(500);
  const removeItem = vi.spyOn(Storage.prototype, "removeItem");
  setDraftOf(SEED, "");
  expect(draftOf(SEED)).toBe("");
  vi.advanceTimersByTime(500);
  expect(removeItem).toHaveBeenCalledWith(KEY);
});

test("pagehide 冲刷在飞的草稿写,窗口关闭不丢最后一帧", () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  setDraftOf(SEED, "unsaved tail");
  expect(setItem).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pagehide"));
  expect(setItem).toHaveBeenCalledWith(KEY, "unsaved tail");
});
