/**
 * 模型特判合集 —— **单一数据源**，前端代管。
 *
 * ## 为什么在前端
 *
 * 后端（SDK / daemon）短期内没有 per-provider 的模型结构可挂（`mutilproviderconfig`
 * 那类东西），而"这个模型支持哪些档位、窗口多大、默认哪档"是**展示与选择**的事，
 * 不影响请求形状（请求形状由后端的 compat 收口）。所以照 Codex 的做法：
 * 上游目录只给 slug/displayName（`siwc.models` 实测如此），**其余特判自己收一份**。
 * 代价要说清：这份数据是**我们维护**的，上游新增模型时不会自动出现——目录里有而
 * 这里没有的模型，一律走保守缺省（见 `modelSpec().known`）。
 *
 * ## 与 Codex 的对应关系
 *
 * | Codex | 这里 |
 * |---|---|
 * | `defaultThinkingEffortByModelSlug` | `defaultEffort` |
 * | `sliderSettings[{modelSlug, thinkingEffort}]` | `efforts`（该模型允许的档位） |
 * | 模型目录里的 `modelContextWindow` | `contextWindow` |
 *
 * 档位阶梯与后端**逐字同序**（`qaqh-gate/src/types.rs::EFFORT_LADDER` 六档：
 * low → medium → high → xhigh → max → ultra），可用性再由后端按端点 compat 钳制
 * （`clamp_effort_to_allowlist`，稀疏允许表按阶梯距离吸附，未知值给最高允许档）。
 * Codex 自己那套没有 `max`，所以"哪几家能选 `max`"必须靠各桶的 `efforts` 明写，
 * 不能指望"缺省即全阶梯"。
 */

/** 推理强度档位。顺序即阶梯，由弱到强；与后端 `EFFORT_LADDER` 逐字同序。
 *
 * `ultra` 的来历（2026-10-14 复核，别再按"后端只有五档"改掉它）：
 *  - 上游 `origin/main` 的 `aa7f2b3 feat(siwc): … effort ultra …`（10-14 11:17）
 *    把 `EFFORT_LADDER` 定成六档，`ConfigPatch::validate` 收
 *    `low|medium|high|xhigh|max|ultra`；前端 16:43 那次"与后端六档同序"是对它的镜像。
 *  - 本地那份 `../qaqh-backend` checkout 停在 `6a0e282`（10-10 冻结基线，落后上游
 *    12 个提交且已分叉），那里还是五档 —— **拿它当权威会得出相反的错误结论**。
 *  - 已知裂缝：随仓 sidecar `src-tauri/binaries/qaqh-daemon-*` 是 `2.0.0-beta.3`
 *    （10-11 构建，比 aa7f2b3 早三天），字符串里没有 `ultra`。也就是说**当前这个
 *    二进制会拒 ultra**，而它该被重新构建到 RC1。见 README「推理强度档位」。
 */
export type ReasoningTier = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * 全阶梯。缺 `efforts` 的模型按它展示（真实可用性由后端钳制兜底）。
 *
 * `max` 不是新档：后端一直有它（`EFFORT_LADDER` 六档、`ConfigPatch::validate`
 * 也收 `low|medium|high|xhigh|max|ultra`），是前端此前只镜像了 Codex 那五档。
 * 于是 DeepSeek 平台自报的 `low|high|max` 里最高那档在前端选不出来——两边对齐。
 */
export const EFFORT_LADDER: readonly ReasoningTier[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** 未收录模型的保守缺省。**不要**在这里给"更强"的值：猜大了会撞上游上限。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_EFFORT: ReasoningTier = "medium";

/**
 * 套餐（Codex 直连）那套阶梯：与 Codex 的中文词条/档位数一致，**不含 `max`**。
 *
 * 套餐路由的 `effort_max` 是 `ultra`（不会把 `max` 钳走），但"我们没见 Codex
 * 发过 `max`"就等于"不知道它认不认"——多放一档的代价是 400 打在这次请求上，
 * 所以套餐桶显式声明这五档，保持既有行为不变。
 */
const PLAN_EFFORTS: readonly ReasoningTier[] = ["low", "medium", "high", "xhigh", "ultra"];

export type ModelSpec = {
  /** 展示名；上游 `displayName` 缺失时用它兜底。 */
  displayName?: string;
  /** 该模型支持的档位；缺省 = 全阶梯。 */
  efforts?: readonly ReasoningTier[];
  /** 默认档位（Codex 的 `defaultThinkingEffortByModelSlug`）。 */
  defaultEffort?: ReasoningTier;
  /** 上下文窗口（本地压缩分母）。 */
  contextWindow?: number;
  /** 备注：给后来的人看"这条为什么这么写"。 */
  notes?: string;
};

/**
 * 合集本体。`plan` 的 slug 来自 `siwc.models` 的**实测**（2026-10-14，
 * 账户 tsy3minso@gmail.com）；`byok` 只收我们确实知道差异的模型——用户自己的
 * 端点上的模型千变万化，编一份表反而有害。
 */
export const MODEL_SPECS: {
  plan: Record<string, ModelSpec>;
  account: Record<string, ModelSpec>;
  byok: Record<string, ModelSpec>;
} = {
  plan: {
    // 套餐模式统一 565K（产品口径）：上游目录不给窗口，按同一个数字收口，
    // 免得每个模型各写一个没人验证过的值。
    "gpt-6.1-sol": { displayName: "GPT-6.1 Sol", contextWindow: 565_000, efforts: PLAN_EFFORTS },
    "gpt-6-astra": { displayName: "GPT-6-Astra", contextWindow: 565_000, efforts: PLAN_EFFORTS },
    "gpt-6-sol": { displayName: "GPT-6-Sol", contextWindow: 565_000, efforts: PLAN_EFFORTS },
    "gpt-6-luna": { displayName: "GPT-6-Luna", contextWindow: 565_000, efforts: PLAN_EFFORTS },
    "gpt-5.6-sol": { displayName: "GPT-5.6-Sol", contextWindow: 565_000, efforts: PLAN_EFFORTS },
    "gpt-5.6-terra": { displayName: "GPT-5.6-Terra", contextWindow: 565_000, efforts: PLAN_EFFORTS },
    "gpt-5.6-luna": { displayName: "GPT-5.6-Luna", contextWindow: 565_000, efforts: PLAN_EFFORTS },
  },
  // BYOK：空是有意的。收录一条就必须能说出它的差异；说不出就别写。
  byok: {},
  /*
   * DeepSeek 账号（`deepseek_account`）：**实测**（2026-10-14，
   * `GET https://api.deepseek.com/models` 带账号凭据；`examples/probe_models.rs`
   * 复核）。平台每条给的是：`context_window: 1048576`、`max_output_tokens: 393216`、
   * `effort.default_level: "high"`、`input_modalities` 见下、以及
   * `api_capabilities.anthropic_messages.system_prompt_update`（flash = `in-history`，
   * pro = `leading-only`——和参照实现声明的模型能力对得上）。
   *
   * 档位只收**平台自己声明的**：它给的是 `effort.supported_levels: ["low","high","max"]`。
   * 多放一个它不认的档，请求会以 400 打在推理端点上（比"少一档"糟得多）。
   *
   * 平台的最高档就叫 `max`，而后端阶梯里本来就有同名的 `max`（第五档），所以
   * 原样放它；**不**用 `ultra` 顶替——`ultra` 是 Codex 那套的说法，平台不认。
   */
  account: {
    "deepseek-flash": {
      displayName: "DeepSeek-V4.1-Flash",
      contextWindow: 1_048_576,
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
      notes:
        "实测：context_window 1048576 / max_output_tokens 393216 / input_modalities 含 image（多模态）；平台档位 low|high|max（原样收，含 max）",
    },
    "deepseek-v4-pro": {
      displayName: "DeepSeek-V4-Pro",
      contextWindow: 1_048_576,
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
      notes:
        "实测：context_window 1048576 / max_output_tokens 393216 / 纯文本（input_modalities 只有 text）；档位同 flash",
    },
  },
};

/** Provider 归类：套餐走 `plan`，DeepSeek 账号走 `account`，其余（BYOK）走 `byok`。 */
export type SpecBucket = "plan" | "account" | "byok";

export type ModelSpecLookup = {
  spec: ModelSpec;
  /** `false` = 合集里没有这条，字段全是保守缺省（UI 该据此标「未收录」）。 */
  known: boolean;
};

/**
 * 查一条模型特判。**未收录不报错**：上游随时会加模型，报错会让选择器整个坏掉；
 * 但必须把 `known: false` 透出去，界面才有机会说"这个模型我们没收录"。
 */
export function modelSpec(bucket: SpecBucket, model: string): ModelSpecLookup {
  const found = MODEL_SPECS[bucket][model];
  return found == null ? { spec: {}, known: false } : { spec: found, known: true };
}

/** 该模型可选的档位（缺省 = 全阶梯）。 */
export function modelEfforts(spec: ModelSpec): readonly ReasoningTier[] {
  return spec.efforts ?? EFFORT_LADDER;
}

/** 该模型的默认档位（不在可选档位里时落到最弱档，别给一个它不支持的档）。 */
export function modelDefaultEffort(spec: ModelSpec): ReasoningTier {
  const allowed = modelEfforts(spec);
  if (spec.defaultEffort != null && allowed.includes(spec.defaultEffort)) return spec.defaultEffort;
  return allowed[0] ?? DEFAULT_EFFORT;
}

/** 该模型的上下文窗口（缺省 = 保守值，不是"很大"）。 */
export function modelContextWindow(spec: ModelSpec): number {
  return spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * GPT 家族判定。套餐目录的 slug 一律 `gpt-*`（实测 2026-10-14，见上表）；BYOK
 * 上用户自己的端点同理。**只认前缀不猜全表**：上游加新模型不该让这里的名单过期。
 * 目前唯一的消费者是思考摘要的富呈现特判（`../turn/thinking-label`）。
 */
export function isGptFamilyModel(model: string): boolean {
  return /^gpt[-_]/i.test(model.trim());
}
