/**
 * 服务商页：列出 `profiles.toml` 里的全部 Provider（含暂时没被存档引用的）。
 *
 * - BYOK 行可展开编辑名称 / Base URL / wire / 密钥（留空保持、可单独清除）；
 * - 账号类（ChatGPT 套餐 / DeepSeek 账号）只读，登录与切换在侧栏「接入」页；
 * - 被存档引用的服务商不能删（后端权威，前端只提前禁用并说明）；
 * - 本页所有操作**即时写入**，不参与应用设置草稿。
 */
import { createSignal, For, Show, type Component } from "solid-js";
import IconEye from "~icons/lucide/eye";
import IconEyeOff from "~icons/lucide/eye-off";

import { toast } from "../ui/toast";
import { Select } from "../ui/Select";
import { Field, Section, TextInput } from "./controls";
import { MASK, WIRE_LABELS, WIRE_PROTOCOLS } from "./patch";
import {
  credentialLabel,
  deleteProvider,
  providerRows,
  registry,
  registryBusy,
  registryError,
  registryLoading,
  saveProvider,
  type RegistryProvider,
} from "./registry";

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
          该服务商被 {props.provider.referencedBy.length} 条存档引用，端点与密钥改动会同时影响它们。
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
  const account = (): boolean => props.provider.credential !== "api_key";
  const referenced = (): number => props.provider.referencedBy.length;

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
            {props.provider.apiKeySet ? "密钥已存" : "无密钥"}
          </small>
          <small class="provider-meta">
            {referenced() > 0 ? `被 ${referenced()} 条存档引用` : "未被引用"}
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
    </>
  );
};

export const ProvidersSection: Component<{
  onOpenProfiles: () => void;
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
      desc="服务商承载端点、协议与凭据；存档引用服务商并选择模型。改动即时写入 profiles.toml。"
    >
      <Show when={registryError() != null}>
        {(message) => <p class="field-hint is-error settings-row-wide">{message()}</p>}
      </Show>
      <Show when={registryLoading() && registry() == null}>
        <p class="settings-muted settings-row-wide">读取 profiles.toml…</p>
      </Show>
      <Show when={registry() != null && rows().length === 0}>
        <p class="settings-muted settings-row-wide">
          还没有服务商。创建第一条存档时会顺带创建服务商。
        </p>
      </Show>

      <div class="profile-list">
        <For each={rows()}>
          {(row) => <ProviderRow provider={row.provider} onOpenOAuth={props.onOpenOAuth} />}
        </For>
      </div>

      <div class="settings-row-wide">
        <button
          type="button"
          class="ghost-mini provider-cta"
          disabled={registryBusy()}
          onClick={props.onOpenProfiles}
        >
          ＋ 新建存档…
        </button>
      </div>
    </Section>
  );
};
