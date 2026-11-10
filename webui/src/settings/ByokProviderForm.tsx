/**
 * 自带 API key（BYOK）服务商的新建表单与写口。
 *
 * 首次引导与「设置 → 服务商」共用同一份：引导只在零可用 provider 时弹出，
 * 已经登录账号之后仍要能新增 BYOK，靠的就是设置页这个入口。表单只负责收集
 * 输入，写入统一走 registry 的 provider.upsert / provider.model.upsert
 * （都带 config_revision），不另开第二条命令路径。
 */
import { createSignal, For, Show, type Component } from "solid-js";

import { Select } from "../ui/Select";
import { createByokProvider } from "./byok";
import { Field, Switch, TextInput } from "./controls";
import { WIRE_LABELS, WIRE_PROTOCOLS } from "./patch";
import { registryBusy } from "./registry";
import { fetchLiveModels } from "./registry/model-fetcher";
import { ensurePresetsLoaded, presetTemplates } from "./registry/provider-presets";
import { PROVIDER_TEMPLATES } from "./registry/templates";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * 返回的是 Fragment：调用方决定容器（引导用 onboarding-byok，设置页用
 * byok-form），表单项直接成为那个 grid 的子项，两处都保持两列布局。
 */
export const ByokProviderForm: Component<{
  submitLabel?: string;
  onCancel?: () => void;
  onSaved?: (providerId: string) => void;
}> = (props) => {
  const firstTemplate = PROVIDER_TEMPLATES[0]!;
  // 芯片列表：后端 presets（真源）异步合并进静态兜底，见 registry/provider-presets。
  ensurePresetsLoaded();
  const templates = presetTemplates;
  const [templateId, setTemplateId] = createSignal(firstTemplate.id);
  const [providerName, setProviderName] = createSignal(firstTemplate.name);
  const [baseUrl, setBaseUrl] = createSignal(firstTemplate.baseUrl);
  const [wire, setWire] = createSignal(firstTemplate.wire);
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal("");
  const [contextLength, setContextLength] = createSignal("");
  const [maxTokens, setMaxTokens] = createSignal("");
  // 能力声明：reasoning 是设置思考档位的资格（resolver fail-fast 校验），
  // tool_calls/image_input 是目录声明——装配门在端点 compat 与会话工具模式。
  // 默认勾选工具调用：当代 agent 模型的主场景。
  const [supportsTools, setSupportsTools] = createSignal(true);
  const [supportsReasoning, setSupportsReasoning] = createSignal(false);
  const [supportsImages, setSupportsImages] = createSignal(false);
  const [liveModels, setLiveModels] = createSignal<Array<{ id: string; label: string }>>([]);
  const [fetching, setFetching] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const keyHint = (): string =>
    templates().find((item) => item.id === templateId())?.keyHint ?? "sk-...";

  const applyTemplate = (id: string): void => {
    const template = templates().find((item) => item.id === id);
    if (template == null) return;
    setTemplateId(id);
    setProviderName(template.name);
    setBaseUrl(template.baseUrl);
    setWire(template.wire);
    setContextLength("");
    setMaxTokens("");
    setLiveModels([]);
    setError(null);
  };

  const probeModels = async (): Promise<void> => {
    if (fetching()) return;
    setFetching(true);
    setError(null);
    try {
      const result = await fetchLiveModels({
        baseUrl: baseUrl(),
        wire: wire(),
        apiKey: apiKey().trim() === "" ? undefined : apiKey(),
      });
      if (!result.ok) {
        setError(result.error ?? "端点没有返回模型列表；仍可手动填写模型 id。");
        return;
      }
      setLiveModels(result.models.map((item) => ({ id: item.id, label: item.label })));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setFetching(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (saving() || fetching() || registryBusy()) return;
    const name = providerName().trim();
    const url = baseUrl().trim();
    const modelId = model().trim();
    if (name === "" || url === "" || modelId === "") {
      setError("服务商名称、Base URL 与模型 id 都必须填写。");
      return;
    }
    const context = Number(contextLength());
    const tokens = Number(maxTokens());
    if (!Number.isSafeInteger(context) || context <= 0) {
      setError("上下文窗口必须是大于 0 的整数。");
      return;
    }
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      setError("最大输出必须是正整数。");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await createByokProvider({
        name,
        baseUrl: url,
        wire: wire(),
        apiKey: apiKey(),
        model: modelId,
        modelLabel: liveModels().find((item) => item.id === modelId)?.label ?? null,
        contextWindow: context,
        maxOutputTokens: tokens,
        supportsTools: supportsTools(),
        supportsReasoning: supportsReasoning(),
        supportsImages: supportsImages(),
      });
      if (!result.ok) { setError(result.error); return; }
      setApiKey("");
      props.onSaved?.(result.providerId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div class="settings-row-wide provider-template-chips">
        <For each={templates()}>
          {(template) => (
            <button
              type="button"
              class={`provider-template-chip${templateId() === template.id ? " active" : ""}`}
              onClick={() => applyTemplate(template.id)}
            >
              {template.name}
              <small>({template.badge})</small>
            </button>
          )}
        </For>
      </div>
      <Field label="服务商名称">
        <TextInput value={providerName()} onInput={setProviderName} />
      </Field>
      <Field label="Base URL">
        <TextInput value={baseUrl()} onInput={setBaseUrl} placeholder="https://…" />
      </Field>
      <Field label="协议形态 (wire)">
        <Select
          value={wire()}
          options={WIRE_PROTOCOLS.map((item) => ({ value: item, label: WIRE_LABELS[item] ?? item }))}
          onChange={setWire}
          ariaLabel="协议形态"
        />
      </Field>
      <Field label="API key" hint="留空 = 该服务商暂不存密钥（本地 Ollama 等）">
        <TextInput
          type="password"
          value={apiKey()}
          onInput={setApiKey}
          placeholder={keyHint()}
          autocomplete="new-password"
        />
      </Field>
      <Field label="模型 id" wide>
        <div class="model-picker-row">
          <div class="model-picker-input">
            <TextInput value={model()} onInput={setModel} placeholder="填写服务商提供的模型 ID" />
          </div>
          <button
            type="button"
            class="ghost-mini"
            disabled={fetching() || baseUrl().trim() === ""}
            onClick={() => void probeModels()}
          >
            {fetching() ? "同步中…" : "探测在线模型"}
          </button>
        </div>
        <Show when={liveModels().length > 0}>
          <div class="model-preset-pills">
            <For each={liveModels()}>
              {(entry) => (
                <button
                  type="button"
                  class={`model-preset-pill${model() === entry.id ? " active" : ""}`}
                  onClick={() => setModel(entry.id)}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </Field>
      <div class="settings-row-wide byok-capability-switches">
        <Switch
          label="支持工具调用"
          hint="目录声明；回合是否带工具由会话工具模式决定"
          checked={supportsTools()}
          onToggle={setSupportsTools}
        />
        <Switch
          label="支持思考档位"
          hint="资格声明：开启后可在设置里为该模型选择思考强度（档位表可在模型编辑中调整）"
          checked={supportsReasoning()}
          onToggle={setSupportsReasoning}
        />
        <Switch
          label="支持图片输入"
          hint="目录声明：供界面判断可粘贴截图的模型"
          checked={supportsImages()}
          onToggle={setSupportsImages}
        />
      </div>
      <Field label="上下文窗口" hint="按当前模型可用的上下文窗口手动填写">
        <TextInput type="number" value={contextLength()} onInput={setContextLength} />
      </Field>
      <Field label="最大输出" hint="手动填写端点支持的最大输出 tokens">
        <TextInput type="number" value={maxTokens()} onInput={setMaxTokens} />
      </Field>
      <Show when={error()}>
        {(message) => <p class="field-hint is-error settings-row-wide" role="alert">{message()}</p>}
      </Show>
      <div class="wizard-actions settings-row-wide">
        <button
          type="button"
          class="primary-mini button-primary"
          disabled={saving() || fetching() || registryBusy()}
          onClick={() => void submit()}
        >
          {saving() ? "保存中…" : props.submitLabel ?? "添加服务商"}
        </button>
        <Show when={props.onCancel != null}>
          <button type="button" class="ghost-mini" onClick={() => props.onCancel?.()}>取消</button>
        </Show>
      </div>
    </>
  );
};
