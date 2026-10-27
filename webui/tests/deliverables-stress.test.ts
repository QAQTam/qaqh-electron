import { describe, expect, test } from "vitest";
import { extractTurnDeliverables, getTurnFileDiff, type TurnDeliverables } from "../src/diff/deliverables";
import { BoundedLruCache, diffReviewStore, MAX_DIFF_CACHE_CAPACITY } from "../src/diff/review-store";
import type { ToolStep, Turn } from "../src/session/types";

function generateMockTurn(turnIdx: number, filesCount = 3): Turn {
  const steps: ToolStep[] = [];
  for (let f = 0; f < filesCount; f++) {
    const filename = `src/module_${(turnIdx % 10) + 1}/file_${f}.ts`;
    const diffText = `diff --git a/${filename} b/${filename}
--- a/${filename}
+++ b/${filename}
@@ -1,5 +1,7 @@
 export const v_${turnIdx}_${f} = 1;
-export const stale = true;
+export const updated = true;
+export const extra = "turn_${turnIdx}_f_${f}";
 export const tail = 100;
`;
    steps.push({
      kind: "tool",
      id: `step_${turnIdx}_${f}`,
      seq: turnIdx * 10 + f,
      name: "edit",
      status: "success",
      output: { diffText },
    });
  }

  return {
    id: `turn_${turnIdx}`,
    key: `turn_${turnIdx}`,
    turnIndex: turnIdx,
    user: { text: `Turn ${turnIdx} request` },
    steps,
    answer: { text: `Answer for turn ${turnIdx}` },
    answerStepId: `ans_${turnIdx}`,
    status: "done",
    expanded: true,
  };
}

describe("长时多回合工作内存与性能压力测试", () => {
  test("连续 120 个回合（360 次文件修改）下元数据指纹体积严格受限 (< 150KB)", () => {
    const totalTurns = 120;
    const deliverablesList: TurnDeliverables[] = [];

    const start = performance.now();
    for (let i = 0; i < totalTurns; i++) {
      const turn = generateMockTurn(i, 3);
      const del = extractTurnDeliverables(turn);
      expect(del).not.toBeNull();
      deliverablesList.push(del!);
    }
    const elapsed = performance.now() - start;

    // 120 个回合的提取纯耗时必须极快，确保零 UI 线程顿挫（受限双核老硬件放宽至 300ms）
    const maxElapsed = typeof navigator !== "undefined" && navigator.hardwareConcurrency <= 2 ? 300 : 150;
    expect(elapsed).toBeLessThan(maxElapsed);

    // 验证指纹数量
    expect(deliverablesList).toHaveLength(totalTurns);

    // 计算这 120 个回合的所有交付物指纹序列化总字节数
    const totalJson = JSON.stringify(deliverablesList);
    const totalBytes = new TextEncoder().encode(totalJson).length;

    // 120 个回合总计 360 个文件的元数据，必须限制在 150KB 以内（平均每个文件 < 400B）
    expect(totalBytes).toBeLessThan(150 * 1024);
  });

  test("频繁在抽屉中连续审查 60 个文件时，LRU 缓存被死死锁在 3 个，无内存泄漏", () => {
    const evictedKeys: string[] = [];
    const cache = new BoundedLruCache<string, string>(MAX_DIFF_CACHE_CAPACITY, (key) => {
      evictedKeys.push(key);
    });

    // 模拟连续查看 60 个不同文件的 Diff
    for (let i = 0; i < 60; i++) {
      cache.set(`file_${i}.ts`, `diff_content_for_${i}`);
      // 任何时刻缓存项决不能超过容量上限 3
      expect(cache.size).toBeLessThanOrEqual(MAX_DIFF_CACHE_CAPACITY);
    }

    // 淘汰次数应为 60 - 3 = 57 次
    expect(evictedKeys).toHaveLength(57);
    expect(cache.size).toBe(3);

    // 清空缓存
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("diffReviewStore 在多回合切换和关闭时彻底释放引用", () => {
    const turnA = generateMockTurn(1, 4);
    const turnB = generateMockTurn(2, 4);

    // 1. 打开 Turn A 审查
    diffReviewStore.open({ sessionId: "sess-1", turn: turnA });
    expect(diffReviewStore.state().isOpen).toBe(true);

    // 查看 A 中的 2 个文件
    diffReviewStore.selectFile(turnA.steps[0]!.output!.diffText!.split("\n")[0]!.split(" ")[2]!.slice(2));
    diffReviewStore.getActiveFileParsed();
    diffReviewStore.selectFile(turnA.steps[1]!.output!.diffText!.split("\n")[0]!.split(" ")[2]!.slice(2));
    diffReviewStore.getActiveFileParsed();
    expect(diffReviewStore.lruCache.size).toBe(2);

    // 2. 直接切换打开 Turn B
    diffReviewStore.open({ sessionId: "sess-1", turn: turnB });
    // 换 Turn 时旧缓存必须立即清空
    expect(diffReviewStore.lruCache.size).toBe(0);
    expect(diffReviewStore.state().turnKey).toBe("turn_2");

    // 查看 B 中的 1 个文件
    diffReviewStore.getActiveFileParsed();
    expect(diffReviewStore.lruCache.size).toBe(1);

    // 3. 关闭抽屉
    diffReviewStore.close();
    expect(diffReviewStore.state().isOpen).toBe(false);
    expect(diffReviewStore.state().turn).toBeNull();
    expect(diffReviewStore.state().deliverables).toBeNull();
    expect(diffReviewStore.state().activeFilePath).toBeNull();
    expect(diffReviewStore.lruCache.size).toBe(0);
  });
});
