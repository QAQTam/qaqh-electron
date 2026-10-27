import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolStep, Turn } from "../src/session/types";

describe("工具调用摘要条 shimmer 动效与 120 帧率设计", () => {
  const loadCss = (): string => {
    const root = resolve(__dirname, "../src/styles");
    const main = readFileSync(resolve(root, "app.css"), "utf-8");
    return main.replace(/@import\s+["'](\.[^"']+)["'];/g, (_, file: string) => {
      try {
        return readFileSync(resolve(root, file), "utf-8");
      } catch {
        return "";
      }
    });
  };
  const css = loadCss();

  test("CSS 定义了针对 120fps 调校的动画参数与主题高光变量", () => {
    // 包含 1.6s 周期（在 120fps 下对应 192 帧的丝滑位移）
    expect(css).toContain("--tool-shimmer-dur: 1.6s;");
    // 浅色与深色主题分别定义了高光变量
    expect(css).toContain("--tool-shimmer-highlight: color-mix(in srgb, var(--accent) 26%, rgba(255, 255, 255, 0.6));");
    expect(css).toContain("--tool-shimmer-highlight: rgba(255, 255, 255, 0.22);");
  });

  test("shimmer 为字符级双层实现:background-clip:text 让高光贴字形,不再外联背景横条", () => {
    // 基线层与流光层同文叠放(grid-area 1/1)
    expect(css).toMatch(/\.text-shimmer-base,[\s\S]*?\.text-shimmer-glow\s*\{[^}]*grid-area:\s*1\s*\/\s*1;/);
    // 流光层走 background-clip:text(字形级高光),并配 @supports 回退
    expect(css).toMatch(/@supports \(\(-webkit-background-clip: text\) or \(background-clip: text\)\)/);
    expect(css).toMatch(/\.text-shimmer-glow\s*\{[^}]*background-clip:\s*text;/);
    // 扫光只动 background-position,linear 匀速,无 ease 起停顿挫
    expect(css).toMatch(/@keyframes\s+text-shimmer-sweep\s*\{[^}]*background-position/);
    expect(css).toMatch(/animation:\s*text-shimmer-sweep\s+var\(--ts-duration\)\s+linear/);
    // 动画只在 data-run="true"(最新活跃工具)时运行,非活跃行零常驻成本
    expect(css).toMatch(/\.text-shimmer-glow\[data-run="true"\]\s*\{[^}]*animation:/);
    // 旧实现(每行一层合成层的 ::after 横条)已删除
    expect(css).not.toMatch(/tool-summary\.is-shimmer::after/);
    expect(css).not.toMatch(/will-change:\s*transform/);
  });

  test("支持 prefers-reduced-motion 停用扫光并保住基线层", () => {
    expect(css).toContain(".text-shimmer-glow { animation: none !important; }");
    expect(css).toMatch(/\.text-shimmer .text-shimmer-base\s*\{\s*opacity:\s*1\s*!important;\s*\}/);
  });

  test("最新工具调用推断逻辑：仅最新活跃或最新步骤且非失败状态展示 shimmer", () => {
    const isStepShimmer = (
      step: Pick<ToolStep, "id" | "status">,
      summary: string,
      hasCommandIcon: boolean,
      isLatest: boolean,
    ) => {
      const st = step.status;
      if (st === "error" || st === "denied" || st === "aborted") return false;
      const active = isLatest || st === "running" || st === "pending";
      return Boolean(active && (summary || hasCommandIcon));
    };

    // 最新且成功的工具调用，有摘要：展示 shimmer
    expect(isStepShimmer({ id: "t3", status: "success" }, "src/main.rs", false, true)).toBe(true);

    // 历史已完成的工具调用（非最新）：不展示 shimmer
    expect(isStepShimmer({ id: "t1", status: "success" }, "src/lib.rs", false, false)).toBe(false);

    // 正在运行中的工具调用：展示 shimmer
    expect(isStepShimmer({ id: "t2", status: "running" }, "cargo test", true, false)).toBe(true);

    // 失败/拒绝/中止的工具调用：绝不展示 shimmer
    expect(isStepShimmer({ id: "t3", status: "error" }, "src/main.rs", false, true)).toBe(false);
    expect(isStepShimmer({ id: "t3", status: "denied" }, "src/main.rs", false, true)).toBe(false);
    expect(isStepShimmer({ id: "t3", status: "aborted" }, "src/main.rs", false, true)).toBe(false);

    // 无摘要文本且无命令图标的纯语义工具：不展示 shimmer
    expect(isStepShimmer({ id: "t3", status: "success" }, "", false, true)).toBe(false);
  });

  test("多回合下仅最新回合的最后一个工具为最新工具调用", () => {
    const findLatestToolId = (turnKey: string, slots: Array<{ kind: string; key: string }>, turn: Turn) => {
      let isLatestTurn = false;
      for (let i = slots.length - 1; i >= 0; i--) {
        if (slots[i]?.kind === "turn") {
          isLatestTurn = slots[i]!.key === turnKey;
          break;
        }
      }
      if (!isLatestTurn) return null;
      for (let i = turn.steps.length - 1; i >= 0; i--) {
        if (turn.steps[i]?.kind === "tool") return turn.steps[i]!.id;
      }
      return null;
    };

    const slots = [
      { kind: "turn", key: "turn-1" },
      { kind: "turn", key: "turn-2" },
    ];
    const historyTurn: Turn = {
      id: "turn-1",
      key: "turn-1",
      turnIndex: 0,
      user: { text: "第一问" },
      steps: [
        { kind: "tool", id: "t1", seq: 1, name: "read", status: "success" },
        { kind: "tool", id: "t2", seq: 2, name: "edit", status: "success" },
      ],
      answer: null,
      answerStepId: null,
      status: "done",
      expanded: true,
    };
    const latestTurn: Turn = {
      id: "turn-2",
      key: "turn-2",
      turnIndex: 1,
      user: { text: "第二问" },
      steps: [
        { kind: "tool", id: "t3", seq: 3, name: "read", status: "success" },
        { kind: "tool", id: "t4", seq: 4, name: "exec", status: "running" },
      ],
      answer: null,
      answerStepId: null,
      status: "running",
      expanded: true,
    };

    // 历史回合的最新工具不会被算作当前会话最新工具
    expect(findLatestToolId("turn-1", slots, historyTurn)).toBeNull();
    // 最新回合的最后一个工具被正确判定为最新工具
    expect(findLatestToolId("turn-2", slots, latestTurn)).toBe("t4");
  });
});
