/**
 * 全屏首次引导：三条路 —— ChatGPT 套餐 / DeepSeek 账号 / 自带 API key。
 *
 * 配置落地后 `notifyConfigChanged` 会让 App 重新检查门，遮罩自己消失；这里不
 * 依赖路由或 toast。所有写入都走 `settings/registry` 的同一套命令，和设置页
 * 没有第二条路径。
 */
import { createSignal, For, Show, type Component } from "solid-js";

import { defaultDsSignInDeps, runDeepSeekSignIn } from "../lib/dsaccount";
import {
  openExternal,
  runSignInFlow,
  siwcSignInCancel,
  siwcSignInStart,
  siwcSignInStatus,
} from "../lib/siwc";
import { isDesktopRuntime } from "../lib/transport/backend";
import type { ModelDef } from "@qaqh/sdk/protocol";
import { Field, TextInput } from "../settings/controls";
import { Select } from "../ui/Select";
import { WIRE_LABELS, WIRE_PROTOCOLS } from "../settings/patch";
import {
  newId,
  refreshRegistry,
  registry,
  registryError,
  saveProfile,
  saveModel,
  saveProvider,
} from "../settings/registry";
import { fetchLiveModels } from "../settings/registry/model-fetcher";
import { PROVIDER_TEMPLATES } from "../settings/registry/templates";
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

  /** 账号登录不选择模型；完成后由用户在设置里填写。 */
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
    dismissOnboarding();
    props.onOpenSettings?.();
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
    dismissOnboarding();
    props.onOpenSettings?.();
  };

  /* ── BYOK ── */
  const firstTemplate = PROVIDER_TEMPLATES[0]!;
  const [templateId, setTemplateId] = createSignal(firstTemplate.id);
  const [providerName, setProviderName] = createSignal(firstTemplate.name);
  const [baseUrl, setBaseUrl] = createSignal(firstTemplate.baseUrl);
  const [wire, setWire] = createSignal(firstTemplate.wire);
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal("");
  const [contextLength, setContextLength] = createSignal("");
  const [maxTokens, setMaxTokens] = createSignal("");
  const [liveModels, setLiveModels] = createSignal<Array<{ id: string; label: string }>>([]);
  const [fetching, setFetching] = createSignal(false);

  const applyTemplate = (id: string): void => {
    const template = PROVIDER_TEMPLATES.find((item) => item.id === id);
    if (template == null) return;
    setTemplateId(id);
    setProviderName(template.name);
    setBaseUrl(template.baseUrl);
    setWire(template.wire);
    setContextLength("");
    setMaxTokens("");
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
    if (!Number.isSafeInteger(context) || context <= 0) {
      setError("上下文窗口必须是大于 0 的整数。");
      return;
    }
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      setError("最大输出必须是正整数。");
      return;
    }
    await refreshRegistry();
    const current = registry();
    const providerId = newId(
      `${name}-provider`,
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
    const modelDefinition: ModelDef = {
      enabled: true,
      display_name: liveModels().find((item) => item.id === modelId)?.label ?? null,
      context_window: context,
      max_output_tokens: tokens,
      reasoning_levels: [],
      capabilities: { tool_calls: false, image_input: false, native_web_search: false, reasoning: false },
      defaults: { max_output_tokens: tokens, native_web_search: false },
    };
    if (!await saveModel(providerId, modelId, modelDefinition)) {
      setError(registryError() ?? "保存模型目录失败");
      return;
    }
    const saved = await saveProfile(
      {
        name,
        provider: providerId,
        model: modelId,
        effort: null,
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
              登录会在系统浏览器中完成。登录后请在设置中填写模型 ID 与模型参数，再明确启用。
            </p>
            <div class="onboarding-actions">
              <button
                type="button"
                class="primary-mini button-primary"
                disabled={busy() || !available}
                onClick={signIn}
              >
                {busy() ? "等待授权…" : `登录${route() === "plan" ? " ChatGPT 套餐" : " DeepSeek 账号"}`}
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
                    placeholder="填写服务商提供的模型 ID"
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
            <Field label="上下文窗口" hint="按当前模型可用的上下文窗口手动填写">
              <TextInput type="number" value={contextLength()} onInput={setContextLength} />
            </Field>
            <Field label="最大输出" hint="手动填写端点支持的最大输出 tokens">
              <TextInput type="number" value={maxTokens()} onInput={setMaxTokens} />
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
