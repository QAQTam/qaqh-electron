/**
 * 侧栏工作区分组的可见性与「在此工作区新建会话」。
 *
 * 盯住四条不变量:
 * 1. **零会话的工作区也必须出现**——否则「给这个工作区起第一条对话」在侧栏根本没有
 *    落点(这是本轮改动修掉的那条过滤);
 * 2. 目录已不存在**但有历史会话**的组仍然列出(历史得看得见),只是不给「+」;
 * 3. 目录已不存在**且零会话**的组不列出(没有可看的内容,也没有可做的动作);
 * 4. 「+」是折叠钮的**兄弟节点**,不嵌在 `<button>` 里:交互内容嵌套是非法 HTML,
 *    浏览器会把内层钮顶到外层钮外面,点击落点与无障碍树跟着乱。
 */
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, flush } from "solid-js";
import { render } from "@solidjs/web";
import { MessageSidebar } from "../src/app/MessageSidebar";
import type { SidebarSession, SidebarWorkspace } from "../src/tabs/store";

// happy-dom 不带 ResizeObserver;选中指示器 pill 会观察列表容器,环境缺失不该变成断言失败。
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const WORKSPACES: SidebarWorkspace[] = [
  { id: "ws-live", title: "qaqh-backend", path: "D:/Projects/qaqh-backend", order: 1, missing_dir: false },
  { id: "ws-empty", title: "qaqh-telegram", path: "D:/Projects/qaqh-telegram", order: 2, missing_dir: false },
  { id: "ws-gone", title: "gone-but-has-history", path: "D:/Projects/gone", order: 3, missing_dir: true },
  { id: "ws-gone-empty", title: "gone-and-empty", path: "D:/Projects/gone-empty", order: 4, missing_dir: true },
];

const SESSIONS: SidebarSession[] = [
  { session_id: "ses-1", title: "跑过一轮的会话", workspace_id: "ws-live", updated_at: 10, archived: false },
  { session_id: "ses-2", title: "目录没了但历史还在", workspace_id: "ws-gone", updated_at: 20, archived: false },
];

const mounted: Array<() => void> = [];

function mount(props: Partial<Parameters<typeof MessageSidebar>[0]> = {}): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(MessageSidebar, {
    onSelect: vi.fn(),
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    ...props,
  }), root);
  mounted.push(dispose);
  return root;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  document.body.replaceChildren();
  localStorage.removeItem("qaqh.sidebar.collapsed");
});

const titlesOf = (root: HTMLElement): string[] =>
  [...root.querySelectorAll(".message-workspace-title")].map((node) => node.textContent ?? "");

test("零会话的工作区仍然列出,死掉的空工作区不再占位", async () => {
  const root = mount({ onCreateIn: vi.fn() });
  await flush();
  const titles = titlesOf(root);
  expect(titles).toContain("qaqh-backend");
  expect(titles).toContain("qaqh-telegram"); // 一条会话都没有,以前整组被过滤掉
  expect(titles).toContain("gone-but-has-history"); // 目录没了但历史得看得见
  expect(titles).not.toContain("gone-and-empty"); // 没内容 + 没动作 = 一行死字
});

test("「+」出现在能新建的组头上,目录已不存在的组没有", async () => {
  const root = mount({ onCreateIn: vi.fn() });
  await flush();
  const rows = [...root.querySelectorAll(".message-workspace-row")];
  const withCreate = rows.filter((row) => row.querySelector(".message-workspace-create") != null);
  expect(withCreate.map((row) => row.querySelector(".message-workspace-title")?.textContent))
    .toEqual(["qaqh-backend", "qaqh-telegram"]);
});

test("点「+」把该目录交给新建入口,并且它是折叠钮的兄弟节点", async () => {
  const onCreateIn = vi.fn();
  const root = mount({ onCreateIn });
  await flush();
  const telegram = [...root.querySelectorAll(".message-workspace-row")]
    .find((row) => row.querySelector(".message-workspace-title")?.textContent === "qaqh-telegram")!;
  const create = telegram.querySelector<HTMLButtonElement>(".message-workspace-create")!;

  // 结构断言:动作钮不能落在选择钮内部。
  expect(create.closest(".message-workspace-toggle")).toBeNull();
  expect(create.parentElement?.classList.contains("message-workspace-row")).toBe(true);
  expect(telegram.querySelector(".message-workspace-toggle")).not.toBeNull();

  create.click();
  await flush();
  expect(onCreateIn).toHaveBeenCalledWith("D:/Projects/qaqh-telegram");
});

test("宿主不合格 / 没有新建入口时不渲染动作钮", async () => {
  const withoutHandler = mount();
  await flush();
  expect(withoutHandler.querySelectorAll(".message-workspace-create").length).toBe(0);

  const blocked = mount({ onCreateIn: vi.fn(), canCreate: false });
  await flush();
  const disabled = [...blocked.querySelectorAll<HTMLButtonElement>(".message-workspace-create")];
  expect(disabled.length).toBe(2);
  // 禁用而不是撤掉入口:「这里能建会话,只是现在不行」也要能被读出来。
  expect(disabled.every((button) => button.disabled)).toBe(true);
});
