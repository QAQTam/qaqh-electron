// Composer：输入 + plan/code 分段 + 附件 chips + 发送/停止（spec §9）。
// Enter 发送 / Shift+Enter 换行；发送后清空；命令发出后 UI 等事件驱动渲染。
import { For, Show, createSignal } from "solid-js";
import type { Component } from "solid-js";
import type { ContentRef } from "qaqh-js-sdk";
import { bridge } from "../lib/bridge";

export interface AttachmentChip {
  name: string;
  uploading: boolean;
  failed?: boolean;
  ref?: ContentRef;
}

export interface ComposerActions {
  send: (text: string, attachments: ContentRef[]) => void | Promise<void>;
  cancel: () => void;
  setMode: (mode: "plan" | "code") => void;
  pickAttachments: () => void;
  removeAttachment: (name: string) => void;
}

export const Composer: Component<{
  mode: "plan" | "code";
  busy: boolean;
  daemonDead: boolean;
  chips: AttachmentChip[];
  actions: ComposerActions;
}> = (props) => {
  const [text, setText] = createSignal("");
  const [sendErr, setSendErr] = createSignal(false);

  let inputEl: HTMLTextAreaElement | undefined;

  const canSend = () => text().trim().length > 0 && !props.busy && !props.daemonDead;

  const doSend = () => {
    if (!canSend()) return;
    const refs = props.chips.filter((c) => c.ref).map((c) => c.ref!);
    const outcome = props.actions.send(text(), refs);
    // 同步/异步失败都保留内容 + 红边（spec §11：发送网络失败，输入框内容保留）
    const finish = () => {
      setText("");
      setSendErr(false);
      if (inputEl) inputEl.style.height = "auto";
    };
    if (outcome && typeof (outcome as Promise<void>).then === "function") {
      void (outcome as Promise<void>).then(finish, () => setSendErr(true));
    } else {
      finish();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const hasBridge = Boolean(bridge());

  return (
    <div class="composer">
      <Show when={props.chips.length > 0}>
        <div class="attach-chips">
          <For each={props.chips}>
            {(c) => (
              <span
                class={["attach-chip", { uploading: c.uploading, failed: Boolean(c.failed) }]}
                title={c.failed ? "上传失败" : c.name}
              >
                <span class="chip-name">{c.name}</span>
                <Show when={c.uploading}>
                  <span>…</span>
                </Show>
                <button class="chip-x" onClick={() => props.actions.removeAttachment(c.name)}>
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={inputEl}
        class={["composer-input", { "send-error": sendErr() }]}
        rows="1"
        placeholder={
          props.daemonDead
            ? "daemon 已退出 — 状态线可重新拉起"
            : props.mode === "plan"
              ? "计划模式：描述要规划的任务…"
              : "输入消息，Enter 发送，Shift+Enter 换行…"
        }
        value={text()}
        disabled={props.daemonDead}
        onInput={(e) => {
          setText(e.currentTarget.value);
          autoGrow(e.currentTarget);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="composer-toolbar">
        <button
          class={{
            on: props.mode === "plan",
          }}
          style={{
            "font-size": "11px",
            padding: "2px 8px",
            "border-radius": "var(--radius-ctl)",
            border: "1px solid",
            "border-color": props.mode === "plan" ? "var(--accent)" : "var(--border)",
            color: props.mode === "plan" ? "var(--accent-strong)" : "var(--text-3)",
            background: props.mode === "plan" ? "var(--accent-soft)" : "var(--bg)",
          }}
          onClick={() => props.actions.setMode(props.mode === "plan" ? "code" : "plan")}
          title="切换 plan/code"
        >
          {props.mode === "plan" ? "PLAN" : "CODE"}
        </button>
        <Show when={hasBridge}>
          <button class="icon-btn" title="附加文件" onClick={() => props.actions.pickAttachments()}>
            📎
          </button>
        </Show>
        <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
        <div class="composer-actions">
          <Show
            when={props.busy}
            fallback={
              <button class="send-btn" disabled={!canSend()} onClick={doSend}>
                发送
              </button>
            }
          >
            <button class="send-btn stop" onClick={() => props.actions.cancel()}>
              停止
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};
