/**
 * 思考块的标签决策:后端 `TimelineBlock.reasoning_kind` → 折叠行上的字。
 *
 * 为什么值得单独一个模块:订阅套餐(Responses + ChatGPT 订阅登录)路径上,服务端
 * **只回传思考摘要**——完整思考写在 `encrypted_content` 里,服务端加密,客户端只能
 * 原样回传、无法解密(抓 TLS 的本地代理同样只拿到密文)。把摘要和模型原文都叫
 * 「思考」,用户就会以为看到的是模型怎么想的。这里把两档分开,并且只有摘要档
 * (`summary`)才需要解释「为什么不是原文」。
 *
 * `text`(完整思考)与缺失(后端未标注:本字段引入前的历史,或只收到 delta 还没
 * 等到 `block_opened`)一律按「思考」显示——**不猜**。
 */
import { STR } from "../lib/strings";
import { isGptFamilyModel } from "../models/specs";
import type { ReasoningKind } from "../api/qaqh/ReasoningKind";

/** 折叠行标签。 */
export function thinkingLabel(kind: ReasoningKind | null | undefined): string {
  return kind === "summary" ? STR.thinkingSummary : STR.thinking;
}

/** 悬停说明;无需解释的档位返回 `undefined`(不挂空 title)。 */
export function thinkingTitle(kind: ReasoningKind | null | undefined): string | undefined {
  return kind === "summary" ? STR.thinkingSummaryTitle : undefined;
}

/**
 * 思考块的**富呈现**特判:当前配置是套餐(OAuth)且模型属 GPT 家族时,上游回传的
 * 摘要本身是 markdown(小标题/列表/代码块),按纯文本渲染会把 `##`、`-` 原样摆给
 * 用户。此时**不折叠**(默认展开)并走流式 Markdown;其余配置照旧纯文本+折叠。
 *
 * 判据读**配置**而不是 `reasoning_kind`:历史回合可能缺标注,而「套餐 + GPT 家族」
 * 本身已保证这块内容是服务端摘要——按 kind 再闸一道只会把缺标注的块漏回纯文本。
 */
export function thinkingRichSummary(oauthPlan: boolean, model: string): boolean {
  return oauthPlan && isGptFamilyModel(model);
}
