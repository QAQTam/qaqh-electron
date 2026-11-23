/**
 * BYOK 服务商新建表单（Lite 紧凑版）：
 *  - 支持不填模型先建服务商，也支持探测在线模型后多选勾选 / 逗号换行一次批量添加多个模型；
 *  - 能力声明收敛为单行胶囊，上下文/最大输出给合理默认值并折叠进「高级配置」。
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconRefreshCw from "~icons/lucide/refresh-cw";

import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { createByokProvider, type ByokModelDraft } from "./byok";
import { Field, TextInput } from "./controls";
import { WIRE_LABELS, WIRE_PROTOCOLS } from "./patch";
import { registryBusy } from "./registry";
import { fetchLiveModels } from "./registry/model-fetcher";
import { ensurePresetsLoaded, presetTemplates } from "./registry/provider-presets";
import { PROVIDER_TEMPLATES } from "./registry/templates";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT = 8192;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function parseManualIds(raw: string): string[] {
  return raw
    .split(/[\r\n,，]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export const ByokProviderForm: Component<{
  submitLabel?: string;
  onCancel?: () => void;
  onSaved?: (providerId: string) => void;
}> = (props) => {
  const firstTemplate = PROVIDER_TEMPLATES[0]!;
  ensurePresetsLoaded();
  const templates = presetTemplates;

  const [templateId, setTemplateId] = createSignal(firstTemplate.id);
  const [providerName, setProviderName] = createSignal(firstTemplate.name);
  const [baseUrl, setBaseUrl] = createSignal(firstTemplate.baseUrl);
  const [wire, setWire] = createSignal(firstTemplate.wire);
  const [apiKey, setApiKey] = createSignal("");
  const [manualModels, setManualModels] = createSignal("");
  const [selectedLiveIds, setSelectedLiveIds] = createSignal<string[]>([]);
  const [liveModels, setLiveModels] = createSignal<Array<{ id: string; label: string }>>([]);

  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [contextLength, setContextLength] = createSignal(String(DEFAULT_CONTEXT_WINDOW));
  const [maxTokens, setMaxTokens] = createSignal(String(DEFAULT_MAX_OUTPUT));
  const [supportsTools, setSupportsTools] = createSignal(true);
  const [supportsReasoning, setSupportsReasoning] = createSignal(false);
  const [supportsImages, setSupportsImages] = createSignal(false);

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
    setLiveModels([]);
    setSelectedLiveIds([]);
    setError(null);
  };

  const toggleLiveModel = (id: string): void => {
    setSelectedLiveIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const mergedModels = createMemo<ByokModelDraft[]>(() => {
    const seen = new Set<string>();
    const list: ByokModelDraft[] = [];
    const labelMap = new Map(liveModels().map((m) => [m.id, m.label]));
    for (const id of selectedLiveIds()) {
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ id, label: labelMap.get(id) ?? null });
    }
    for (const id of parseManualIds(manualModels())) {
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ id, label: labelMap.get(id) ?? null });
    }
    return list;
  });

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
        setError(result.error ?? "未能获取在线模型列表，仍可手动填写。");
        return;
      }
      setLiveModels(result.models.map((item) => ({ id: item.id, label: item.label })));
      setSelectedLiveIds([]);
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
    if (name === "" || url === "") {
      setError("请填写服务商名称与 Base URL。");
      return;
    }
    const context = Number(contextLength() || DEFAULT_CONTEXT_WINDOW);
    const tokens = Number(maxTokens() || DEFAULT_MAX_OUTPUT);
    if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(tokens) || tokens <= 0) {
      setError("上下文窗口与最大输出需为正整数。");
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
        models: mergedModels(),
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

  const submitText = (): string => {
    if (saving()) return "保存中…";
    const base = props.submitLabel ?? "添加服务商";
    const count = mergedModels().length;
    return count > 0 ? `${base}（含 ${count} 个模型）` : base;
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
      <Field label="API 协议">
        <Select
          value={wire()}
          options={WIRE_PROTOCOLS.map((item) => ({ value: item, label: WIRE_LABELS[item] ?? item }))}
          onChange={setWire}
          ariaLabel="API 协议"
        />
      </Field>
      <Field label="API Key" hint="本地服务可留空">
        <TextInput
          type="password"
          value={apiKey()}
          onInput={setApiKey}
          placeholder={keyHint()}
          autocomplete="new-password"
        />
      </Field>

      <Field label="模型（可多选或逗号分隔，亦可留空稍后添加）" wide>
        <div class="model-picker-row">
          <div class="model-picker-input">
            <TextInput
              value={manualModels()}
              onInput={setManualModels}
              placeholder="如 deepseek-chat, deepseek-reasoner"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={fetching() || baseUrl().trim() === ""}
            onClick={() => void probeModels()}
          >
            <IconRefreshCw class={{ "icon-spin": fetching() }} />
            {fetching() ? "探测中…" : "探测在线模型"}
          </Button>
        </div>

        <Show when={liveModels().length > 0}>
          <div class="byok-live-toolbar">
            <span class="field-hint">
              已选 {selectedLiveIds().length} / {liveModels().length}
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedLiveIds(liveModels().map((m) => m.id))}
              >
                全选
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedLiveIds([])}>
                清空
              </Button>
            </div>
          </div>
          <div class="model-preset-pills">
            <For each={liveModels()}>
              {(entry) => {
                const picked = () => selectedLiveIds().includes(entry.id);
                return (
                  <button
                    type="button"
                    class={`model-preset-pill${picked() ? " active" : ""}`}
                    onClick={() => toggleLiveModel(entry.id)}
                  >
                    <Show when={picked()}>
                      <IconCheck style={{ width: "12px", height: "12px" }} />
                    </Show>
                    <span>{entry.label}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </Field>

      <div class="settings-row-wide byok-advanced-bar">
        <Button size="sm" variant="ghost" onClick={() => setShowAdvanced((v) => !v)}>
          <IconChevronDown style={{ transform: showAdvanced() ? "rotate(180deg)" : "none", transition: "transform 140ms" }} />
          <span>高级配置（能力与窗口）</span>
        </Button>
      </div>

      <Show when={showAdvanced()}>
        <div class="settings-row-wide byok-cap-row">
          <button
            type="button"
            class={`byok-cap-chip${supportsTools() ? " active" : ""}`}
            onClick={() => setSupportsTools((v) => !v)}
          >
            <Show when={supportsTools()}><IconCheck /></Show>
            <span>工具调用</span>
          </button>
          <button
            type="button"
            class={`byok-cap-chip${supportsReasoning() ? " active" : ""}`}
            onClick={() => setSupportsReasoning((v) => !v)}
          >
            <Show when={supportsReasoning()}><IconCheck /></Show>
            <span>推理思考</span>
          </button>
          <button
            type="button"
            class={`byok-cap-chip${supportsImages() ? " active" : ""}`}
            onClick={() => setSupportsImages((v) => !v)}
          >
            <Show when={supportsImages()}><IconCheck /></Show>
            <span>图片输入</span>
          </button>
        </div>
        <Field label="上下文窗口">
          <TextInput type="number" value={contextLength()} onInput={setContextLength} />
        </Field>
        <Field label="最大输出 Token">
          <TextInput type="number" value={maxTokens()} onInput={setMaxTokens} />
        </Field>
      </Show>

      <Show when={error()}>
        {(message) => <p class="field-hint is-error settings-row-wide" role="alert">{message()}</p>}
      </Show>

      <div class="wizard-actions settings-row-wide">
        <Button
          size="sm"
          variant="primary"
          disabled={saving() || fetching() || registryBusy()}
          onClick={() => void submit()}
        >
          {submitText()}
        </Button>
        <Show when={props.onCancel != null}>
          <Button size="sm" variant="ghost" onClick={() => props.onCancel?.()}>
            取消
          </Button>
        </Show>
      </div>
    </>
  );
};
