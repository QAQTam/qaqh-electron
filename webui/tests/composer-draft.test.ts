// @vitest-environment happy-dom
//  Composer 草稿管线回归(2026-11-10 性能修复):
//  非受控输入 + 引用相等快路 + 外部变更桥接 + 空/非空边界驱动禁用。
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { Composer } from "../src/composer/Composer";

afterEach(() => document.body.replaceChildren());

const mount = (initial = "") => {
  const [draft, setDraft] = createSignal(initial);
  const onDraft = vi.fn((value: string) => { setDraft(value); });
  const onSend = vi.fn(async () => { setDraft(""); });
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(Composer, {
    draft, onDraft, blocked: () => null, running: () => false,
    onSend, onStop: async () => {}, focusToken: 0,
  }), root);
  const el = () => root.querySelector<HTMLTextAreaElement>("#composer textarea")!;
  const send = () => root.querySelector<HTMLButtonElement>("#composer .send")!;
  // 监听「程序化 value 写」:happy-dom 的 value 走原型访问器,实例上包一层计数。
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  let programmaticWrites = 0;
  Object.defineProperty(el(), "value", {
    configurable: true,
    get() { return proto.get!.call(this); },
    set(v: string) { programmaticWrites += 1; proto.set!.call(this, v); },
  });
  const typeText = async (text: string) => {
    const node = el();
    proto.set!.call(node, node.value + text); // 模拟原生插入,不计入程序化写
    programmaticWrites = 0;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  return { el, send, typeText, draft, setDraft, onDraft, get writes() { return programmaticWrites; }, dispose };
};

test("挂载时外部草稿桥接进 DOM,空草稿解禁发送键", async () => {
  const t = mount("restored draft");
  await flush();
  expect(t.el().value).toBe("restored draft");
  expect(t.send().disabled).toBe(false);
  t.dispose();
});

test("击键走 onInput→onDraft,同值回写被引用快路吞掉(零 DOM 写)", async () => {
  const t = mount();
  await flush();
  expect(t.send().disabled).toBe(true);
  await t.typeText("你好");
  expect(t.onDraft).toHaveBeenCalledWith("你好");
  expect(t.draft()).toBe("你好");
  expect(t.el().value).toBe("你好");
  expect(t.writes).toBe(0); // 外部没改草稿,effect 不得回写 DOM
  expect(t.send().disabled).toBe(false);
  t.dispose();
});

test("外部清空(发送后)桥接回 DOM 并重新禁用发送键", async () => {
  const t = mount();
  await flush();
  await t.typeText("ship it");
  t.send().click();
  await flush();
  expect(t.el().value).toBe(""); // 桥接写发生了一次
  expect(t.writes).toBe(1);
  expect(t.send().disabled).toBe(true);
  t.dispose();
});

test("全空白草稿不解禁发送键;改回非空再解禁", async () => {
  const t = mount();
  await flush();
  await t.typeText("   ");
  expect(t.send().disabled).toBe(true);
  await t.typeText("x");
  expect(t.send().disabled).toBe(false);
  t.dispose();
});
