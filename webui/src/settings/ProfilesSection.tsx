/**
 * Legacy profile shortcuts. Profile update is not part of the current backend contract,
 * so this view only creates/deletes profiles and changes the global model selection.
 */
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";

import { Field, Section, TextInput } from "./controls";
import { Select } from "../ui/Select";
import { toast } from "../ui/toast";
import {
  credentialLabel,
  deleteProfile,
  registry,
  registryBusy,
  registryError,
  registryLoading,
  saveProfile,
  setDefaultProfile,
  type RegistryProfile,
} from "./registry";

const optionalPositive = (raw: string): number | null | undefined => {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const ProfileEditor: Component<{ onClose: () => void }> = (props) => {
  const [name, setName] = createSignal("");
  const [providerId, setProviderId] = createSignal(registry()?.providers[0]?.id ?? "");
  const [modelId, setModelId] = createSignal("");
  const [effort, setEffort] = createSignal("");
  const [maxTokens, setMaxTokens] = createSignal("");
  const providers = createMemo(() => registry()?.providers ?? []);
  const selectedProvider = createMemo(() => providers().find((provider) => provider.id === providerId()));
  const models = createMemo(() => selectedProvider()?.models.filter((model) => model.definition.enabled) ?? []);
  const selectedModel = createMemo(() => models().find((model) => model.id === modelId()));
  const providerOptions = createMemo(() => providers().map((provider) => ({
    value: provider.id,
    label: `${provider.name} · ${credentialLabel(provider.credential)}`,
  })));
  const modelOptions = createMemo(() => models().map((model) => ({
    value: model.id,
    label: model.definition.display_name == null || model.definition.display_name === ""
      ? model.id
      : `${model.definition.display_name} · ${model.id}`,
  })));
  const effortOptions = createMemo(() => [
    { value: "", label: "跟随模型默认" },
    ...(selectedModel()?.definition.reasoning_levels ?? []).map((level) => ({ value: level, label: level })),
  ]);

  createEffect(models, (available) => {
    if (!available.some((model) => model.id === modelId())) {
      setModelId(available[0]?.id ?? "");
      setEffort("");
      setMaxTokens("");
    }
  });

  const save = async (): Promise<void> => {
    const cleanName = name().trim();
    const provider = selectedProvider();
    const model = selectedModel();
    const tokens = optionalPositive(maxTokens());
    if (cleanName === "") { toast("请填写存档名称", "err"); return; }
    if (provider == null || model == null) { toast("请选择服务商目录中的启用模型", "err"); return; }
    if (tokens === undefined) { toast("最大输出必须是大于 0 的整数，留空表示跟随模型默认", "err"); return; }

    const saved = await saveProfile({
      name: cleanName,
      provider: provider.id,
      model: model.id,
      effort: effort() === "" ? null : effort(),
      maxTokens: tokens,
    });
    if (saved != null) {
      toast("存档已创建", "ok");
      props.onClose();
    }
  };

  return (
    <div class="profile-wizard-card">
      <div class="provider-editor__head">
        <strong>新建存档</strong>
        <button type="button" class="ghost-mini" onClick={props.onClose}>关闭</button>
      </div>
      <Field label="存档名称" wide>
        <TextInput value={name()} onInput={setName} placeholder="例如：快速审阅" />
      </Field>
      <Field label="服务商">
        <Select value={providerId()} options={providerOptions()} onChange={setProviderId} ariaLabel="服务商" />
      </Field>
      <Field label="模型">
        <Select value={modelId()} options={modelOptions()} onChange={(value) => { setModelId(value); setEffort(""); setMaxTokens(""); }} ariaLabel="模型" />
      </Field>
      <Show when={selectedModel()}>
        {(model) => <p class="field-hint settings-row-wide">模型上下文窗口：{model().definition.context_window.toLocaleString()} tokens</p>}
      </Show>
      <Field label="推理强度">
        <Select value={effort()} options={effortOptions()} onChange={setEffort} ariaLabel="推理强度" />
      </Field>
      <Field label="最大输出 tokens" hint="留空 = 跟随模型默认">
        <TextInput type="number" value={maxTokens()} onInput={setMaxTokens} placeholder={String(selectedModel()?.definition.defaults.max_output_tokens ?? selectedModel()?.definition.max_output_tokens ?? "")}/>
      </Field>
      <div class="wizard-actions">
        <button type="button" class="primary-mini button-primary" disabled={registryBusy() || providers().length === 0 || models().length === 0} onClick={() => void save()}>
          {registryBusy() ? "保存中…" : "创建存档"}
        </button>
      </div>
    </div>
  );
};

const ProfileRow: Component<{ profile: RegistryProfile }> = (props) => {
  const remove = async (): Promise<void> => {
    if (props.profile.isDefault) return;
    if (await deleteProfile(props.profile.id)) toast("存档已删除", "ok");
  };
  const makeDefault = async (): Promise<void> => {
    if (await setDefaultProfile(props.profile.id)) toast(`已将「${props.profile.name}」设为默认模型`, "ok");
  };
  return (
    <div class={`profile-row${props.profile.isDefault ? " active" : ""}`}>
      <span class="profile-name">
        <strong>{props.profile.name}</strong>
        <small class="provider-meta">{props.profile.model}</small>
        <small class="provider-meta">{props.profile.providerName} · {credentialLabel(props.profile.credential)}</small>
        <small class="provider-meta">
          {props.profile.effort ?? "跟随模型"} · 上下文 {props.profile.contextLength ?? "模型默认"} · 最大输出 {props.profile.maxTokens ?? "模型默认"}
        </small>
      </span>
      <Show when={props.profile.isDefault}><span class="profile-active-tag">● 默认模型</span></Show>
      <button type="button" class="ghost-mini" disabled={registryBusy() || props.profile.isDefault} onClick={() => void makeDefault()}>设为默认</button>
      <button
        type="button"
        class="ghost-mini is-danger"
        disabled={registryBusy() || props.profile.isDefault}
        title={props.profile.isDefault ? "默认模型不可删除，请先切换默认模型" : undefined}
        onClick={() => void remove()}
      >删除</button>
    </div>
  );
};

export const ProfilesSection: Component = () => {
  const [creating, setCreating] = createSignal(false);
  const profiles = () => registry()?.profiles ?? [];
  return (
    <Section
      id="section-profiles"
      title="存档"
      desc="存档保留服务商、模型和参数快捷组合；修改已有存档暂不支持。默认模型选择即时写入。"
    >
      <Show when={registryError() != null}>
        {(message) => <p class="field-hint is-error settings-row-wide">{message()}</p>}
      </Show>
      <Show when={registryLoading() && registry() == null}><p class="settings-muted settings-row-wide">读取中…</p></Show>
      <Show when={registry() != null && profiles().length === 0}>
        <p class="settings-muted settings-row-wide">还没有存档。请先到「服务商」添加并启用模型，再创建存档。</p>
      </Show>
      <div class="profile-list">
        <For each={profiles()}>{(profile) => <ProfileRow profile={profile} />}</For>
      </div>
      <Show when={creating()} fallback={
        <div class="settings-row-wide">
          <button type="button" class="ghost-mini provider-cta" disabled={registryBusy()} onClick={() => setCreating(true)}>＋ 新建存档</button>
        </div>
      }>
        <ProfileEditor onClose={() => setCreating(false)} />
      </Show>
    </Section>
  );
};
