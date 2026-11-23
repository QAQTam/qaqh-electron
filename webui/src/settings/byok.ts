/**
 * BYOK 服务商创建写口：支持 0~N 个模型一次性顺序写入。
 *
 * 先调用 `provider.upsert` 创建端点与凭据，再对勾选/输入的模型逐条调用
 * `provider.model.upsert`（每条写入均由 registry 自动携带最新 config_revision）。
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

export type ByokModelDraft = {
  id: string;
  label?: string | null;
};

export type ByokFormInput = {
  name: string;
  baseUrl: string;
  wire: string;
  apiKey: string;
  models: ByokModelDraft[];
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsImages: boolean;
};

export type ByokCreateResult =
  | { ok: true; providerId: string; addedModels: number }
  | { ok: false; error: string };

export async function createByokProvider(input: ByokFormInput): Promise<ByokCreateResult> {
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

  let addedModels = 0;
  for (const item of input.models) {
    const modelId = item.id.trim();
    if (!modelId) continue;
    const definition: ModelDef = {
      enabled: true,
      display_name: item.label ?? null,
      context_window: input.contextWindow,
      max_output_tokens: input.maxOutputTokens,
      reasoning_levels: input.supportsReasoning
        ? ["low", "medium", "high", "xhigh", "max"]
        : [],
      capabilities: {
        tool_calls: input.supportsTools,
        image_input: input.supportsImages,
        native_web_search: false,
        reasoning: input.supportsReasoning,
      },
      defaults: { max_output_tokens: input.maxOutputTokens, native_web_search: false },
    };
    if (!(await saveModel(providerId, modelId, definition))) {
      return {
        ok: false,
        error: `服务商已创建，但写入模型 ${modelId} 失败：${registryError() ?? "未知错误"}`,
      };
    }
    addedModels += 1;
  }

  return { ok: true, providerId, addedModels };
}
