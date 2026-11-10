/**
 * 工作区菜单行尾的「+」。
 *
 * 一张菜单里有两个不同的意图,必须有两个不同的落点:
 * - 点条目本身 = **只**改新会话的目标目录,菜单关掉,人留在原地;
 * - 点行尾「+」 = 改目标目录**并**去启动页开一条新对话,且不得顺带触发前者。
 * 另外「+」是选择钮的兄弟节点(`.workspace-row-pick`),不是嵌在 `<button>` 里。
 */
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, flush } from "solid-js";
import { render } from "@solidjs/web";
import { WorkspaceMenu } from "../src/workspace/WorkspaceMenu";
import type { SidebarWorkspace } from "../src/tabs/store";

const WORKSPACES: SidebarWorkspace[] = [
  { id: "ws-a", title: "qaqh-backend", path: "D:/Projects/qaqh-backend", order: 1, missing_dir: false },
  { id: "ws-b", title: "qaqh-telegram", path: "D:/Projects/qaqh-telegram", order: 2, missing_dir: false },
  { id: "ws-c", title: "gone", path: "D:/Projects/gone", order: 3, missing_dir: true },
];

const mounted: Array<() => void> = [];

function mount(props: Partial<Parameters<typeof WorkspaceMenu>[0]> = {}): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(WorkspaceMenu, {
    selectedPath: null,
    workspaces: WORKSPACES,
    onPick: vi.fn(),
    onBrowse: vi.fn(),
    ...props,
  }), root);
  mounted.push(dispose);
  return root;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  document.body.replaceChildren();
});

test("每一行一个「+」;目录已不存在的行不给", async () => {
  const onCreateIn = vi.fn();
  const root = mount({ onCreateIn });
  await flush();
  expect(root.querySelectorAll(".workspace-row-shell").length).toBe(3);
  const creatable = [...root.querySelectorAll<HTMLElement>(".workspace-row-shell")]
    .filter((shell) => shell.querySelector(".workspace-row-create") != null)
    .map((shell) => shell.querySelector(".workspace-row-name")?.textContent);
  expect(creatable).toEqual(["qaqh-backend", "qaqh-telegram"]);
});

test("点「+」只走新建入口,不触发选择;两个落点互不串", async () => {
  const onPick = vi.fn();
  const onCreateIn = vi.fn();
  const root = mount({ onPick, onCreateIn, selectedPath: WORKSPACES[0]!.path });
  await flush();
  const create = root.querySelectorAll<HTMLButtonElement>(".workspace-row-create")[1]!;
  create.click();
  await flush();
  expect(onCreateIn).toHaveBeenCalledWith("D:/Projects/qaqh-telegram");
  expect(onPick).not.toHaveBeenCalled();
});

test("「+」不嵌在选择钮里;不传 onCreateIn 就一个都不渲染", async () => {
  const root = mount({ onCreateIn: vi.fn() });
  await flush();
  for (const create of [...root.querySelectorAll<HTMLElement>(".workspace-row-create")]) {
    expect(create.closest("[role=\"menuitemradio\"]")).toBeNull();
    expect(create.parentElement?.classList.contains("workspace-row-shell")).toBe(true);
  }
  // 选中态仍然由行内对勾表达,和「+」共用同一格(悬停时由 CSS 让它们互换显隐)。
  expect(root.querySelectorAll(".workspace-row-check").length).toBe(1);

  const plain = mount();
  await flush();
  expect(plain.querySelectorAll(".workspace-row-create").length).toBe(0);
  expect(plain.querySelectorAll(".workspace-row-shell").length).toBe(3);
});
