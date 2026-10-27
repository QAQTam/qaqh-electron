import { describe, expect, test, vi } from "vitest";
import { SessionStore } from "../src/session/store";
import type { Tab } from "../src/tabs/store";

describe("SessionHeader 基础模型与重命名数据流", () => {
  test("store title 响应式更新与 onSessionTitleChanged 联动触发", () => {
    const store = new SessionStore("seed_1");
    const onTitleChanged = vi.fn();
    store.onSessionTitleChanged = onTitleChanged;

    // 默认初始标题为 null
    expect(store.title[0]()).toBeNull();

    // 模拟重命名或后端推送 title_changed
    store.title[1]("新会话标题");
    store.onSessionTitleChanged("新会话标题");

    expect(store.title[0]()).toBe("新会话标题");
    expect(onTitleChanged).toHaveBeenCalledWith("新会话标题");
  });

  test("Tab 包装结构包含完整的 store 与 seed 关联", () => {
    const store = new SessionStore("seed_demo");
    const tab: Tab = {
      id: "tab_1",
      seed: "seed_demo",
      store,
    };

    expect(tab.seed).toBe("seed_demo");
    expect(tab.store).toBe(store);
  });
});
