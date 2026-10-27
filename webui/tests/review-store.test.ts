import { describe, expect, test, vi } from "vitest";
import { BoundedLruCache, diffReviewStore, MAX_DIFF_CACHE_CAPACITY } from "../src/diff/review-store";
import type { Turn } from "../src/session/types";

describe("BoundedLruCache", () => {
  test("严格遵守容量上限并淘汰最久未使用的节点", () => {
    const onEvict = vi.fn();
    const cache = new BoundedLruCache<string, number>(3, onEvict);

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(3);

    // 插入第 4 个，淘汰最旧的 "a"
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
    expect(onEvict).toHaveBeenCalledWith("a", 1);

    // 访问 "b"，使其变为最新
    expect(cache.get("b")).toBe(2);

    // 插入 "e"，此时最旧的应是 "c"
    cache.set("e", 5);
    expect(cache.has("c")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(onEvict).toHaveBeenCalledWith("c", 3);
  });

  test("clear 立即将缓存清零并断开引用", () => {
    const cache = new BoundedLruCache<string, string>(3);
    cache.set("x", "foo");
    cache.set("y", "bar");
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("x")).toBeUndefined();
    expect(cache.keys()).toEqual([]);
  });
});

describe("diffReviewStore", () => {
  const sampleDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;

  const sampleDiffB = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
 const m = 1;
+const n = 2;
`;

  const mockTurn: Turn = {
    id: "turn-1",
    key: "turn-1",
    turnIndex: 0,
    user: { text: "make changes" },
    steps: [
      {
        kind: "tool",
        id: "step-1",
        seq: 1,
        name: "edit",
        status: "success",
        output: { diffText: sampleDiff },
      },
      {
        kind: "tool",
        id: "step-2",
        seq: 2,
        name: "edit",
        status: "success",
        output: { diffText: sampleDiffB },
      },
    ],
    answer: null,
    answerStepId: null,
    status: "done",
    expanded: true,
  };

  test("打开抽屉、文件切换与循环导航", () => {
    diffReviewStore.open({
      sessionId: "session-1",
      turn: mockTurn,
    });

    const state = diffReviewStore.state();
    expect(state.isOpen).toBe(true);
    expect(state.sessionId).toBe("session-1");
    expect(state.deliverables?.totalFiles).toBe(2);
    expect(state.activeFilePath).toBe("src/a.ts");

    // 切换到 src/b.ts
    diffReviewStore.selectFile("src/b.ts");
    expect(diffReviewStore.state().activeFilePath).toBe("src/b.ts");

    // 向后导航，循环回 src/a.ts
    diffReviewStore.navigateFile(1);
    expect(diffReviewStore.state().activeFilePath).toBe("src/a.ts");

    // 向前导航，循环到 src/b.ts
    diffReviewStore.navigateFile(-1);
    expect(diffReviewStore.state().activeFilePath).toBe("src/b.ts");
  });

  test("cwd 驻留:绝对路径 diff 经归一后按需解析可命中(骨架屏卡死回归锁)", () => {
    const absDiff = `diff --git a/E:\\proj\\src\\abs.ts b/E:\\proj\\src\\abs.ts
--- a/E:\\proj\\src\\abs.ts
+++ b/E:\\proj\\src\\abs.ts
@@ -1,2 +1,3 @@
 const k = 1;
+const v = 2;
`;
    const absTurn: Turn = {
      id: "turn-abs",
      key: "turn-abs",
      turnIndex: 0,
      user: { text: "abs path changes" },
      steps: [
        {
          kind: "tool",
          id: "step-abs",
          seq: 1,
          name: "edit",
          status: "success",
          output: { diffText: absDiff },
        },
      ],
      answer: null,
      answerStepId: null,
      status: "done",
      expanded: true,
    };

    diffReviewStore.open({
      sessionId: "session-1",
      turn: absTurn,
      cwd: "E:\\proj",
    });
    // 指纹聚合已用 cwd 把绝对路径归一成相对路径
    expect(diffReviewStore.state().activeFilePath).toBe("src/abs.ts");
    expect(diffReviewStore.state().cwd).toBe("E:\\proj");
    // 按需解析用同一个 cwd 匹配回 diff 原文的绝对路径 → 非空(修复前恒 null)
    expect(diffReviewStore.getActiveFileParsed()).not.toBeNull();

    diffReviewStore.close();
    expect(diffReviewStore.state().cwd).toBeNull();
  });

  test("按需解析并缓存至 LRU，关闭抽屉时彻底清空", () => {
    diffReviewStore.open({
      sessionId: "session-1",
      turn: mockTurn,
    });

    // 首次获取解析结果
    const parsedA = diffReviewStore.getActiveFileParsed();
    expect(parsedA).not.toBeNull();
    expect(parsedA!.path).toBe("src/a.ts");
    expect(diffReviewStore.lruCache.size).toBe(1);

    // 第二次获取命中缓存
    const parsedA2 = diffReviewStore.getActiveFileParsed();
    expect(parsedA2).toBe(parsedA);

    // 切换并解析 B
    diffReviewStore.selectFile("src/b.ts");
    const parsedB = diffReviewStore.getActiveFileParsed();
    expect(parsedB).not.toBeNull();
    expect(parsedB!.path).toBe("src/b.ts");
    expect(diffReviewStore.lruCache.size).toBe(2);

    // 关闭抽屉：触发物理清空
    diffReviewStore.close();

    const closedState = diffReviewStore.state();
    expect(closedState.isOpen).toBe(false);
    expect(closedState.deliverables).toBeNull();
    expect(closedState.turn).toBeNull();
    expect(closedState.activeFilePath).toBeNull();
    expect(diffReviewStore.lruCache.size).toBe(0);
  });
});
