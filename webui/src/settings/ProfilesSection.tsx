/**
 * 存档页：管理 `profiles.toml` 里的全部 Profile。
 *
 * 一条存档 = 服务商 + 模型 + 推理参数，会话通过稳定 id 引用它。页面上的每个
 * 操作（新建 / 编辑 / 设为默认 / 删除）都是命令直写、即时生效，和应用设置的
 * 「草稿 + 保存」完全分开；因此编辑存档不会丢掉未保存的应用设置。
 *
 * 新建时既可选已有服务商，也可顺手新建一个 BYOK 服务商；账号类服务商的登录
 * 在侧栏「接入」页，这里只负责为它挑模型。
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconEye from "~icons/lucide/eye";
import IconEyeOff from "~icons/lucide/eye-off";

import { fetchModelCatalog } from "../oauth/model-catalog";
import { REASONING_EFFORTS, WIRE_LABELS, WIRE_PROTOCOLS } from "./patch";
import { Field, Section, TextInput } from "./controls";
import { Select } from "../ui/Select";
import { toast } from "../ui/toast";
import {
  credentialLabel,
  deleteProfile,
  newId,
  registry,
  registryBusy,
  registryError,
  registryLoading,
  saveProfile,
  saveProvider,
  setDefaultProfile,
  type RegistryProfile,
} from "./registry";
import { fetchLiveModels } from "./registry/model-fetcher";
import { PROVIDER_TEMPLATES, type ModelOption } from "./registry/templates";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 空串 = 跟随模型默认；非法值返回 undefined。 */
const optionalPositive = (raw: string): number | null | undefined => {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const effortLabel = (effort: string | null): string => effort ?? "跟随模型";

const ProfileEditor: Component<{
  profile?: RegistryProfile;
  onClose: () => void;
}> = (props) => {
  const value = registry();
  const firstTemplate = PROVIDER_TEMPLATES[0]!;
  const currentProvider = props.profile == null
    ? value?.providers[0]
    : value?.providers.find((provider) => provider.id === props.profile!.providerId);

  const [name, setName] = createSignal(props.profile?.name ?? "");
  const [providerChoice, setProviderChoice] = createSignal(
    props.profile?.providerId ?? currentProvider?.id ?? "__new",
  );
  const [model, setModel] = createSignal(props.profile?.model ?? "");
  const [effort, setEffort] = createSignal(props.profile?.effort ?? "");
  const [contextLength, setContextLength] = createSignal(
    props.profile?.contextLength == null ? "" : String(props.profile.contextLength),
  );
  const [maxTokens, setMaxTokens] = createSignal(
    props.profile?.maxTokens == null ? "" : String(props.profile.maxTokens),
  );

  // 「新建服务商」分支的字段；切换 provider 选项时按模板重新预填。
  const [templateId, setTemplateId] = createSignal(firstTemplate.id);
  const [providerName, setProviderName] = createSignal(currentProvider?.name ?? firstTemplate.name);
  const [baseUrl, setBaseUrl] = createSignal(currentProvider?.baseUrl ?? firstTemplate.baseUrl);
  const [wire, setWire] = createSignal(currentProvider?.wire ?? firstTemplate.wire);
  const [apiKey, setApiKey] = createSignal("");
  const [showKey, setShowKey] = createSignal(false);

  const [liveModels, setLiveModels] = createSignal<ModelOption[]>([]);
  const [fetching, setFetching] = createSignal(false);
  const [fetchError, setFetchError] = createSignal<string | null>(null);

  const selectedProvider = createMemo(() =>
    value?.providers.find((provider) => provider.id === providerChoice()),
  );
  const isNewProvider = (): boolean => providerChoice() === "__new";
  const accountProvider = (): boolean => {
    const provider = selectedProvider();
    return provider != null && provider.credential !== "api_key";
  };

  const providerOptions = createMemo(() => [
    ...(value?.providers ?? []).map((provider) => ({
      value: provider.id,
      label: `${provider.name} · ${credentialLabel(provider.credential)}`,
    })),
    { value: "__new", label: "＋ 新建服务商…" },
  ]);

  const applyTemplate = (id: string): void => {
    const template = PROVIDER_TEMPLATES.find((item) => item.id === id);
    if (template == null) return;
    setTemplateId(id);
    setProviderName(template.name);
    setBaseUrl(template.baseUrl);
    setWire(template.wire);
    setContextLength(String(template.defaultContextLength));
    setMaxTokens(String(template.defaultMaxTokens));
    if (name().trim() === "") setName(template.name);
    setLiveModels([]);
    setFetchError(null);
  };

  const selectProvider = (id: string): void => {
    setProviderChoice(id);
    setLiveModels([]);
    setFetchError(null);
    if (id === "__new") {
      const template = PROVIDER_TEMPLATES.find((item) => item.id === templateId()) ?? firstTemplate;
      setProviderName(template.name);
      setBaseUrl(template.baseUrl);
      setWire(template.wire);
    }
  };

  const pullOnlineModels = async (): Promise<void> => {
    if (fetching()) return;
    setFetching(true);
    setFetchError(null);
    try {
      const provider = selectedProvider();
      if (provider != null && provider.credential !== "api_key") {
        const entries = await fetchModelCatalog(
          provider.credential === "chatgpt_plan" ? "plan" : "account",
        );
        if (entries.length === 0) {
          setFetchError("目录为空：先到「接入」页完成登录或刷新目录");
        } else {
          setLiveModels(entries.map((entry) => ({ id: entry.slug, label: entry.displayName ?? entry.slug })));
        }
        return;
      }
      const result = await fetchLiveModels({
        baseUrl: baseUrl(),
        wire: wire(),
        apiKey: apiKey().trim() === "" ? undefined : apiKey(),
      });
      if (result.ok && result.models.length > 0) {
        setLiveModels(result.models);
      } else {
        setFetchError(result.error ?? "未返回模型列表");
      }
    } catch (cause) {
      setFetchError(messageOf(cause));
    } finally {
      setFetching(false);
    }
  };

  const save = async (): Promise<void> => {
    const cleanName = name().trim();
    const modelId = model().trim();
    if (cleanName === "") {
      toast("请填写存档名称", "err");
      return;
    }
    if (modelId === "") {
      toast("请填写模型 id", "err");
      return;
    }
    const contexts = optionalPositive(contextLength());
    if (contexts === undefined) {
      toast("上下文窗口必须是大于 0 的整数（留空 = 跟随模型默认）", "err");
      return;
    }
    const tokens = optionalPositive(maxTokens());
    if (tokens === undefined) {
      toast("最大输出必须是大于 0 的整数（留空 = 跟随模型默认）", "err");
      return;
    }
    if (isNewProvider() && (providerName().trim() === "" || baseUrl().trim() === "")) {
      toast("新建服务商需要名称与 Base URL", "err");
      return;
    }

    const profileIds = (value?.profiles ?? []).map((profile) => profile.id);
    const providerIds = (value?.providers ?? []).map((provider) => provider.id);
    const profileId = props.profile?.id ?? newId(cleanName, profileIds);

    let providerId = providerChoice();
    if (isNewProvider()) {
      providerId = newId(`${profileId}-provider`, providerIds);
      const providerSaved = await saveProvider(providerId, {
        name: providerName(),
        baseUrl: baseUrl(),
        wire: wire(),
        credential: "api_key",
        ...(apiKey().trim() === "" ? {} : { apiKey: apiKey() }),
      });
      if (!providerSaved) return;
    }

    const saved = await saveProfile(
      {
        id: props.profile?.id,
        name: cleanName,
        provider: providerId,
        model: modelId,
        effort: effort() === "" ? null : effort(),
        contextLength: contexts,
        maxTokens: tokens,
      },
      { makeDefault: false },
    );
    if (saved != null) {
      toast("存档已保存", "ok");
      props.onClose();
    }
  };

  return (
    <div class="profile-wizard-card">
      <div class="provider-editor__head">
        <strong>{props.profile == null ? "新建存档" : `编辑存档 · ${props.profile.name}`}</strong>
        <button type="button" class="ghost-mini" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <Field label="存档名称" wide>
        <TextInput value={name()} onInput={setName} placeholder="例如：DeepSeek 深度推理" />
      </Field>

      <Field label="服务商">
        <Select
          value={providerChoice()}
          options={providerOptions()}
          onChange={selectProvider}
          ariaLabel="服务商"
        />
      </Field>

      <Show when={isNewProvider()}>
        <div class="settings-row-wide provider-template-chips">
          <For each={PROVIDER_TEMPLATES}>
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
            options={WIRE_PROTOCOLS.map((item) => ({
              value: item,
              label: WIRE_LABELS[item] ?? item,
            }))}
            onChange={setWire}
            ariaLabel="协议形态"
          />
        </Field>
        <Field label="API key" hint="留空 = 该服务商暂不存密钥（本地 Ollama 等）">
          <div class="secret-input">
            <TextInput
              type={showKey() ? "text" : "password"}
              value={apiKey()}
              placeholder="sk-..."
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
      </Show>

      <Field label="模型 id" wide>
        <div class="model-picker-row">
          <div class="model-picker-input">
            <TextInput
              value={model()}
              onInput={setModel}
              placeholder={
                isNewProvider()
                  ? (PROVIDER_TEMPLATES.find((item) => item.id === templateId())?.modelPlaceholder ??
                    "输入模型 id")
                  : "输入模型 id，或点击右侧探测"
              }
            />
          </div>
          <button
            type="button"
            class="ghost-mini"
            disabled={fetching() || (isNewProvider() && baseUrl().trim() === "")}
            onClick={() => void pullOnlineModels()}
          >
            {fetching() ? "同步中…" : accountProvider() ? "拉取目录" : "探测在线模型"}
          </button>
        </div>
        <Show when={fetchError()}>
          {(error) => <span class="field-hint is-error">探测提示：{error()}（可手动输入模型 id）</span>}
        </Show>
        <Show when={liveModels().length > 0}>
          <div class="model-preset-pills">
            <For each={liveModels()}>
              {(entry) => (
                <button
                  type="button"
                  class={`model-preset-pill${model() === entry.id ? " active" : ""}`}
                  onClick={() => {
                    setModel(entry.id);
                    if (entry.defaultEffort != null) setEffort(entry.defaultEffort);
                  }}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </Field>

      <Field label="推理档位" hint="留空跟随模型默认；后端会按端点 compat 再钳制">
        <Select
          value={effort()}
          options={[
            { value: "", label: "跟随模型默认" },
            ...REASONING_EFFORTS.map((tier) => ({ value: tier, label: tier })),
          ]}
          onChange={setEffort}
          ariaLabel="推理档位"
        />
      </Field>
      <Field label="上下文窗口" hint="留空跟随模型默认">
        <TextInput value={contextLength()} onInput={setContextLength} placeholder="例如 128000" />
      </Field>
      <Field label="最大输出" hint="留空跟随模型默认">
        <TextInput value={maxTokens()} onInput={setMaxTokens} placeholder="例如 8192" />
      </Field>

      <div class="wizard-actions">
        <button
          type="button"
          class="primary-mini button-primary"
          disabled={registryBusy()}
          onClick={() => void save()}
        >
          {registryBusy() ? "保存中…" : "保存存档"}
        </button>
        <button type="button" class="ghost-mini" onClick={props.onClose}>
          取消
        </button>
      </div>
    </div>
  );
};

const ProfileRow: Component<{
  profile: RegistryProfile;
  onEdit: () => void;
}> = (props) => {
  const remove = async (): Promise<void> => {
    if (props.profile.isDefault) return;
    const ok = await deleteProfile(props.profile.id);
    if (ok) toast("存档已删除", "ok");
  };

  const makeDefault = async (): Promise<void> => {
    const ok = await setDefaultProfile(props.profile.id);
    if (ok) toast(`已将「${props.profile.name}」设为默认存档`, "ok");
  };

  return (
    <div class={`profile-row${props.profile.isDefault ? " active" : ""}`}>
      <span class="profile-name">
        <strong>{props.profile.name}</strong>
        <small class="provider-meta">{props.profile.model}</small>
        <small class="provider-meta">
          {props.profile.providerName} · {credentialLabel(props.profile.credential)}
        </small>
        <small class="provider-meta">
          {effortLabel(props.profile.effort)} · 上下文{" "}
          {props.profile.contextLength ?? "模型默认"} · 最大输出{" "}
          {props.profile.maxTokens ?? "模型默认"}
        </small>
      </span>
      <Show when={props.profile.isDefault}>
        <span class="profile-active-tag">● 默认存档</span>
      </Show>
      <button type="button" class="ghost-mini" disabled={registryBusy()} onClick={props.onEdit}>
        编辑
      </button>
      <button
        type="button"
        class="ghost-mini"
        disabled={registryBusy() || props.profile.isDefault}
        onClick={() => void makeDefault()}
      >
        设为默认
      </button>
      <button
        type="button"
        class="ghost-mini is-danger"
        disabled={registryBusy() || props.profile.isDefault}
        title={props.profile.isDefault ? "默认存档不可删除，请先把别的存档设为默认" : undefined}
        onClick={() => void remove()}
      >
        删除
      </button>
    </div>
  );
};

export const ProfilesSection: Component = () => {
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);

  const profiles = () => registry()?.profiles ?? [];
  const editing = () => profiles().find((profile) => profile.id === editingId());

  return (
    <Section
      id="section-profiles"
      title="存档"
      desc="一条存档 = 服务商 + 模型 + 推理参数。会话选中存档后即可工作；改动即时写入 profiles.toml。"
    >
      <Show when={registryError() != null}>
        {(message) => <p class="field-hint is-error settings-row-wide">{message()}</p>}
      </Show>
      <Show when={registryLoading() && registry() == null}>
        <p class="settings-muted settings-row-wide">读取 profiles.toml…</p>
      </Show>
      <Show when={registry() != null && profiles().length === 0}>
        <p class="settings-muted settings-row-wide">
          还没有存档。创建第一条后会默认用于新会话；也可以到侧栏「接入」登录账号额度。
        </p>
      </Show>

      <div class="profile-list">
        <For each={profiles()}>
          {(profile) => (
            <>
              <ProfileRow
                profile={profile}
                onEdit={() => {
                  setCreating(false);
                  setEditingId(profile.id);
                }}
              />
              <Show when={editingId() === profile.id && editing() != null}>
                <ProfileEditor profile={editing()!} onClose={() => setEditingId(null)} />
              </Show>
            </>
          )}
        </For>
      </div>

      <Show
        when={creating()}
        fallback={
          <div class="settings-row-wide">
            <button
              type="button"
              class="ghost-mini provider-cta"
              disabled={registryBusy()}
              onClick={() => {
                setEditingId(null);
                setCreating(true);
              }}
            >
              ＋ 新建存档
            </button>
          </div>
        }
      >
        <ProfileEditor
          onClose={() => {
            setCreating(false);
          }}
        />
      </Show>
    </Section>
  );
};
