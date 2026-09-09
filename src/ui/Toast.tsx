// Toast 通知（命令 rejected 等错误提示，spec §11）。
import { createSignal, For } from "solid-js";
import type { Component } from "solid-js";

interface ToastItem {
  id: number;
  text: string;
  error: boolean;
}

const [toasts, setToasts] = createSignal<ToastItem[]>([]);
let nextId = 1;

export function pushToast(text: string, error = false): void {
  const id = nextId++;
  setToasts((t) => [...t, { id, text, error }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
}

export const ToastStack: Component = () => (
  <div class="toast-stack">
    <For each={toasts()}>{(t) => <div class={["toast", { error: t.error }]}>{t.text}</div>}</For>
  </div>
);
