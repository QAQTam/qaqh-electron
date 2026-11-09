/**
 * BYOK 新建写口与「设为默认」的回归测试。
 *
 * 这两条路径以前只存在于首次引导（引导不再弹就完全走不到），现在是设置页
 * 的常驻能力：必须保证端点与模型两次写都带 config_revision，且默认选择只
 * 接受目录里已启用的模型。
 */
import { beforeEach, expect, test, vi } from "vitest";
import type { ModelDef } from "@qaqh/sdk/protocol";

vi.mock("../src/lib/transport", () => ({ transport: { command: vi.fn(), query: vi.fn() } }));
vi.mock("../src/lib/config-events", () => ({ notifyConfigChanged: vi.fn(), onConfigChanged: vi.fn(() => () => {}) }));

import { transport } from "../src/lib/transport";
import { createByokProvider, type ByokFormInput } from "../src/settings/byok";
import { refreshRegistry, registryError, setDefaultModel } from "../src/settings/registry";

const model = (enabled: boolean): ModelDef => ({
  enabled,
  display_name: null,
  context_window: 65_536,
  max_output_tokens: 8_192,
  reasoning_levels: [],
  capabilities: { tool_calls: false, image_input: false, native_web_search: false, reasoning: false },
  defaults: { max_output_tokens: 8_192, native_web_search: false },
});

const input: ByokFormInput = {
  name: "My DeepSeek",
  baseUrl: "https://api.deepseek.com",
  wire: "chat",
  apiKey: "sk-test",
  model: "deepseek-chat",
  modelLabel: "DeepSeek Chat",
  contextWindow: 65_536,
  maxOutputTokens: 8_192,
};

type Write = { type: string; command: unknown; revision: number };
let writes: Write[] = [];
let revision = 7;
let providers: Record<string, Record<string, unknown>> = {};

function stubBackend(initial: Record<string, Record<string, unknown>> = {}): void {
  revision = 7;
  providers = structuredClone(initial);
  writes = [];
  vi.mocked(transport.query).mockResolvedValue({ profiles: {} });
  vi.mocked(transport.command).mockImplementation(async (command, _seed, preconditions) => {
    if (command.type === "provider.list") {
      return {
        command_id: "read", status: "accepted",
        result: { revision, providers: structuredClone(providers), default_model_selection: null },
      };
    }
    expect(preconditions).toEqual([{ kind: "config_revision", revision }]);
    writes.push({ type: command.type, command: structuredClone(command), revision });
    if (command.type === "provider.upsert") {
      providers[command.id] = { ...command.provider, models: {} };
    } else if (command.type === "provider.model.upsert") {
      const target = providers[command.provider_id] ?? {};
      const models = (target.models ?? {}) as Record<string, ModelDef>;
      models[command.model_id] = command.model;
      target.models = models;
      providers[command.provider_id] = target;
    }
    revision += 1;
    return { command_id: "write", status: "accepted", result: { revision } };
  });
}

beforeEach(() => vi.clearAllMocks());

test("新建 BYOK 服务商：端点 upsert + 模型登记，两次写都带 config_revision", async () => {
  stubBackend();
  await expect(createByokProvider(input)).resolves.toMatchObject({ ok: true });
  expect(writes.map((item) => item.type)).toEqual(["provider.upsert", "provider.model.upsert"]);
  expect(writes.map((item) => item.revision)).toEqual([7, 8]);
  expect(writes[0].command).toMatchObject({
    type: "provider.upsert",
    provider: {
      name: "My DeepSeek", base_url: "https://api.deepseek.com", wire: "chat",
      credential: "api_key", api_key: { operation: "set", value: "sk-test" },
    },
  });
  expect(writes[1].command).toMatchObject({
    type: "provider.model.upsert",
    model_id: "deepseek-chat",
    model: {
      enabled: true, display_name: "DeepSeek Chat",
      context_window: 65_536, max_output_tokens: 8_192,
    },
  });
});

test("空密钥不覆盖已有凭据（本地端点可无密钥）", async () => {
  stubBackend();
  await expect(createByokProvider({ ...input, apiKey: "", modelLabel: null }))
    .resolves.toMatchObject({ ok: true });
  expect(writes[0].command).toMatchObject({ provider: { api_key: { operation: "keep" } } });
  expect(writes[1].command).toMatchObject({ model: { display_name: null } });
});

test("设为默认：启用模型写 model.selection.set_default，停用模型拒绝且不发命令", async () => {
  stubBackend({
    p: {
      name: "P", base_url: "https://x", wire: "chat", credential: "api_key",
      models: { enabled: model(true), disabled: model(false) },
    },
  });
  await refreshRegistry();
  expect(await setDefaultModel("p", "disabled")).toBe(false);
  expect(registryError()).toContain("已停用");
  expect(writes).toHaveLength(0);

  expect(await setDefaultModel("p", "enabled")).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0].command).toMatchObject({
    type: "model.selection.set_default",
    selection: { provider_id: "p", model_id: "enabled", options: {} },
  });
});
