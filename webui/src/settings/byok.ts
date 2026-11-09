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
    reasoning_levels: [],
    capabilities: {
      tool_calls: false,
      image_input: false,
      native_web_search: false,
      reasoning: false,
    },
    defaults: { max_output_tokens: input.maxOutputTokens, native_web_search: false },
  };
  if (!await saveModel(providerId, input.model, definition)) {
    return { ok: false, error: registryError() ?? "保存模型目录失败" };
  }
  return { ok: true, providerId };
}
