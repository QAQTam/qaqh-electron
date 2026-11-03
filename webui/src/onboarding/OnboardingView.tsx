/**
 * 全屏首次引导：三条路 —— ChatGPT 套餐 / DeepSeek 账号 / 自带 API key。
 *
 * 配置落地后 `notifyConfigChanged` 会让 App 重新检查门，遮罩自己消失；这里不
 * 依赖路由或 toast。所有写入都走 `settings/registry` 的同一套命令，和设置页
 * 没有第二条路径。
 */
import { createSignal, For, Show, type Component } from "solid-js";

import { defaultDsSignInDeps, dsaccountStatus, runDeepSeekSignIn } from "../lib/dsaccount";
import {
  openExternal,
  runSignInFlow,
  siwcSignInCancel,
  siwcSignInStart,
  siwcSignInStatus,
  siwcStatus,
} from "../lib/siwc";
import { isDesktopRuntime } from "../lib/transport/backend";
import { fetchModelCatalog } from "../oauth/model-catalog";
import { DSACCOUNT_CONTEXT_LENGTH, OAUTH_CONTEXT_LENGTH } from "../oauth/mode";
import { Field, TextInput } from "../settings/controls";
import { Select } from "../ui/Select";
import { WIRE_LABELS, WIRE_PROTOCOLS } from "../settings/patch";
import {
  ensureAccountProfile,
  newId,
  refreshRegistry,
  registry,
  registryError,
  saveProfile,
  saveProvider,
} from "../settings/registry";
import { fetchLiveModels } from "../settings/registry/model-fetcher";
import { PROVIDER_TEMPLATES } from "../settings/registry/templates";
import { siwcApiBase } from "../siwc/brand";
import { clearOnboardingError, dismissOnboarding } from "./state";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type Route = "plan" | "account" | "byok";

const ROUTES: ReadonlyArray<{ id: Route; title: string; blurb: string }> = [
  { id: "plan", title: "ChatGPT 套餐", blurb: "在系统浏览器里登录 ChatGPT，用套餐额度推理。" },
  { id: "account", title: "DeepSeek 账号", blurb: "登录 DeepSeek 账号，按平台余额计费。" },
  { id: "byok", title: "自带 API key", blurb: "任何兼容端点：填 Base URL、密钥与模型 id。" },
];

export const OnboardingView: Component<{ onOpenSettings?: () => void }> = (props) => {
  const available = isDesktopRuntime();
  const [route, setRoute] = createSignal<Route>("plan");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    clearOnboardingError();
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 登录后拉一次该账号目录，挑一个模型落成 Provider + 存档。 */
  const connectPlan = async (): Promise<void> => {
    if (!available) {
      setError("浏览器预览下不可用：请在桌面壳里完成首次设置。");
      return;
    }
    const outcome = await runSignInFlow(
      {},
      {
        start: siwcSignInStart,
        status: siwcSignInStatus,
        cancel: siwcSignInCancel,
        openExternal,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
    if (outcome.kind !== "completed") {
      if (outcome.kind === "failed") setError(outcome.message);
      return;
    }
    const status = await siwcStatus();
    const baseUrl = siwcApiBase(status);
    if (baseUrl == null) {
      setError("登录成功但没读到官方端点，请到「接入」页重试。");
      return;
    }
    const catalog = await fetchModelCatalog("plan");
    const model = catalog[0]?.slug;
    if (model == null) {
      setError("登录成功但模型目录为空，请到「接入」页刷新目录。");
      return;
    }
    const result = await ensureAccountProfile({
      kind: "plan",
      baseUrl,
      model,
      contextLength: OAUTH_CONTEXT_LENGTH,
      makeDefault: true,
    });
    if (result == null) setError(registryError() ?? "写入账号存档失败");
  };

  const connectAccount = async (): Promise<void> => {
    if (!available) {
      setError("浏览器预览下不可用：请在桌面壳里完成首次设置。");
      return;
    }
    const outcome = await runDeepSeekSignIn({}, defaultDsSignInDeps);
    if (outcome.kind !== "completed") {
      if (outcome.kind === "failed") setError(outcome.message);
      return;
    }
    const status = await dsaccountStatus();
    const baseUrl = status.inferenceOrigin;
    if (baseUrl == null || baseUrl === "") {
      setError("登录成功但没读到推理端点，请到「接入」页重试。");
      return;
    }
    const catalog = await fetchModelCatalog("account");
    const model = catalog[0]?.slug;
    if (model == null) {
      setError("登录成功但模型目录为空，请到「接入」页刷新目录。");
      return;
    }
    const result = await ensureAccountProfile({
      kind: "account",
      baseUrl,
      model,
      contextLength: DSACCOUNT_CONTEXT_LENGTH,
      makeDefault: true,
    });
    if (result == null) setError(registryError() ?? "写入账号存档失败");
  };

  /* ── BYOK ── */
  const firstTemplate = PROVIDER_TEMPLATES[0]!;
  const [templateId, setTemplateId] = createSignal(firstTemplate.id);
  const [providerName, setProviderName] = createSignal(firstTemplate.name);
  const [baseUrl, setBaseUrl] = createSignal(firstTemplate.baseUrl);
  const [wire, setWire] = createSignal(firstTemplate.wire);
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal("");
  const [contextLength, setContextLength] = createSignal(String(firstTemplate.defaultContextLength));
  const [maxTokens, setMaxTokens] = createSignal(String(firstTemplate.defaultMaxTokens));
  const [liveModels, setLiveModels] = createSignal<Array<{ id: string; label: string }>>([]);
  const [fetching, setFetching] = createSignal(false);

  const applyTemplate = (id: string): void => {
    const template = PROVIDER_TEMPLATES.find((item) => item.id === id);
    if (template == null) return;
    setTemplateId(id);
    setProviderName(template.name);
    setBaseUrl(template.baseUrl);
    setWire(template.wire);
    setContextLength(String(template.defaultContextLength));
    setMaxTokens(String(template.defaultMaxTokens));
    setLiveModels([]);
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
      if (model().trim() === "" && result.models[0] != null) setModel(result.models[0].id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setFetching(false);
    }
  };

  const saveByok = async (): Promise<void> => {
    const name = providerName().trim();
    const url = baseUrl().trim();
    const modelId = model().trim();
    if (name === "" || url === "" || modelId === "") {
      setError("服务商名称、Base URL 与模型 id 都必须填写。");
      return;
    }
    const context = Number(contextLength());
    const tokens = Number(maxTokens());
    if (!Number.isInteger(context) || context <= 0) {
      setError("上下文窗口必须是大于 0 的整数。");
      return;
    }
    if (!Number.isInteger(tokens) || tokens <= 0) {
      setError("最大输出必须是大于 0 的整数。");
      return;
    }
    await refreshRegistry();
    const current = registry();
    const profileId = newId(name, (current?.profiles ?? []).map((item) => item.id));
    const providerId = newId(
      `${profileId}-provider`,
      (current?.providers ?? []).map((item) => item.id),
    );
    const providerSaved = await saveProvider(providerId, {
      name,
      baseUrl: url,
      wire: wire(),
      credential: "api_key",
      ...(apiKey().trim() === "" ? {} : { apiKey: apiKey() }),
    });
    if (!providerSaved) {
      setError(registryError() ?? "保存服务商失败");
      return;
    }
    const saved = await saveProfile(
      {
        id: profileId,
        name,
        provider: providerId,
        model: modelId,
        effort: null,
        contextLength: context,
        maxTokens: tokens,
      },
      { makeDefault: true },
    );
    if (saved == null) setError(registryError() ?? "保存存档失败");
  };

  const signIn = (): void => {
    void run(route() === "account" ? connectAccount : connectPlan);
  };

  return (
    <div class="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div class="onboarding-panel">
        <header class="onboarding-head">
          <div>
            <h1 id="onboarding-title">开始使用 QAQ-Harness</h1>
            <p>选一条推理来源。配置会写进 profiles.toml，之后可随时在「设置 → 存档」改。</p>
          </div>
          <button type="button" class="ghost-mini" onClick={dismissOnboarding}>
            稍后设置
          </button>
        </header>

        <div class="onboarding-routes">
          <For each={ROUTES}>
            {(item) => (
              <button
                type="button"
                class={`onboarding-route${route() === item.id ? " active" : ""}`}
                aria-pressed={route() === item.id ? "true" : "false"}
                onClick={() => {
                  setRoute(item.id);
                  setError(null);
                }}
              >
                <strong>{item.title}</strong>
                <span>{item.blurb}</span>
              </button>
            )}
          </For>
        </div>

        <Show when={route() !== "byok"}>
          <div class="onboarding-body">
            <p class="onboarding-note">
              登录会在系统浏览器中完成。完成后会自动建立「{route() === "plan" ? "ChatGPT 套餐" : "DeepSeek 账号"}」
              服务商与存档，并设为默认。
            </p>
            <div class="onboarding-actions">
              <button
                type="button"
                class="primary-mini button-primary"
                disabled={busy() || !available}
                onClick={signIn}
              >
                {busy() ? "等待授权…" : `登录并启用${route() === "plan" ? " ChatGPT 套餐" : " DeepSeek 账号"}`}
              </button>
              <Show when={!available}>
                <span class="field-hint">浏览器预览下不可用，请在桌面壳里打开。</span>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={route() === "byok"}>
          <div class="onboarding-body onboarding-byok">
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
              <TextInput
                type="password"
                value={apiKey()}
                onInput={setApiKey}
                placeholder="sk-..."
                autocomplete="new-password"
              />
            </Field>
            <Field label="模型 id" wide>
              <div class="model-picker-row">
                <div class="model-picker-input">
                  <TextInput
                    value={model()}
                    onInput={setModel}
                    placeholder={
                      PROVIDER_TEMPLATES.find((item) => item.id === templateId())?.modelPlaceholder ??
                      "输入模型 id"
                    }
                  />
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
            <Field label="上下文窗口">
              <TextInput value={contextLength()} onInput={setContextLength} placeholder="128000" />
            </Field>
            <Field label="最大输出">
              <TextInput value={maxTokens()} onInput={setMaxTokens} placeholder="8192" />
            </Field>
            <div class="onboarding-actions">
              <button
                type="button"
                class="primary-mini button-primary"
                disabled={busy() || fetching()}
                onClick={() => void run(saveByok)}
              >
                {busy() ? "保存中…" : "保存并开始"}
              </button>
            </div>
          </div>
        </Show>

        <Show when={error() != null}>
          {(message) => <p class="onboarding-error" role="alert">{message()}</p>}
        </Show>

        <footer class="onboarding-foot">
          <Show when={props.onOpenSettings}>
            <button
              type="button"
              class="ghost-mini"
              onClick={() => {
                dismissOnboarding();
                props.onOpenSettings?.();
              }}
            >
              打开完整设置
            </button>
          </Show>
          <span class="onboarding-note">之后可在侧栏「接入」登录账号，或在「设置 → 存档」管理全部配置。</span>
        </footer>
      </div>
    </div>
  );
};
