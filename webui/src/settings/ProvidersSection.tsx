/**
 * 服务商页：列出 backend provider/model catalog 里的 Provider（含暂时没被引用的）。
 *
 * - BYOK 行可展开编辑名称 / Base URL / wire / 密钥（留空保持、可单独清除）；
 * - 账号类（ChatGPT 套餐 / DeepSeek 账号）只读，登录与切换在侧栏「接入」页；
 * - provider 与 model 分开维护，所有目录写入都带 `config_revision`；
 * - 被存档或默认选择引用的服务商不能删（前端提前禁用，后端仍是权威）；
 * - 本页所有操作**即时写入**，不参与应用设置草稿。
 */
import { createSignal, For, Show, type Component } from "solid-js";
import IconEye from "~icons/lucide/eye";
import IconEyeOff from "~icons/lucide/eye-off";

import { toast } from "../ui/toast";
import { Select } from "../ui/Select";
import type { ModelDef } from "@qaqh/sdk/protocol";
import { Field, Section, TextInput } from "./controls";
import { MASK, WIRE_LABELS, WIRE_PROTOCOLS } from "./patch";
import {
  credentialLabel,
  deleteModel,
  deleteProvider,
  providerRows,
  registry,
  registryBusy,
  registryError,
  registryLoading,
  saveModel,
  saveProvider,
  type RegistryModel,
  type RegistryProvider,
} from "./registry";

const ModelEditor: Component<{
  providerId: string;
  model?: RegistryModel;
  onClose: () => void;
}> = (props) => {
  const definition = props.model?.definition;
  const [modelId, setModelId] = createSignal(props.model?.id ?? "");
  const [displayName, setDisplayName] = createSignal(definition?.display_name ?? "");
  const [enabled, setEnabled] = createSignal(definition?.enabled ?? true);
  const [contextWindow, setContextWindow] = createSignal(definition == null ? "" : String(definition.context_window));
  const [maxOutputTokens, setMaxOutputTokens] = createSignal(definition == null ? "" : String(definition.max_output_tokens));
  const [reasoningLevels, setReasoningLevels] = createSignal(definition?.reasoning_levels.join(", ") ?? "");
  const [reasoningEffort, setReasoningEffort] = createSignal(definition?.defaults.reasoning_effort ?? "");
  const [toolCalls, setToolCalls] = createSignal(definition?.capabilities.tool_calls ?? false);
  const [imageInput, setImageInput] = createSignal(definition?.capabilities.image_input ?? false);
  const [nativeWebSearch, setNativeWebSearch] = createSignal(definition?.capabilities.native_web_search ?? false);
  const [reasoning, setReasoning] = createSignal(definition?.capabilities.reasoning ?? false);

  const save = async (): Promise<void> => {
    const id = modelId().trim();
    const context = Number(contextWindow());
    const output = Number(maxOutputTokens());
    const levels = reasoningLevels().split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    const defaultEffort = reasoningEffort().trim();
    if (id === "") { toast("模型 ID 不能为空", "err"); return; }
    if (!Number.isSafeInteger(context) || context <= 0) { toast("上下文窗口必须是正整数", "err"); return; }
    if (!Number.isSafeInteger(output) || output <= 0) {
      toast("最大输出必须是正整数", "err");
      return;
    }
    if (defaultEffort !== "" && !levels.includes(defaultEffort)) { toast("默认推理强度必须出现在支持档位中", "err"); return; }
    const model: ModelDef = {
      enabled: enabled(),
      display_name: displayName().trim() || null,
      context_window: context,
      max_output_tokens: output,
      reasoning_levels: levels,
      capabilities: {
        tool_calls: toolCalls(), image_input: imageInput(),
        native_web_search: nativeWebSearch(), reasoning: reasoning(),
      },
      defaults: {
        max_output_tokens: output,
        reasoning_effort: defaultEffort === "" ? null : defaultEffort,
        native_web_search: nativeWebSearch(),
      },
    };
    if (await saveModel(props.providerId, id, model)) {
      toast(props.model == null ? "模型已添加" : "模型已更新", "ok");
      props.onClose();
    }
  };

  return (
    <div class="provider-editor model-editor">
      <div class="provider-editor__head"><strong>{props.model == null ? "添加模型" : `编辑模型 · ${props.model.id}`}</strong></div>
      <Field label="模型 ID">
        <TextInput value={modelId()} disabled={props.model != null} onInput={setModelId} placeholder="例如：provider/model-name" />
      </Field>
      <Field label="显示名称"><TextInput value={displayName()} onInput={setDisplayName} placeholder="可选" /></Field>
      <Field label="上下文窗口"><TextInput type="number" value={contextWindow()} onInput={setContextWindow} /></Field>
      <Field label="最大输出 tokens">
        <TextInput type="number" value={maxOutputTokens()} onInput={setMaxOutputTokens} />
      </Field>
      <Field label="推理档位" hint="逗号分隔；留空表示不声明推理档位">
        <TextInput value={reasoningLevels()} onInput={setReasoningLevels} placeholder="low, medium, high" />
      </Field>
      <Field label="默认推理档位"><TextInput value={reasoningEffort()} onInput={setReasoningEffort} placeholder="留空表示模型默认" /></Field>
      <div class="settings-row-wide model-capabilities">
        <label><input type="checkbox" checked={enabled()} onChange={(event) => setEnabled(event.currentTarget.checked)} /> 启用</label>
        <label><input type="checkbox" checked={toolCalls()} onChange={(event) => setToolCalls(event.currentTarget.checked)} /> 工具调用</label>
        <label><input type="checkbox" checked={imageInput()} onChange={(event) => setImageInput(event.currentTarget.checked)} /> 图片输入</label>
        <label><input type="checkbox" checked={nativeWebSearch()} onChange={(event) => setNativeWebSearch(event.currentTarget.checked)} /> 原生网页搜索</label>
        <label><input type="checkbox" checked={reasoning()} onChange={(event) => setReasoning(event.currentTarget.checked)} /> 推理能力</label>
      </div>
      <div class="wizard-actions">
        <button type="button" class="ghost-mini" onClick={props.onClose}>取消</button>
        <button type="button" class="primary-mini button-primary" disabled={registryBusy()} onClick={() => void save()}>
          {registryBusy() ? "保存中…" : "保存模型"}
        </button>
      </div>
    </div>
  );
};

const ProviderEditor: Component<{
  provider: RegistryProvider;
  onClose: () => void;
}> = (props) => {
  const [name, setName] = createSignal(props.provider.name);
  const [baseUrl, setBaseUrl] = createSignal(props.provider.baseUrl);
  const [wire, setWire] = createSignal(props.provider.wire);
  const [apiKey, setApiKey] = createSignal("");
  const [showKey, setShowKey] = createSignal(false);

  const save = async (): Promise<void> => {
    if (name().trim() === "" || baseUrl().trim() === "") {
      toast("服务商名称与 Base URL 不能为空", "err");
      return;
    }
    const ok = await saveProvider(props.provider.id, {
      name: name(),
      baseUrl: baseUrl(),
      wire: wire(),
      credential: props.provider.credential,
      ...(apiKey().trim() === "" ? {} : { apiKey: apiKey() }),
    });
    if (ok) {
      toast("服务商已保存", "ok");
      props.onClose();
    }
  };

  const clearKey = async (): Promise<void> => {
    const ok = await saveProvider(props.provider.id, {
      name: name(),
      baseUrl: baseUrl(),
      wire: wire(),
      credential: props.provider.credential,
      apiKey: "",
    });
    if (ok) toast("已清除该服务商的 API key", "ok");
  };

  return (
    <div class="provider-editor">
      <div class="provider-editor__head">
        <strong>{props.provider.name}</strong>
        <button type="button" class="ghost-mini" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <Show when={props.provider.referencedBy.length > 0}>
        <p class="field-hint is-warn">
          端点与密钥改动会影响引用此服务商的存档和全局默认模型。
        </p>
      </Show>

      <Field label="服务商名称">
        <TextInput value={name()} onInput={setName} placeholder="例如：DeepSeek 官方" />
      </Field>
      <Field label="Base URL" hint="scheme + host + 可选前缀，不含 wire 自身路径">
        <TextInput value={baseUrl()} onInput={setBaseUrl} placeholder="https://…" />
      </Field>
      <Field label="协议形态 (wire)">
        <Select
          value={wire()}
          options={WIRE_PROTOCOLS.map((value) => ({
            value,
            label: WIRE_LABELS[value] ?? value,
          }))}
          onChange={setWire}
          ariaLabel="协议形态"
        />
      </Field>
      <Field
        label="API key"
        hint={props.provider.apiKeySet ? "已配置；留空保持不变" : "尚未配置；留空保持不变"}
      >
        <div class="secret-input">
          <TextInput
            type={showKey() ? "text" : "password"}
            value={apiKey()}
            placeholder={props.provider.apiKeySet ? MASK : "填入新密钥"}
            autocomplete="new-password"
            spellcheck={false}
            onInput={setApiKey}
          />
          <button
            type="button"
            class="icon-btn secret-eye"
            aria-label={showKey() ? "隐藏密钥" : "显示密钥"}
            onClick={() => setShowKey(!showKey())}
          >
            <Show when={showKey()} fallback={<IconEye />}>
              <IconEyeOff />
            </Show>
          </button>
        </div>
      </Field>

      <div class="wizard-actions">
        <button
          type="button"
          class="primary-mini button-primary"
          disabled={registryBusy()}
          onClick={() => void save()}
        >
          {registryBusy() ? "保存中…" : "保存服务商"}
        </button>
        <Show when={props.provider.apiKeySet}>
          <button
            type="button"
            class="ghost-mini is-danger"
            disabled={registryBusy()}
            onClick={() => void clearKey()}
          >
            清除密钥
          </button>
        </Show>
      </div>
    </div>
  );
};

const ProviderRow: Component<{
  provider: RegistryProvider;
  onOpenOAuth?: () => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [editingModelId, setEditingModelId] = createSignal<string | null>(null);
  const [addingModel, setAddingModel] = createSignal(false);
  const account = (): boolean => props.provider.credential !== "api_key";
  const referenced = (): number => props.provider.referencedBy.length;
  const modelInUse = (modelId: string): boolean => {
    const value = registry();
    return value?.defaultSelection?.provider_id === props.provider.id && value.defaultSelection.model_id === modelId
      || value?.profiles.some((profile) => profile.providerId === props.provider.id && profile.model === modelId) === true;
  };

  const remove = async (): Promise<void> => {
    if (referenced() > 0) return;
    const ok = await deleteProvider(props.provider.id);
    if (ok) toast("服务商已删除", "ok");
  };

  return (
    <>
      <div class="profile-row provider-row">
        <span class="profile-name">
          <strong>{props.provider.name}</strong>
          <small class="provider-meta">{props.provider.baseUrl}</small>
          <small class="provider-meta">
            {props.provider.wire} · {credentialLabel(props.provider.credential)} ·{" "}
            {account() ? "账号授权" : props.provider.apiKeySet ? "密钥已存" : "未配置密钥"}
          </small>
        </span>
        <Show
          when={account()}
          fallback={
            <>
              <button
                type="button"
                class="ghost-mini"
                disabled={registryBusy()}
                onClick={() => setEditing(!editing())}
              >
                {editing() ? "收起" : "编辑"}
              </button>
              <button
                type="button"
                class="ghost-mini is-danger"
                disabled={registryBusy() || referenced() > 0}
                title={referenced() > 0 ? "先删除或改指向引用它的存档" : undefined}
                onClick={() => void remove()}
              >
                删除
              </button>
            </>
          }
        >
          <button
            type="button"
            class="ghost-mini"
            onClick={() => props.onOpenOAuth?.()}
          >
            管理登录
          </button>
        </Show>
      </div>
      <Show when={editing() && !account()}>
        <ProviderEditor provider={props.provider} onClose={() => setEditing(false)} />
      </Show>
      <details class="provider-model-catalog">
        <summary>模型目录 · {props.provider.models.length}</summary>
        <p class="field-hint">模型目录维护能力和上限；会话中可选择任一启用的模型。账号模型可在接入页刷新目录。</p>
        <For each={props.provider.models}>
          {(model) => (
            <div class="profile-row provider-model-row">
              <span class="profile-name">
                <strong>{model.definition.display_name || model.id}</strong>
                <small class="provider-meta">{model.id} · {model.definition.enabled ? "已启用" : "已停用"}</small>
                <small class="provider-meta">
                  上下文 {model.definition.context_window.toLocaleString()} · 输出 {model.definition.max_output_tokens.toLocaleString()} · 工具 {model.definition.capabilities.tool_calls ? "支持" : "未启用"}
                </small>
              </span>
              <button type="button" class="ghost-mini" disabled={registryBusy()} onClick={() => { setAddingModel(false); setEditingModelId(model.id); }}>编辑模型</button>
              <button type="button" class="ghost-mini is-danger" disabled={registryBusy() || modelInUse(model.id)} title={modelInUse(model.id) ? "默认选择或存档仍引用此模型" : undefined} onClick={() => void deleteModel(props.provider.id, model.id)}>删除</button>
            </div>
          )}
        </For>
        <Show when={editingModelId()}>
          {(id) => {
            const model = props.provider.models.find((item) => item.id === id());
            return model == null ? null : <ModelEditor providerId={props.provider.id} model={model} onClose={() => setEditingModelId(null)} />;
          }}
        </Show>
        <Show when={addingModel()}>
          <ModelEditor providerId={props.provider.id} onClose={() => setAddingModel(false)} />
        </Show>
        <button type="button" class="ghost-mini provider-model-add" disabled={registryBusy()} onClick={() => { setEditingModelId(null); setAddingModel(true); }}>＋ 添加模型</button>
      </details>
    </>
  );
};

export const ProvidersSection: Component<{
  onOpenOAuth?: () => void;
}> = (props) => {
  const rows = () => {
    const value = registry();
    return value == null ? [] : providerRows(value);
  };

  return (
    <Section
      id="section-providers"
      title="服务商"
      desc="服务商管理端点与凭据，模型目录管理能力和上限。修改后即时保存。"
    >
      <Show when={registryError()}>
        {(message) => <p class="field-hint is-error settings-row-wide">{message()}</p>}
      </Show>
      <Show when={registryLoading() && registry() == null}>
        <p class="settings-muted settings-row-wide">读取服务商与模型目录…</p>
      </Show>
      <Show when={registry() != null && rows().length === 0}>
        <p class="settings-muted settings-row-wide">
          还没有服务商。请先通过接入页登录，或使用首次设置添加服务商。
        </p>
      </Show>

      <div class="profile-list">
        <For each={rows()}>
          {(row) => <ProviderRow provider={row.provider} onOpenOAuth={props.onOpenOAuth} />}
        </For>
      </div>

    </Section>
  );
};
