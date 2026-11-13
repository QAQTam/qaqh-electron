// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));
const terminal = vi.hoisted(() => ({ writes: [] as string[], resets: 0 }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = {};
  buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0, getLine: () => undefined } };
  loadAddon() {} open() {} onScroll() {} scrollToBottom() {} dispose() {}
  reset() { terminal.resets++; }
  write(text: string, done: () => void) { terminal.writes.push(text); done(); }
} }));

import { createComponent, createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { ReadOnlyTerminal } from "../src/tools/ReadOnlyTerminal";

test("stdout/stderr 合流进同一台 xterm：stderr 带分隔头并以红色包裹增量，游标独立推进", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const [text, setText] = createSignal("out-1\n");
  const [stderr, setStderr] = createSignal("err-a");
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(ReadOnlyTerminal, {
    get text() { return text(); },
    get stderr() { return stderr(); },
    live: false,
  }), root);
  try {
    await flush();
    // 首写：stdout 原文 + stderr 分隔头 + 红色包裹。
    expect(terminal.writes).toHaveLength(3);
    expect(terminal.writes[0]).toBe("out-1\n");
    expect(terminal.writes[1]).toContain("stderr");
    expect(terminal.writes[2]).toBe("\x1b[31merr-a\x1b[39m");
    // stderr 增长：只补写红色增量，不再重复分隔头。
    setStderr("err-aerr-b");
    await flush();
    expect(terminal.writes.slice(-1)).toEqual(["\x1b[31merr-b\x1b[39m"]);
    // stdout 非前缀跳变：整体 reset 后两路按最新内容重建（分隔头随 reset 重新出现）。
    setText("out-2\n");
    await flush();
    expect(terminal.resets).toBeGreaterThan(0);
    expect(terminal.writes.at(-3)).toBe("out-2\n");
    expect(terminal.writes.at(-2)).toContain("stderr");
    expect(terminal.writes.at(-1)).toBe("\x1b[31merr-aerr-b\x1b[39m");
    // stderr 初值为空时不打分隔头，首次出现才打。
    dispose();
    terminal.writes.length = 0;
    const [text2] = createSignal("only-out");
    const [stderr2, setStderr2] = createSignal("");
    const root2 = document.createElement("div");
    document.body.append(root2);
    const dispose2 = render(() => createComponent(ReadOnlyTerminal, {
      get text() { return text2(); },
      get stderr() { return stderr2(); },
      live: false,
    }), root2);
    await flush();
    expect(terminal.writes).toEqual(["only-out"]);
    setStderr2("boom");
    await flush();
    expect(terminal.writes[1]).toContain("stderr");
    expect(terminal.writes[2]).toBe("\x1b[31mboom\x1b[39m");
    dispose2(); root2.remove();
  } finally {
    dispose(); root.remove(); vi.unstubAllGlobals();
  }
});
