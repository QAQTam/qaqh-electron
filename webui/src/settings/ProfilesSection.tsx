/**
 * Legacy profile shortcuts. Profile update is not part of the current backend contract,
 * so this view only creates/deletes profiles and changes the global model selection.
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";

import { Field, Section, TextInput } from "./controls";
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
  modelSelectionIssue,
  type RegistryProfile,
} from "./registry";

const optionalMaxOutput = (raw: string): number | null | undefined => {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

const ProfileEditor: Component<{ initial?: RegistryProfile; onClose: () => void }> = (props) => {
  const [name, setName] = createSignal(props.initial == null ? "" : `${props.initial.name} 副本`);
  const [providerId, setProviderId] = createSignal(props.initial?.providerId ?? "");
  const [modelId, setModelId] = createSignal(props.initial?.model ?? "");
  const [effort, setEffort] = createSignal(props.initial?.effort ?? "");
  const [maxTokens, setMaxTokens] = createSignal(props.initial?.maxTokens == null ? "" : String(props.initial.maxTokens));
  const providers = createMemo(() => registry()?.providers ?? []);
  const selectedProvider = createMemo(() => providers().find((provider) => provider.id === providerId().trim()));
  const models = createMemo(() => selectedProvider()?.models.filter((model) => model.definition.enabled) ?? []);
  const selectedModel = createMemo(() => models().find((model) => model.id === modelId().trim()));

  const save = async (): Promise<void> => {
    const cleanName = name().trim();
    const cleanProviderId = providerId().trim();
    const cleanModelId = modelId().trim();
    const cleanEffort = effort().trim();
    const tokens = optionalMaxOutput(maxTokens());
    if (cleanName === "") { toast("请填写存档名称", "err"); return; }
    if (cleanProviderId === "" || cleanModelId === "") { toast("请填写服务商 ID 和模型 ID", "err"); return; }
    if (tokens === undefined) {
      toast("最大输出必须是正整数，留空表示跟随模型默认", "err");
      return;
    }

    const saved = await saveProfile({
      name: cleanName,
      provider: cleanProviderId,
      model: cleanModelId,
      effort: cleanEffort === "" ? null : cleanEffort,
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
      <Field label="服务商" hint="选择已配置的服务商">
        <select class="field-input" aria-label="存档服务商" value={providerId()}
          onChange={(event) => { setProviderId(event.currentTarget.value); setModelId(""); setEffort(""); setMaxTokens(""); }}>
          <option value="">请选择服务商</option>
          <For each={providers()}>{(provider) => <option value={provider.id}>{provider.name}</option>}</For>
        </select>
      </Field>
      <Field label="模型" hint="选择该服务商目录中已启用的模型">
        <select class="field-input" aria-label="存档模型" value={modelId()}
          onChange={(event) => { setModelId(event.currentTarget.value); setEffort(""); setMaxTokens(""); }}>
          <option value="">请选择模型</option>
          <Show when={modelId() !== "" && selectedModel() == null}>
            <option value={modelId()} disabled>{modelId()}（不可用）</option>
          </Show>
          <For each={models()}>{(model) => <option value={model.id}>{model.definition.display_name ?? model.id}</option>}</For>
        </select>
      </Field>
      <Show when={selectedModel()}>
        {(model) => <p class="field-hint settings-row-wide">模型上下文窗口：{model().definition.context_window.toLocaleString()} tokens</p>}
      </Show>
      <Field label="推理强度" hint="留空 = 跟随模型默认">
        <select class="field-input" aria-label="存档推理强度" value={effort()}
          onChange={(event) => setEffort(event.currentTarget.value)}>
          <option value="">跟随模型默认</option>
          <Show when={effort() !== "" && !selectedModel()?.definition.reasoning_levels.includes(effort())}>
            <option value={effort()} disabled>{effort()}（未声明支持）</option>
          </Show>
          <For each={selectedModel()?.definition.capabilities.reasoning ? selectedModel()?.definition.reasoning_levels ?? [] : []}>
            {(level) => <option value={level}>{level}</option>}
          </For>
        </select>
      </Field>
      <Field label="最大输出 tokens" hint="留空 = 跟随模型默认">
        <TextInput type="number" value={maxTokens()} onInput={setMaxTokens} />
      </Field>
      <div class="wizard-actions">
        <button type="button" class="primary-mini button-primary" disabled={registryBusy()} onClick={() => void save()}>
          {registryBusy() ? "保存中…" : "创建存档"}
        </button>
      </div>
    </div>
  );
};

const ProfileRow: Component<{ profile: RegistryProfile; onCopy: () => void }> = (props) => {
  const issue = () => modelSelectionIssue(
    registry()?.providers.find((provider) => provider.id === props.profile.providerId)
      ?.models.find((model) => model.id === props.profile.model)?.definition,
    props.profile.effort, props.profile.maxTokens,
  );
  const remove = async (): Promise<void> => {
    if (props.profile.isDefault) return;
    if (await deleteProfile(props.profile.id)) toast("存档已删除", "ok");
  };
  const makeDefault = async (): Promise<void> => {
    if (await setDefaultProfile(props.profile.id)) toast(`已将「${props.profile.name}」设为默认模型`, "ok");
  };
  return (
    <div class={`profile-row profile-shortcut-row${props.profile.isDefault ? " active" : ""}`}>
      <span class="profile-name">
        <strong>{props.profile.name}</strong>
        <small class="provider-meta">{props.profile.model}</small>
        <small class="provider-meta">{props.profile.providerName} · {credentialLabel(props.profile.credential)}</small>
        <small class="provider-meta">
          {props.profile.effort ?? "跟随模型"} · 上下文 {props.profile.contextLength ?? "模型默认"} · 最大输出 {props.profile.maxTokens ?? "模型默认"}
        </small>
        <Show when={issue()}>{(message) => <small class="field-hint is-error">{message()}；可复制后修正。</small>}</Show>
      </span>
      <Show when={props.profile.isDefault}><span class="profile-active-tag">● 默认模型</span></Show>
      <button type="button" class="ghost-mini" disabled={registryBusy() || props.profile.isDefault || issue() != null} onClick={() => void makeDefault()}>设为默认</button>
      <button type="button" class="ghost-mini" disabled={registryBusy()} onClick={props.onCopy}>复制并修改</button>
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
  const [copying, setCopying] = createSignal<RegistryProfile | undefined>(undefined);
  const profiles = () => registry()?.profiles ?? [];
  return (
    <Section
      id="section-profiles"
      title="存档"
      desc="存档保存模型与参数组合。可复制后修改并设为全局默认；已有会话仍使用自己的存档与覆盖设置。"
    >
      <Show when={registryError()}>
        {(message) => <p class="field-hint is-error settings-row-wide">{message()}</p>}
      </Show>
      <Show when={registryLoading() && registry() == null}><p class="settings-muted settings-row-wide">读取中…</p></Show>
      <Show when={registry() != null && profiles().length === 0}>
        <p class="settings-muted settings-row-wide">还没有存档。请先到「服务商」添加并启用模型，再创建存档。</p>
      </Show>
      <div class="profile-list">
        <For each={profiles()}>{(profile) => <ProfileRow profile={profile} onCopy={() => { setCreating(false); setCopying(profile); }} />}</For>
      </div>
      <Show when={copying()}>{(profile) => <ProfileEditor initial={profile()} onClose={() => setCopying(undefined)} />}</Show>
      <Show when={creating()} fallback={
        <div class="settings-row-wide">
          <button type="button" class="ghost-mini provider-cta" disabled={registryBusy()} onClick={() => { setCopying(undefined); setCreating(true); }}>＋ 新建存档</button>
        </div>
      }>
        <ProfileEditor onClose={() => setCreating(false)} />
      </Show>
    </Section>
  );
};
