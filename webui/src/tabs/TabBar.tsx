/** Session switcher. Capacity follows its allocated region, not the outer window. */
import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import IconPlus from "~icons/lucide/plus";
import IconX from "~icons/lucide/x";
import IconMore from "~icons/lucide/more-horizontal";
import { STR } from "../lib/strings";
import type { SessionStore } from "../session/store";

type Tab = { id: string; seed: string; store: SessionStore };

const Dot: Component<{ store: SessionStore; active: boolean }> = (props) => {
  const kind = (): { cls: string; label: string } | null => {
    const activity = props.store.activity[0]();
    // 当前需要用户处理的状态优先于普通的新回复提示；历史失败轮次不代表 session 仍处于失败态。
    if (activity === "waiting_user" || props.store.pending[0]().length > 0) return { cls: "warn", label: STR.waitingYou };
    if (activity === "failed") {
      return { cls: "err", label: STR.error };
    }
    if (activity === "disconnected") return { cls: "off", label: STR.disconnected };
    if (activity === "working") return { cls: "run", label: STR.running };
    if (!props.active && props.store.hasNewReply[0]()) return { cls: "new", label: STR.hasNewReply };
    if (activity === "interrupted") return { cls: "paused", label: STR.interrupted };
    if (activity === "idle") return { cls: "done", label: STR.idle };
    return null;
  };
  return <Show when={kind()}>{(status) => (
    <span class={`tab-dot ${status().cls}`} role="img" aria-label={status().label} title={status().label}>
      <Show when={status().cls === "err"}>!</Show>
    </span>
  )}</Show>;
};

export const TabBar: Component<{
  tabs: Tab[];
  activeId: string | null;
  creating: boolean;
  canCreate: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
}> = (props) => {
  let moreButton: HTMLButtonElement | undefined;
  let capsule: HTMLDivElement | undefined;
  const tabRefs = new Map<string, HTMLButtonElement>();
  const menuSelectRefs = new Map<string, HTMLButtonElement>();
  const menuCloseRefs = new Map<string, HTMLButtonElement>();
  const [availableWidth, setAvailableWidth] = createSignal(0);
  const [recentIds, setRecentIds] = createSignal<string[]>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);

  createEffect(
    () => props.activeId,
    (id) => {
      if (id == null) return;
      setRecentIds((ids) => [id, ...ids.filter((item) => item !== id)].slice(0, 32));
    },
  );

  onSettled(() => {
    const region = capsule?.parentElement;
    if (region == null) return;
    const measure = (): void => {
      const style = getComputedStyle(region);
      setAvailableWidth(region.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    return () => observer.disconnect();
  });
  onSettled(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      const capsule = document.querySelector(".session-capsule");
      if (menuOpen() && capsule != null && target instanceof Node && !capsule.contains(target)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && menuOpen()) {
        setMenuOpen(false);
        moreButton?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  });

  const visibleTabs = (): Tab[] => {
    const all = props.tabs;
    const active = all.find((tab) => tab.id === props.activeId);
    if (availableWidth() < 400) return active == null ? [] : [active];
    const capsuleWidth = Math.min(760, availableWidth());
    const capacity = Math.max(1, Math.min(4, Math.floor((capsuleWidth - 130) / 126)));
    const recency = recentIds();
    const recent = [...all].sort((a, b) => recency.indexOf(a.id) - recency.indexOf(b.id));
    const selected = recent.slice(0, capacity);
    if (active != null && !selected.some((tab) => tab.id === active.id)) selected[selected.length - 1] = active;
    return selected;
  };

  const titleOf = (store: SessionStore): string => store.title[0]() ?? STR.newTab;
  const menuTabs = (): Tab[] => {
    const rank = (id: string): number => {
      const index = recentIds().indexOf(id);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...props.tabs].sort((a, b) => rank(a.id) - rank(b.id));
  };
  const focusTab = (id: string): void => {
    requestAnimationFrame(() => {
      const node = tabRefs.get(id);
      if (node != null) node.focus();
      else moreButton?.focus();
    });
  };
  const moveTabFocus = (event: KeyboardEvent, currentId: string): void => {
    const list = visibleTabs();
    const index = list.findIndex((tab) => tab.id === currentId);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % list.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    if (next < 0 || list[next] == null) return;
    event.preventDefault();
    tabRefs.get(list[next]!.id)?.focus();
  };
  const moveMenuFocus = (event: KeyboardEvent, id: string, close: boolean): void => {
    const list = menuTabs();
    const itemIndex = list.findIndex((tab) => tab.id === id);
    const currentIndex = itemIndex * 2 + (close ? 1 : 0);
    const nodes = list.flatMap((tab) => [menuSelectRefs.get(tab.id), menuCloseRefs.get(tab.id)]).filter((node): node is HTMLButtonElement => node != null);
    let next = -1;
    if (event.key === "ArrowDown") next = (currentIndex + 1) % nodes.length;
    else if (event.key === "ArrowUp") next = (currentIndex - 1 + nodes.length) % nodes.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = nodes.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      moreButton?.focus();
      return;
    }
    if (next < 0 || nodes[next] == null) return;
    event.preventDefault();
    nodes[next]!.focus();
  };
  const selectFromMenu = (id: string): void => {
    props.onSelect(id);
    setMenuOpen(false);
    focusTab(id);
  };
  const closeFromMenu = (id: string): void => {
    const wasActive = id === props.activeId;
    const index = props.tabs.findIndex((tab) => tab.id === id);
    const successor = wasActive ? props.tabs[index - 1] ?? props.tabs[index + 1] : null;
    props.onClose(id);
    setMenuOpen(false);
    if (wasActive && successor != null) focusTab(successor.id);
    else if (!wasActive && props.activeId != null) focusTab(props.activeId);
    else requestAnimationFrame(() => moreButton?.focus());
  };

  return (
    <div class="session-capsule" ref={capsule}>
      <div class="tab-scroll" role="tablist" aria-label="会话">
        <For each={visibleTabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              tabindex={tab.id === props.activeId ? 0 : -1}
              ref={(node) => tabRefs.set(tab.id, node)}
              class={{ tab: true, active: tab.id === props.activeId }}
              id={`tab-${tab.id}`}
              aria-controls={`panel-${tab.id}`}
              aria-selected={tab.id === props.activeId ? "true" : "false"}
              title={titleOf(tab.store)}
              onClick={() => props.onSelect(tab.id)}
              onKeyDown={(event) => moveTabFocus(event, tab.id)}
            >
              <Dot store={tab.store} active={tab.id === props.activeId} />
              <span class="tab-title">{titleOf(tab.store)}</span>
            </button>
          )}
        </For>
        <Show when={props.tabs.length > visibleTabs().length}>
          <div class="tab-overflow">
            <button
              type="button"
              class="tab-more"
              ref={(node) => { moreButton = node; }}
              aria-label={`更多会话（${props.tabs.length}）`}
              aria-haspopup="menu"
              aria-expanded={menuOpen() ? "true" : "false"}
              aria-controls="session-menu"
              onClick={() => {
                setMenuOpen(!menuOpen());
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setMenuOpen(true);
                  requestAnimationFrame(() => {
                    const first = menuTabs()[0];
                    if (first != null) menuSelectRefs.get(first.id)?.focus();
                  });
                }
                if (event.key === "Escape") setMenuOpen(false);
              }}
            >
              <IconMore /><span>更多</span>
            </button>
            <Show when={menuOpen()}>
              <div class="session-menu" id="session-menu" role="menu" aria-label="所有会话">
                <For each={menuTabs()}>
                  {(tab) => (
                    <div class={{ "session-menu-row": true, active: tab.id === props.activeId }}>
                      <button
                        type="button"
                        role="menuitem"
                        tabindex={-1}
                        ref={(node) => { menuSelectRefs.set(tab.id, node); }}
                        class="session-menu-select"
                        onClick={() => selectFromMenu(tab.id)}
                        onKeyDown={(event) => moveMenuFocus(event, tab.id, false)}
                      >
                        <Dot store={tab.store} active={tab.id === props.activeId} />
                        <span class="session-menu-title">{titleOf(tab.store)}</span>
                        <Show when={tab.id === props.activeId}><span class="session-menu-current">当前</span></Show>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        tabindex={-1}
                        ref={(node) => { menuCloseRefs.set(tab.id, node); }}
                        class="session-menu-close"
                        aria-label={`关闭 ${titleOf(tab.store)}`}
                        title="关闭会话"
                        onClick={() => closeFromMenu(tab.id)}
                        onKeyDown={(event) => moveMenuFocus(event, tab.id, true)}
                      >
                        <IconX />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <button
          type="button"
          class="tab-add"
          aria-label={STR.newTab}
          title={props.canCreate ? STR.newTab : STR.sendDisabledOffline}
          disabled={props.creating || !props.canCreate}
          onClick={props.onCreate}
        >
          <IconPlus />
        </button>
      </div>
    </div>
  );
};
