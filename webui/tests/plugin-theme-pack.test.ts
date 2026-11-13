// @vitest-environment happy-dom
/**
 * 插件装载器 theme slot 定向测试（不连 daemon、不起 Electron）。
 * 验证:graph 帧 → 主题目录 → 用户选择 → <link> 热挂/rev-bust/热卸。
 * 这是「主题包插件不生效」排查的逻辑面;真实壳的协议/CSP/级联面见
 * scripts/plugin-theme.e2e.mjs。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const captured = vi.hoisted(() => ({
  graphListener: null as ((payload: unknown) => void) | null,
}));

vi.mock("../src/lib/desktop-host.js", () => ({
  desktopHost: () => ({
    listen: (event: string, cb: (payload: unknown) => void) => {
      if (event === "plugins://graph") captured.graphListener = cb;
      return () => {};
    },
  }),
}));
vi.mock("../src/lib/gamepad.js", () => ({
  startGamepadRawFeed: () => () => {},
}));

import {
  startPluginHost,
  setThemePackSelection,
  themePacks,
  pluginStatus,
  setSyntaxPackSelection,
  syntaxThemes,
  syntaxPackRef,
} from "../src/plugins/loader";

const THEME_ENTRY = {
  id: "qaqh-theme-warmpaper",
  rev: "1000:100:50",
  name: "暖纸",
  entry: "",
  css: "theme.css",
  slot: "theme",
  capabilities: [],
};

function frame(entries: unknown[], release = "test-release"): void {
  captured.graphListener?.({ release, entries });
}

function themeLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>("link[data-qaqh-theme-pack]");
}

describe("插件主题包装载链路", () => {
  beforeEach(() => {
    // 走装载器自身 API 复位(手动删 DOM 会让 appliedPack 状态与 DOM 失配)。
    setThemePackSelection("");
    localStorage.clear();
  });

  it("graph 帧进目录:theme 不 mount JS,未选择时不挂 link", async () => {
    startPluginHost();
    expect(captured.graphListener).not.toBeNull();
    frame([THEME_ENTRY]);
    await vi.waitFor(() => expect(themePacks().length).toBe(1));
    expect(themePacks()[0].id).toBe("qaqh-theme-warmpaper");
    expect(pluginStatus().frames).toBeGreaterThan(0);
    expect(themeLink()).toBeNull(); // 默认「经典」,不自动应用
    expect(document.querySelector("[data-qaqh-plugin]")).toBeNull();
  });

  it("选择主题包 → 挂 rev-bust link;新 rev → 原位换 href", async () => {
    setThemePackSelection("qaqh-theme-warmpaper");
    const link = themeLink();
    expect(link).not.toBeNull();
    expect(link!.href).toContain("/plugins/qaqh-theme-warmpaper/theme.css?rev=1000:100:50");
    expect(localStorage.getItem("qaqh.theme-pack")).toBe("qaqh-theme-warmpaper");

    frame([{ ...THEME_ENTRY, rev: "2000:200:60" }]);
    await vi.waitFor(() => expect(themeLink()?.href).toContain("rev=2000:200:60"));
    expect(document.querySelectorAll("link[data-qaqh-theme-pack]").length).toBe(1);
  });

  it("主题包从图里消失 → link 热卸;切回经典 → link 热卸", async () => {
    setThemePackSelection("qaqh-theme-warmpaper");
    expect(themeLink()).not.toBeNull();
    frame([]);
    await vi.waitFor(() => expect(themeLink()).toBeNull());
    expect(themePacks().length).toBe(0);

    frame([THEME_ENTRY]);
    await vi.waitFor(() => expect(themePacks().length).toBe(1));
    // 选择仍在 localStorage,目录恢复后应重新挂上
    await vi.waitFor(() => expect(themeLink()).not.toBeNull());
    setThemePackSelection("");
    expect(themeLink()).toBeNull();
  });

  it("overlay 装载失败进自述状态,不拖垮 theme 链路", async () => {
    frame([
      THEME_ENTRY,
      { id: "bad-overlay", rev: "1:1:1", name: "bad", entry: "dist/entry.js", slot: "overlay", capabilities: [] },
    ]);
    await vi.waitFor(() => expect(pluginStatus().failed["bad-overlay"]).toBeTruthy());
    expect(themePacks().length).toBe(1);
  });
});

const SYNTAX_ENTRY = {
  id: "qaqh-syntax-warmpaper",
  rev: "3000:300:70",
  name: "暖纸 · 语法",
  entry: "",
  light: "light.json",
  dark: "dark.json",
  slot: "syntax-theme",
  capabilities: [],
};

describe("语法主题包装载链路", () => {
  beforeEach(() => {
    setSyntaxPackSelection("");
    setThemePackSelection("");
    localStorage.clear();
  });

  it("syntax 条目进目录且不 mount JS;未选择时 ref=null(内置对)", async () => {
    frame([SYNTAX_ENTRY]);
    await vi.waitFor(() => expect(syntaxThemes().length).toBe(1));
    expect(document.querySelector('[data-qaqh-plugin="qaqh-syntax-warmpaper"]')).toBeNull();
    expect(syntaxPackRef()).toBeNull();
  });

  it("选择 → rev-bust 双 URL;新 rev → ref 推进;包出局 → 回退 null", async () => {
    frame([SYNTAX_ENTRY]);
    await vi.waitFor(() => expect(syntaxThemes().length).toBe(1));
    setSyntaxPackSelection("qaqh-syntax-warmpaper");
    expect(localStorage.getItem("qaqh.syntax-pack")).toBe("qaqh-syntax-warmpaper");
    const ref = syntaxPackRef();
    expect(ref?.light).toBe("app://localhost/plugins/qaqh-syntax-warmpaper/light.json?rev=3000:300:70");
    expect(ref?.dark).toContain("dark.json?rev=3000:300:70");

    frame([{ ...SYNTAX_ENTRY, rev: "4000:400:80" }]);
    await vi.waitFor(() => expect(syntaxPackRef()?.rev).toBe("4000:400:80"));

    frame([]);
    await vi.waitFor(() => expect(syntaxPackRef()).toBeNull());
    expect(syntaxThemes().length).toBe(0);
  });
});
