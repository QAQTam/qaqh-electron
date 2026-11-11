/**
 * `Composer` 的 `sending` 态(阶段B 启动页 busy)。
 *
 * 立着的规矩:`sending` 只把发送钮转 loader 并挡住重复提交,**不**走
 * `running()→「停止」`那条路径——会话还没建出来,没有回合可停;反过来
 * 启动页若在 busy 时不挡 Enter,就会连发多次 `session.create`(每次白拉一个
 * worker,还各落一行会话)。
 */
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

// 与其余 UI 用例同一套:必须显式指向客户端 dev 构建,否则 @solidjs/web 解析到
// server 构建,导入期就撞 client-only API(交接文档 §5.1)。
vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { Composer } from "../src/composer/Composer";

const mounted: Array<() => void> = [];

function mountComposer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const onSend = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => Composer({
    draft,
    onDraft: setDraft,
    blocked: () => null,
    running: () => false,
    sending,
    onSend,
    onStop: vi.fn(),
    focusToken: 0,
    ...props,
  }), root);
  mounted.push(dispose);
  const textarea = () => root.querySelector("textarea") as HTMLTextAreaElement;
  const sendButton = () => root.querySelector("button.send") as HTMLButtonElement;
  const type = async (value: string): Promise<void> => {
    const node = textarea();
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  const pressEnter = async (): Promise<void> => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
  };
  return { root, sending, setSending, onSend, sendButton, type, pressEnter, draft, setDraft };
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  document.body.replaceChildren();
});

test("sending 期间:发送钮禁用转 loader,Enter 不触发 onSend", async () => {
  const c = mountComposer();
  await c.type("先别催");
  c.setSending(true);
  await flush();
  expect(c.sendButton().disabled).toBe(true);
  expect(c.sendButton().getAttribute("aria-label")).toBe("正在发送");
  expect(c.sendButton().querySelector(".icon-spin")).not.toBeNull();
  await c.pressEnter();
  expect(c.onSend).not.toHaveBeenCalled();
});

test("sending 解除后同一份草稿照发;按钮形状回到箭头", async () => {
  const c = mountComposer();
  await c.type("照发");
  c.setSending(true);
  await flush();
  c.setSending(false);
  await flush();
  expect(c.sendButton().disabled).toBe(false);
  expect(c.sendButton().querySelector(".icon-spin")).toBeNull();
  await c.pressEnter();
  expect(c.onSend).toHaveBeenCalledTimes(1);
  expect(c.onSend).toHaveBeenCalledWith("照发");
});

test("sending 不改变 running=false 的按钮语义:永远不出现「停止」", async () => {
  const c = mountComposer();
  c.setSending(true);
  await flush();
  expect(c.root.querySelector("button.stop")).toBeNull();
  expect(c.root.querySelector("button.send")).not.toBeNull();
});
