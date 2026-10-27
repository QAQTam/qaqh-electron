/**
 * 会话消息区(spec §7.6/§14):内容列 760px 居中;距底 ≤80px 跟随,
 * 上滚停随 + 「回到底部」;触顶(scrollTop < 1.5×视口)向上翻页并做滚动补偿;
 * 窗口淘汰把视口上方 2 屏外的旧回合替换为等高占位。
 *
 * 渲染纪律:回合槽按稳定 key 挂载。快照重对齐(attach/缺口校正)现在认得出同一个
 * 回合并保住原对象(见 reducer 的 `installTurns`),但 keying 仍然是必需的:
 * 内容真变了(权威更正、翻页前插)时那个回合会被换成新对象,不按 key 认行的话
 * 整屏回合会连 DOM 与滚动位置一起丢掉(实测一次重对齐重挂 1.7 万个节点)。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Component } from "solid-js";
import IconArrowDown from "~icons/lucide/arrow-down";
import { TurnView } from "../turn/TurnView";
import { anchorScrollTop, clampPlaceholderHeight, EVICT_SCREENS, shouldLoadOlder, TURN_WINDOW } from "../session/pagination";
import { STR } from "../lib/strings";
import { SessionHeader } from "./SessionHeader";
import type { SessionStore, CompactState } from "../session/store";
import { gapHeight, type Slot, type Wait } from "../session/types";
import type { Tab } from "../tabs/store";

/** 「保留 N/M 回合」进度;没有过程事件(未镜像进 v2)时为空串,卡片退化为纯状态。 */
function compactProgress(state: CompactState): string {
  if (state.phase !== "running" || state.turnsTotal == null) return "";
  return STR.compactProgress(state.turnsKeeping ?? 0, state.turnsTotal);
}

/** 终态补充信息:合并了几个回合、摘要多少字。 */
function compactMeta(state: CompactState): string {
  if (state.phase !== "done") return "";
  const parts: string[] = [];
  if (state.turnsRemoved != null) parts.push(STR.compactTurnsRemoved(state.turnsRemoved));
  if (state.summaryChars != null) parts.push(STR.compactSummaryChars(state.summaryChars));
  return parts.join(" · ");
}

/**
 * 终态原因(失败/跳过/取消):后端 `CompactFinished.reason` 的中文整句,原样展示。
 * 标题仍用状态词(`压缩失败`),原因作为第二行补充——成功终态没有原因。
 */
function compactReason(state: CompactState): string {
  return state.phase === "failed" || state.phase === "skipped" ? state.reason ?? "" : "";
}

export const SessionView: Component<{ tab: Tab }> = (props) => {
  let scroller: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(true);
  const [unseen, setUnseen] = createSignal(false);
  const [activeNavKey, setActiveNavKey] = createSignal<string | null>(null);
  const [hoveredNavKey, setHoveredNavKey] = createSignal<string | null>(null);
  const store = props.tab.store;
  const state = () => store.state[0];
  /** 压缩卡片只在非 idle 时渲染;`Show` 的回调因此能拿到收窄后的联合类型。 */
  const compactCard = () => {
    const current = store.compact[0]();
    return current.phase === "idle" ? null : current;
  };
  const slots = createMemo(() => {
    state().structureVersion;
    // keying 只读普通结构快照,避免 For 订阅 50 个 store 槽位的 100+ 叶子。
    return untrack(() => state().slots.map((slot): Slot => slot.kind === "turn"
      ? { kind: "turn", key: slot.key }
      : { kind: "gap", key: slot.key, spans: slot.spans }));
  }, { name: "session.slots" });
  const slotTable = createMemo(() => new Map(slots().map((slot) => [slot.key, slot])), { name: "session.slotTable" });
  // 原型导航只列出当前窗口里仍有完整内容的用户回合。摘要是本地截断文本，
  // 不触发额外请求；被窗口淘汰的轮次会从导航中消失，完整历史目录留待后端轻量接口。
  const navItems = createMemo(() => {
    const current = slots();
    return untrack(() => current.flatMap((slot) => {
      if (slot.kind !== "turn") return [];
      const turn = state().turns[slot.key];
      if (turn == null) return [];
      return [{
        key: turn.key,
        index: turn.turnIndex,
        question: turn.user.text,
      }];
    }));
  }, { name: "session.turnNavigator" });
  createEffect(() => navItems(), (items) => {
    if (activeNavKey() == null && items.length > 0) setActiveNavKey(items[items.length - 1]!.key);
    else if (activeNavKey() != null && !items.some((item) => item.key === activeNavKey())) {
      setActiveNavKey(items[items.length - 1]?.key ?? null);
    }
  });
  const hoverNavItem = createMemo(() => {
    const key = hoveredNavKey();
    return key == null ? null : state().turns[key] ?? null;
  });
  const excerpt = (value: string | undefined): string => (value ?? "").slice(0, 512).replace(/\s+/g, " ").trim().slice(0, 180);
  const answerExcerpt = (turn: NonNullable<ReturnType<typeof hoverNavItem>>): string => {
    if (turn.answer?.text) return excerpt(turn.answer.text);
    for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
      const step = turn.steps[index];
      if (step?.kind === "text" && step.text.length > 0) return excerpt(step.text);
    }
    return "尚无回复摘录";
  };
  const buckets = new Map<string, string>();
  let nextLocalBucket = 0;
  const slotGroups = createMemo(() => {
    const current = slots();
    return untrack(() => {
      const live = new Set(current.map((slot) => slot.key));
      for (const key of buckets.keys()) if (!live.has(key)) buckets.delete(key);
      const groups: Array<{ key: string; keys: string[] }> = [];
      for (const slot of current) {
        let bucket = buckets.get(slot.key);
        if (bucket == null) {
          const index = state().turns[slot.key]?.turnIndex;
          bucket = slot.kind === "gap" ? slot.key : index != null ? `page:${Math.floor(index / 8)}` : `local:${Math.floor(nextLocalBucket++ / 8)}`;
          buckets.set(slot.key, bucket);
        }
        let group = groups[groups.length - 1];
        if (group?.key !== bucket) { group = { key: bucket, keys: [] }; groups.push(group); }
        group.keys.push(slot.key);
      }
      return groups;
    });
  }, { name: "session.groups" });
  let anchoring = false;
  /**
   * 用户是否真的动过滚动区。首屏的 scroll 事件(滚动位置恢复、布局定高后的夹取)
   * 不代表用户意图,拿它判定会把「跟随尾部」在内容到达前就关掉——实测表现就是
   * 启动后停在最早的消息上,且之后再也不跟随。
   */
  let userScrolled = false;
  let userScrollVersion = 0;
  const markUserScrolled = (): void => {
    userScrolled = true;
    userScrollVersion += 1;
  };
  /**
   * 我们自己写 scrollTop 也会触发 scroll 事件——那次要吞掉,不能当成「用户离开了
   * 底部」,否则贴底时被浏览器夹住(见 pinTail)就会永久失去自动跟随。
   * 一次写入对应一次事件,用完即复位;写入没产生事件(位置已到位)时最多让用户的
   * 下一个滚轮事件被忽略一次,随后的事件照常生效。
   */
  let swallowScroll = false;

  const nearBottom = (): boolean => {
    if (scroller == null) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  };

  const onScroll = (): void => {
    if (scroller == null) return;
    if (swallowScroll) {
      swallowScroll = false;
      return;
    }
    if (!userScrolled) return;
    setPinned(nearBottom());
    const nav = navItems();
    let active: string | null = nav[0]?.key ?? null;
    const anchor = scroller.scrollTop + Math.min(96, scroller.clientHeight * 0.16);
    for (const item of nav) {
      const node = scroller.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(item.key)}"]`);
      const top = node == null ? undefined : node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      if (top == null || top > anchor) break;
      active = item.key;
    }
    setActiveNavKey(active);
    if (nearBottom()) setUnseen(false);
    if (shouldLoadOlder(scroller.scrollTop, scroller.clientHeight, state().hasMore, store.loadingOlder[0]())) {
      void loadOlder();
    } else if (state().slots.length > TURN_WINDOW) {
      // 淘汰也得由滚动触发:原先只在 slots 长度变化时 refit,于是「翻页读历史 → 再滚回
      // 底部」这条路上,视口上方的回合永远出不了窗口(压力实测:窗口 50,常驻 170 回合、
      // 7.2M 字符)。queueRefit 自带合并与 requestIdleCallback,不给滚动加同步布局。
      queueRefit();
    }
  };

  /**
   * 窗口淘汰(spec §14.1):先量已渲染回合的高度,再把视口上方 2 屏外的最旧回合
   * 换成等高占位并释放回合数据。布局读写放在帧外,避开 Solid flush 期的强制 reflow。
   */
  const refit = (): void => {
    const el = scroller;
    if (el == null) return;
    const measured = new Map<string, number>();
    for (const node of el.querySelectorAll<HTMLElement>("[data-slot-key]")) {
      measured.set(node.dataset.slotKey ?? "", node.offsetHeight);
    }
    const evicted = store.evictOutOfView(
      TURN_WINDOW,
      EVICT_SCREENS,
      (key) => el.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(key)}"]`)?.offsetTop ?? null,
      el.scrollTop,
      el.clientHeight,
    );
    if (evicted.length > 0) {
      // 一次写回整段:逐个 key 写会通知每个下标节点,正是这次改动要消掉的开销。
      const filled: Array<[string, number]> = evicted.map((key) => [key, clampPlaceholderHeight(measured.get(key) ?? 0, el.clientHeight)]);
      store.setPlaceholderHeights(filled);
    }
    // 占位与真实回合的高度不可能完全相等(钳到 2 屏 + 边距差),淘汰后视口会离底
    // 几百到几千像素。用户本来就停在底部时,要把底部重新贴住。
    if (evicted.length > 0 && pinned() && !anchoring) pinTail();
  };

  let refitQueued = false;
  const queueRefit = (): void => {
    if (refitQueued) return;
    refitQueued = true;
    const run = (): void => {
      refitQueued = false;
      refit();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1_000 });
    else setTimeout(run, 200);
  };

  const loadOlder = async (): Promise<void> => {
    const el = scroller;
    if (el == null) return;
    const prevTop = el.scrollTop;
    const prevHeight = el.scrollHeight;
    const inputVersion = userScrollVersion;
    const loaded = await store.loadOlder();
    if (!loaded || scroller == null) return;
    refit();
    // 请求期间用户可能继续滚动或反向滚动。此时不能用请求开始时的 prevTop
    // 覆盖最新意图；#messages 保留浏览器原生 scroll anchoring 来承接顶部前插。
    if (userScrollVersion !== inputVersion) return;
    anchoring = true;
    requestAnimationFrame(() => {
      if (scroller == null) return;
      scroller.scrollTop = anchorScrollTop(prevTop, prevHeight, scroller.scrollHeight);
      requestAnimationFrame(() => {
        anchoring = false;
      });
    });
  };

  // 跟随尾部(spec §7.6):停在底部时新内容自动跟随;上滚后停随并标记未读。
  //
  // 由**数据**驱动,不用 MutationObserver 观察整棵子树:观察器在大文档上每帧要处理
  // 成百上千条记录,其中还混着「展开/收起」这类不该跟随的变更;真正该跟随的只有
  // 槽位增加与尾部回合可见文本变长。布局读写一律放到帧里——首屏时元素还没插进
  // 文档,同步 scrollTo 会落空(实测启动后停在顶部)。
  const tailVisibleChars = createMemo(() => {
    const slots = state().slots;
    const last = slots.length > 0 ? slots[slots.length - 1] : null;
    if (last == null || last.kind !== "turn") return 0;
    const turn = state().turns[last.key];
    if (turn == null) return 0;
    return turn.renderVersion ?? 0;
  });

  // 新回合入场后文档还会继续变高(Markdown 限频绘制、离屏回合的真实高度逐帧替换
  // 估算值),单帧定位会停在半空——实测快照到达后距底还有 2.5k px,「回到底部」按钮
  // 会无端冒出来。因此定位要跑到贴住底部为止(连续两帧 rest ≤ 80 即停,上限 30 帧)。
  let pinHandle: number | null = null;
  const pinTail = (): void => {
    if (pinHandle != null) cancelAnimationFrame(pinHandle);
    let stable = 0;
    let budget = 30;
    let lastHeight = -1;
    const step = (): void => {
      pinHandle = null;
      const el = scroller;
      // 逐帧重读**最新**的跟随意图:这是 rAF 回调,建订阅没有意义(也读不到),
      // 所以显式 untrack —— 语义就是「每帧自己再看一次」。
      const follow = untrack(() => pinned() && !store.loadingOlder[0]());
      if (el == null || !follow || anchoring) return;
      // .turn 带 content-visibility: auto,离屏回合按估算高度计入滚动范围,一次
      // `scrollTop = scrollHeight` 会被夹在还没展开的位置(实测首屏离底 2.5k px)。
      // 每帧重写一次:滚动范围随回合真正布局而展开,贴住底部(或 30 帧预算)后停。
      swallowScroll = true;
      el.scrollTop = el.scrollHeight;
      const rest = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 高度还在长就不算「稳」:Markdown 的匀速 reveal 会在最后一次数据写入之后
      // 继续撑高 DOM 好几帧,只看 rest 会提前收工,表现就是停会后离底还有几百 px。
      stable = rest <= 80 && el.scrollHeight === lastHeight ? stable + 1 : 0;
      lastHeight = el.scrollHeight;
      budget -= 1;
      if (stable < 2 && budget > 0) pinHandle = requestAnimationFrame(step);
    };
    pinHandle = requestAnimationFrame(step);
  };
  onCleanup(() => {
    if (pinHandle != null) cancelAnimationFrame(pinHandle);
  });

  createEffect(
    () => [state().slots.length, tailVisibleChars(), pinned()] as const,
    ([count, chars, follow], prev) => {
      if (count === 0) return;
      const newSlots = prev === undefined || count > prev[0];
      const grewTail = prev !== undefined && chars > prev[1];
      if (!newSlots && !grewTail) return;
      if (!follow) {
        if (prev !== undefined) setUnseen(true);
        return;
      }
      pinTail();
    },
  );

  // 回合数变化(翻页/新回合)→ 帧外重排窗口;窗口内不测量布局。
  createEffect(
    () => state().slots.length,
    (count) => {
      if (count > TURN_WINDOW) queueRefit();
    },
  );

  return (
    <div id="session">
      <SessionHeader tab={props.tab} />
      <div
        id="messages"
        ref={scroller}
        onScroll={onScroll}
        onWheel={markUserScrolled}
        onTouchMove={markUserScrolled}
        onPointerDown={markUserScrolled}
        onKeyDown={markUserScrolled}
      >
        <Show when={state().truncatedBefore}>
          <div class="history-note">{STR.truncatedWindow}</div>
        </Show>
        <Show when={store.loadError[0]()}>
          <button type="button" class="history-note retry" onClick={() => void loadOlder()}>
            {STR.loadFailedRetry}
          </button>
        </Show>
        <Show when={store.compactedAfter[0]() != null && !state().slots.some((slot) => slot.key === store.compactedAfter[0]())}>
          <div class="compact-divider" role="separator"><span>{STR.compactedAbove}</span></div>
        </Show>
        <For each={slotGroups()} keyed={(group) => group.key}>
          {(group) => <div class="session-group"><For each={group().keys}>{(key) => (
            <Show when={slotTable().get(key)?.kind === "turn"} fallback={<>
              <GapRow slot={slotTable().get(key) ?? { kind: "gap", key, spans: [] }} />
              {/* 锚点落在占位段(压缩前旧回合已被窗口淘汰)时,分隔线画在占位段
                  下方、真实尾部回合上方,而不是退回整列顶部。 */}
              <Show when={store.compactedAfter[0]() === key}>
                <div class="compact-divider" role="separator"><span>{STR.compactedAbove}</span></div>
              </Show>
            </>}>
              <TurnSlot store={store} slotKey={key} />
            </Show>
          )}</For></div>}
        </For>
      </div>
      <Show when={compactCard()}>
        {(compact) => {
          // JSX 里的条件不会收窄联合类型,这几处显式收窄后再给 Show 用。
          const headline = (): string => {
            const current = compact();
            if (current.phase === "running") return STR.compacting;
            if (current.phase === "failed") return STR.compactFailed;
            if (current.phase === "skipped") {
              return current.status === "cancelled" ? STR.compactCancelled : STR.compactSkipped;
            }
            return STR.compacted;
          };
          const summary = (): string => {
            const current = compact();
            return current.phase === "running" ? current.summary : "";
          };
          return (
            <div class={`compact-card ${compact().phase}`} role="status" aria-live="polite">
              <div class="compact-card-head">
                <span class="compact-card-mark" aria-hidden="true" />
                <strong>{headline()}</strong>
                <Show when={compactProgress(compact())}>
                  <span class="compact-card-progress">{compactProgress(compact())}</span>
                </Show>
                <Show when={compactMeta(compact())}>
                  <span class="compact-card-progress">{compactMeta(compact())}</span>
                </Show>
              </div>
              <Show when={compactReason(compact()) !== ""}>
                <p class="compact-card-reason">{compactReason(compact())}</p>
              </Show>
              <Show when={summary() !== ""}>
                <pre class="compact-card-summary">{summary()}</pre>
              </Show>
            </div>
          );
        }}
      </Show>
      <Show when={navItems().length > 1}>
        <nav class="turn-navigator" aria-label="当前已加载的用户消息">
          <For each={navItems()} keyed={(item) => item.key}>{(item, index) => (
            <button
              type="button"
              class={{ "turn-navigator-tick": true, active: activeNavKey() === item().key }}
              aria-label={`跳转到第 ${(item().index ?? index()) + 1} 条用户消息：${excerpt(item().question)}`}
              aria-current={activeNavKey() === item().key ? "location" : undefined}
              onMouseEnter={() => setHoveredNavKey(item().key)}
              onMouseLeave={() => setHoveredNavKey((key) => key === item().key ? null : key)}
              onFocus={() => setHoveredNavKey(item().key)}
              onBlur={() => setHoveredNavKey((key) => key === item().key ? null : key)}
              onClick={() => {
                const target = scroller?.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(item().key)}"]`);
                if (target == null) return;
                markUserScrolled();
                setActiveNavKey(item().key);
                target.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <span class="turn-navigator-mark" />
              <Show when={hoveredNavKey() === item().key && hoverNavItem()}>
                {(turn) => <span class="turn-navigator-card" role="tooltip">
                  <span class="turn-navigator-question">{excerpt(turn().user.text) || "（空消息）"}</span>
                  <span class="turn-navigator-answer">{answerExcerpt(turn())}</span>
                </span>}
              </Show>
            </button>
          )}</For>
        </nav>
      </Show>
      <Show when={!pinned() && unseen()}>
        <button
          type="button"
          class="back-bottom"
          onClick={() => {
            setPinned(true);
            setUnseen(false);
            scroller?.scrollTo({ top: scroller.scrollHeight });
          }}
        >
          <IconArrowDown />
          {STR.backToBottom}
        </button>
      </Show>
    </div>
  );
};

/**
 * 连续被淘汰段的等高占位(spec §14.1):一段一个 DOM 节点,高度是各小节之和。
 * 逐回合一个占位会让 slots 与 DOM 随翻页无界增长(实测 201 槽里 151 是占位)。
 */
const GapRow: Component<{ slot: Slot }> = (props) => {
  const height = createMemo(() => {
    const slot = props.slot;
    return slot.kind === "gap" ? untrack(() => gapHeight(slot.spans)) : 0;
  });
  return (
    <div
      class="turn-placeholder"
      style={{ height: `${height()}px` }}
      data-slot-key={props.slot.key}
    />
  );
};

/** 一个回合槽:按 key 取回合(不遍历 turns);数据不在(已淘汰)时退化为占位。 */
const TurnSlot: Component<{ store: SessionStore; slotKey: string }> = (props) => {
  const turn = createMemo(() => props.store.state[0].turns[props.slotKey]);
  const waits = createMemo<Wait[]>(() => {
    const key = props.slotKey;
    return props.store.state[0].waits.filter((wait) => wait.turnKey === key || wait.turnKey == null);
  });
  return (
    <div data-slot-key={props.slotKey}>
      <Show when={turn()} fallback={<GapRow slot={{ kind: "gap", key: props.slotKey, spans: [] }} />}>
        {(value) => <TurnView turn={value()} waits={waits()} store={props.store} />}
      </Show>
      <Show when={props.store.compactedAfter[0]() === props.slotKey}>
        <div class="compact-divider" role="separator"><span>{STR.compactedAbove}</span></div>
      </Show>
    </div>
  );
};
