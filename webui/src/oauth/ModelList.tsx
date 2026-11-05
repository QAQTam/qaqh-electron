import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { modelOptions, type ModelEntry } from "./model-catalog";

/** Account discovery is the normal path; a custom ID remains an explicit fallback. */
export const ModelList: Component<{
  active: boolean;
  providerName: string;
  model: string | null;
  models: ModelEntry[] | null;
  signedIn: boolean;
  busy: boolean;
  refreshing: boolean;
  error: string | null;
  onReload: () => void;
  onPick: (slug: string) => void;
}> = (props) => {
  const [modelId, setModelId] = createSignal("");
  const entries = createMemo(() => modelOptions(props.models ?? []));
  return (
    <div class="oauth-models">
      <div class="oauth-models__head">
        <span class="oauth-models__title">{props.providerName} 可用模型</span>
        <button type="button" class="ghost-mini" disabled={props.busy || !props.signedIn}
          onClick={props.onReload}>{props.refreshing ? "刷新中…" : "刷新模型目录"}</button>
      </div>
      <Show when={props.model}>
        <p class="oauth-models__note">{props.active ? "全局默认模型" : "已保存的模型"}：{props.model}</p>
      </Show>
      <Show when={props.signedIn} fallback={<p class="oauth-models__note">登录后自动获取此账号的可用模型。</p>}>
        <Show when={entries().length > 0} fallback={
          <p class="oauth-models__empty" role="status">
            {props.refreshing ? "正在获取模型目录…" : props.error != null ? "模型目录获取失败，请重试。"
              : props.models == null ? "尚未获取模型目录，请刷新。" : "此账号返回的模型目录为空。"}
          </p>
        }>
          <div class="oauth-models__list" role="group" aria-label={`${props.providerName} 可用模型`}>
            <For each={entries()}>{(entry) => (
              <button type="button" disabled={props.busy}
                class={props.active && entry.slug === props.model ? "selected" : undefined}
                aria-pressed={props.active && entry.slug === props.model ? "true" : "false"}
                onClick={() => props.onPick(entry.slug)}>
                <span>{entry.displayName}</span><small>{entry.slug}</small>
              </button>
            )}</For>
          </div>
        </Show>
        <Show when={props.models != null && props.model != null && !entries().some((entry) => entry.slug === props.model)}>
          <p class="oauth-models__note oauth-models__unknown">已保存的模型不在最新目录中，请确认或选择其他模型。</p>
        </Show>
        <p class="oauth-models__note oauth-models__note--muted">选择后添加到服务商目录，可在会话中使用。</p>
        <details>
          <summary>手动填写模型 ID</summary>
          <div class="model-picker-row">
            <input class="field-input" aria-label={`${props.providerName} 模型 ID`}
              placeholder="填写自定义模型 ID" value={modelId()}
              onInput={(event) => setModelId(event.currentTarget.value)} />
            <button type="button" class="ghost-mini" disabled={props.busy || modelId().trim() === ""}
              onClick={() => props.onPick(modelId().trim())}>添加模型</button>
          </div>
        </details>
      </Show>
      <Show when={props.error}><p class="oauth-models__note is-error" role="alert">{props.error}</p></Show>
    </div>
  );
};
