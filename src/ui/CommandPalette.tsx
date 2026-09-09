// CommandPalette：⌘K（spec §9）。历史会话唯一入口（无侧栏）。
// 数据源 session.list 全量（含 archived 分区）；fuzzy title/cwd/seed 前缀。
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Component } from "solid-js";
import { tabsStore } from "../state/tabs";

export interface PaletteEntry {
  seed: string;
  title: string;
  cwd: string;
  archived: boolean;
}

function fuzzy(hay: string, needle: string): boolean {
  if (!needle) return true;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i >= n.length) return true;
  }
  return false;
}

export const CommandPalette: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);

  // 全量数据由 App 注入 window 事件（palette 打开时 App 提供完整列表含 archived）
  const all = createMemo<PaletteEntry[]>(() => {
    // 从 TabsStore 取全部（含 archived）
    return tabsStore.order().map((seed) => {
      const t = tabsStore.tab(seed)!;
      return { seed, title: t.title, cwd: t.meta.cwd, archived: t.archived };
    });
  });

  const active = createMemo(() =>
    all()
      .filter((e) => !e.archived)
      .filter((e) => fuzzy(`${e.title} ${e.cwd} ${e.seed}`, query())),
  );
  const archived = createMemo(() =>
    all()
      .filter((e) => e.archived)
      .filter((e) => fuzzy(`${e.title} ${e.cwd} ${e.seed}`, query())),
  );

  const flat = createMemo(() => [...active(), ...archived()]);

  const choose = (seed: string) => {
    window.dispatchEvent(new CustomEvent("qaqh:activateTab", { detail: seed }));
    props.onClose();
  };

  const newSession = () => {
    window.dispatchEvent(new CustomEvent("qaqh:newSession"));
    props.onClose();
  };

  let inputEl: HTMLInputElement | undefined;

  onSettled(() => {
    inputEl?.focus();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, flat().length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // sel === active().length 且落在 archived 区首条时也支持
      const item = flat()[sel()];
      if (item) choose(item.seed);
      else if (sel() === active().length) newSession();
    }
  };

  return (
    <Show when={props.open}>
      <div class="palette-overlay" onClick={props.onClose}>
        <div class="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
          <input
            ref={inputEl}
            class="palette-input"
            placeholder="搜索会话（title / 路径 / seed）…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSel(0);
            }}
          />
          <div class="palette-list">
            <Show when={query().trim() === ""}>
              <button
                class={["palette-item", { sel: sel() === 0 }]}
                onClick={newSession}
                onMouseEnter={() => setSel(0)}
              >
                <span>＋</span>
                <span class="pi-title">新建会话</span>
                <span class="pi-sub">⌘N</span>
              </button>
            </Show>
            <Show when={active().length > 0}>
              <div class="palette-section">活跃会话</div>
              <For each={active()}>
                {(e, i) => {
                  const idx = i() + 1; // 0 = 新建会话
                  return (
                    <button
                      class={["palette-item", { sel: sel() === idx }]}
                      onClick={() => choose(e.seed)}
                      onMouseEnter={() => setSel(idx)}
                    >
                      <span class="pi-title">{e.title}</span>
                      <span class="pi-sub">{e.cwd || e.seed.slice(0, 8)}</span>
                    </button>
                  );
                }}
              </For>
            </Show>
            <Show when={archived().length > 0}>
              <div class="palette-section">已归档</div>
              <For each={archived()}>
                {(e, i) => {
                  const idx = active().length + 1 + i();
                  return (
                    <button
                      class={["palette-item", { sel: sel() === idx }]}
                      onClick={() => choose(e.seed)}
                      onMouseEnter={() => setSel(idx)}
                    >
                      <span class="pi-title">{e.title}</span>
                      <span class="pi-sub">{e.cwd || e.seed.slice(0, 8)}</span>
                    </button>
                  );
                }}
              </For>
            </Show>
            <Show when={flat().length === 0 && query().trim() !== ""}>
              <div class="palette-empty">无匹配会话 — Enter 新建</div>
            </Show>
          </div>
          <div class="palette-hint">
            <span>↑↓ 选择</span>
            <span>Enter 打开</span>
            <span>Esc 关闭</span>
          </div>
        </div>
      </div>
    </Show>
  );
};
