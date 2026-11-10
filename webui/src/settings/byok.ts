/**
 * BYOK 服务商的创建写口（纯逻辑，不依赖 UI / DOM）。
 *
 * 首次引导和「设置 → 服务商」共用这一份：先 `provider.upsert` 建端点与凭据，
 * 再 `provider.model.upsert` 登记第一个模型。两次写都由 registry 带
 * `config_revision` 前置条件，失败时不留下半个服务商。
 */
import type { ModelDef } from "../api/qaqh/ModelDef";
import {
  newId,
  refreshRegistry,
  registry,
  registryError,
  saveModel,
  saveProvider,
} from "./registry";

export type ByokFormInput = {
  name: string;
  baseUrl: string;
  wire: string;
  apiKey: string;
  model: string;
  modelLabel: string | null;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * 能力声明三态。语义分层（后端 resolver.rs 实测）：`reasoning` 是**资格**——
   * 关掉后给该模型设思考档位会被 resolver 拒绝；`tool_calls`/`image_input`
   * 是目录声明（装配门在端点 compat 与会话 tool_mode，不在这里）。
   * 声明错了比不声明更糟：全 false 会让新模型永远配不了思考档位。
   */
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsImages: boolean;
};

export type ByokCreateResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

export async function createByokProvider(input: ByokFormInput): Promise<ByokCreateResult> {
  // 写前刷新一次，避免引导页与设置页各持有过期的 config_revision。
  await refreshRegistry();
  const current = registry();
  const providerId = newId(
    `${input.name}-provider`,
    (current?.providers ?? []).map((item) => item.id),
  );
  const providerSaved = await saveProvider(providerId, {
    name: input.name,
    baseUrl: input.baseUrl,
    wire: input.wire,
    credential: "api_key",
    ...(input.apiKey.trim() === "" ? {} : { apiKey: input.apiKey }),
  });
  if (!providerSaved) return { ok: false, error: registryError() ?? "保存服务商失败" };

  const definition: ModelDef = {
    enabled: true,
    display_name: input.modelLabel,
    context_window: input.contextWindow,
    max_output_tokens: input.maxOutputTokens,
    // 通用 OpenAI 档词汇；gate 的 normalize/allowlist 会吸附端点差异，
    // 厂商特殊词汇（qwen 的 xhigh/max 映射等）留给模型编辑改这张表。
    reasoning_levels: input.supportsReasoning
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : [],
    capabilities: {
      tool_calls: input.supportsTools,
      image_input: input.supportsImages,
      native_web_search: false,
      reasoning: input.supportsReasoning,
    },
    defaults: { max_output_tokens: input.maxOutputTokens, native_web_search: false },
  };
  if (!await saveModel(providerId, input.model, definition)) {
    return { ok: false, error: registryError() ?? "保存模型目录失败" };
  }
  return { ok: true, providerId };
}
