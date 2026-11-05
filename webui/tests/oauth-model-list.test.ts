// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { ModelList } from "../src/oauth/ModelList";

afterEach(() => document.body.replaceChildren());

test("remote models are selectable without typing; refreshing does not pick one and keeps a cached list visible", async () => {
  const pick = vi.fn();
  const reload = vi.fn();
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(ModelList, {
    active: true, providerName: "DeepSeek", model: "old-model", signedIn: true,
    models: [{ slug: "deepseek-flash", displayName: "DeepSeek Flash" }],
    get busy() { return refreshing(); }, get refreshing() { return refreshing(); }, get error() { return error(); },
    onPick: pick, onReload: reload,
  }), root);
  try {
    await flush();
    expect(root.textContent).toContain("全局默认模型：old-model");
    expect(root.textContent).toContain("不在最新目录");
    expect(pick).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>(".oauth-models__list button")!.click();
    expect(pick).toHaveBeenCalledWith("deepseek-flash");
    root.querySelector<HTMLButtonElement>(".oauth-models__head button")!.click();
    expect(reload).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
    setRefreshing(true);
    await flush();
    expect(root.querySelector<HTMLButtonElement>(".oauth-models__list button")!.disabled).toBe(true);
    expect(root.textContent).toContain("DeepSeek Flash");
    setRefreshing(false); setError("网络错误");
    await flush();
    expect(root.querySelector("[role=alert]")!.textContent).toBe("网络错误");
    expect(root.querySelector<HTMLButtonElement>(".oauth-models__list button")!.disabled).toBe(false);
    expect(root.querySelector("details")!.open).toBe(false);
  } finally { dispose(); }
});

test("signed out, unfetched, and successful empty catalogs have different messages", async () => {
  const [signedIn, setSignedIn] = createSignal(false);
  const [models, setModels] = createSignal<[] | null>(null);
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(ModelList, {
    active: false, providerName: "DeepSeek", model: null, busy: false, refreshing: false, error: null,
    get signedIn() { return signedIn(); }, get models() { return models(); }, onPick: vi.fn(), onReload: vi.fn(),
  }), root);
  try {
    await flush();
    expect(root.textContent).toContain("登录后自动获取");
    expect(root.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    setSignedIn(true); await flush();
    expect(root.textContent).toContain("尚未获取模型目录");
    setModels([]); await flush();
    expect(root.textContent).toContain("此账号返回的模型目录为空");
  } finally { dispose(); }
});
