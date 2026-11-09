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
import { ByokProviderForm } from "../settings/ByokProviderForm";
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

  const signIn = (): void => {
    void run(route() === "account" ? connectAccount : connectPlan);
  };

  return (
    <div class="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div class="onboarding-panel">
        <header class="onboarding-head">
          <div>
            <h1 id="onboarding-title">开始使用 QAQ-Harness</h1>
            <p>添加服务商和模型，之后可在会话中选择。</p>
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
            <ByokProviderForm submitLabel="保存并开始" />
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
          <span class="onboarding-note">之后可在侧栏「接入」登录账号，或在「设置 → 服务商」管理端点、密钥与模型。</span>
        </footer>
      </div>
    </div>
  );
};
