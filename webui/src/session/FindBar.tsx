/**
 * 转录页内查找(Ctrl+F)。桥接 Electron 原生 findInPage:高亮、滚动、计数全在
 * 浏览器进程做,万行时间线零 DOM 代价——这是「嵌入渲染层」相对 web 实现的
 * 白捡能力,JS 自建搜索(遍历 textContent + 包 <mark>)在大转录上必炸。
 *
 * 纯桌面特性:无壳(浏览器 dev/headless 夹具)时整条不渲染,不做半套 UI。
 * 键监听挂 capture 层:查找层压在抽屉/设置浮层之上,Esc 先关查找再轮到下层。
 */
import { createSignal, onCleanup, Show, type Component } from "solid-js";
import IconChevronUp from "~icons/lucide/chevron-up";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconX from "~icons/lucide/x";
import { desktopHost } from "../lib/desktop-host";

interface FoundInPage {
  activeMatchIndex: number;
  matchCount: number;
}

export const FindBar: Component = () => {
  const host = desktopHost();
  const bridge = host?.find;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [matchCase, setMatchCase] = createSignal(false);
  const [hits, setHits] = createSignal<FoundInPage | null>(null);
  let input: HTMLInputElement | undefined;
  let debounce: number | undefined;

  const off = host?.listen("app://found-in-page", (payload) => {
    setHits(payload as FoundInPage | null);
  });

  const run = (text: string, forward = true): void => {
    if (bridge == null) return;
    if (debounce !== undefined) window.clearTimeout(debounce);
    if (text === "") {
      setHits(null);
      void bridge.stop();
      return;
    }
    debounce = window.setTimeout(() => {
      void bridge.inPage(text, { forward, matchCase: matchCase() });
    }, 150);
  };

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setHits(null);
    if (debounce !== undefined) window.clearTimeout(debounce);
    void bridge?.stop();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      requestAnimationFrame(() => input?.select());
      return;
    }
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    off?.();
    if (debounce !== undefined) window.clearTimeout(debounce);
    void bridge?.stop();
  });

  return (
    <Show when={bridge != null && open()}>
      <div class="find-bar" role="search" aria-label="在转录中查找">
        <input
          ref={input}
          class="find-input"
          type="text"
          placeholder="查找转录…"
          aria-label="查找内容"
          value={query()}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            run(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              run(query(), !event.shiftKey);
            }
          }}
        />
        <span class="find-count" aria-live="polite">
          {query() === "" || hits() == null
            ? ""
            : hits()!.matchCount === 0
              ? "无匹配"
              : `${Math.max(hits()!.activeMatchIndex, 1)}/${hits()!.matchCount}`}
        </span>
        <button type="button" class="find-btn" title="上一个 (Shift+Enter)" onClick={() => run(query(), false)}>
          <IconChevronUp />
        </button>
        <button type="button" class="find-btn" title="下一个 (Enter)" onClick={() => run(query(), true)}>
          <IconChevronDown />
        </button>
        <button
          type="button"
          class={{ "find-btn": true, active: matchCase() }}
          title="区分大小写"
          aria-pressed={matchCase() ? "true" : "false"}
          onClick={() => {
            setMatchCase((value) => !value);
            run(query());
          }}
        >
          <span class="find-aa">Aa</span>
        </button>
        <button type="button" class="find-btn" title="关闭 (Esc)" onClick={close}>
          <IconX />
        </button>
      </div>
    </Show>
  );
};
