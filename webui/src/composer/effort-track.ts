/**
 * 强度轨道的**纯逻辑**：指针位置 ↔ 档位、填充比例、键盘步进、配色档。
 *
 * 单独拆出来是因为这段最容易写错、又最难在界面上发现：拖到最左/最右差一格、
 * 填充宽度算成拇指中心、键盘步进越过端点……在组件里都只能靠肉眼。这里全是
 * 纯函数，脱浏览器可测（`tests/effort-card.test.ts`）。
 *
 * 档位阶梯本身来自 `../models/specs`（`EFFORT_LADDER`），与 Codex 的
 * low → medium → high → xhigh → ultra 一致。
 */
import type { ReasoningTier } from "../models/specs";

/** 指针横坐标 → 档位下标。`rect` 是轨道的可视矩形（含 padding 的部分不算）。 */
export function tierIndexForPointer(
  clientX: number,
  rect: { left: number; width: number },
  tierCount: number,
): number {
  if (tierCount <= 1 || rect.width <= 0) return 0;
  const ratio = (clientX - rect.left) / rect.width;
  const clamped = Math.min(1, Math.max(0, ratio));
  // 四舍五入到最近的档：拖动时"过半才跳"，松手前后手感一致。
  return Math.min(tierCount - 1, Math.max(0, Math.round(clamped * (tierCount - 1))));
}

/** 填充宽度：第 `index` 档占轨道的百分比。拇指中心落在档位上，所以两端要留半格。 */
export function effortFillPercent(index: number, tierCount: number): number {
  if (tierCount <= 1) return 0;
  const clamped = Math.min(tierCount - 1, Math.max(0, index));
  return (clamped / (tierCount - 1)) * 100;
}

/** 键盘步进（←/→）。到端点就停住，不循环——循环会让"最强档"多按一下变最弱。 */
export function stepTier(
  tiers: readonly ReasoningTier[],
  current: ReasoningTier,
  delta: number,
): ReasoningTier {
  const fallback = tiers[0];
  if (fallback == null) return current;
  const at = tiers.indexOf(current);
  if (at < 0) return fallback;
  const next = Math.min(tiers.length - 1, Math.max(0, at + delta));
  return tiers[next] ?? fallback;
}

/**
 * chip 上那个档名的三态。
 *
 * 存在的理由是一个真被画错过的状态：**"还没读到后端值"不等于"后端就是第一档"**。
 * 原来强度卡在首帧直接 `allowed.find(...) ?? allowed[0]`，于是 config 还没 load 回来
 * 时界面把 `low`（"轻度"）当成事实显示。后端那边的真值不是 low：
 * `impl Default for Config` 写的是 `reasoning_effort: "high"`
 * （`qaqh-config/src/config.rs:738`，默认 profile 也是 `effort: Some("high")`），
 * profile 没带 effort 时同样回填 `high`（`:883`、`:1413`）。
 * 用户看到的"默认轻度"就是这么来的，点进去才发现真值：因为打开卡片那次
 * `refreshConfig()` 才把值取回来。
 */
export type EffortDisplay =
  /** 配置还没读到（首帧 / 读失败）：不能报任何档名。 */
  | { kind: "pending" }
  /** 读到了但后端值为空串：等价"没设过"，与"没读到"分开说。 */
  | { kind: "unset" }
  | { kind: "tier"; tier: ReasoningTier }
  /** 读到了，可这个值不在当前模型的档位表里（原样显示，不冒充第一档）。 */
  | { kind: "offLadder"; raw: string };

export function effortDisplayOf(
  saved: string,
  allowed: readonly ReasoningTier[],
  loaded: boolean,
): EffortDisplay {
  if (!loaded) return { kind: "pending" };
  const raw = saved.trim();
  if (raw === "") return { kind: "unset" };
  const hit = allowed.find((tier) => tier === raw);
  return hit != null ? { kind: "tier", tier: hit } : { kind: "offLadder", raw };
}

/**
 * 配色档：`high` 以下与 `xhigh` 都是绿，`ultra` 才换成紫金渐变 + 星点。
 *
 * 对齐 Codex 的视觉分级（截图：高 = 绿、Ultra = 紫 + 星），**不是**每档一个颜色：
 * 颜色承担的是"这档有多猛"的分级，档位名已经说清了具体是哪一档。
 */
export function tierTone(tier: ReasoningTier): "normal" | "ultra" {
  return tier === "ultra" ? "ultra" : "normal";
}
