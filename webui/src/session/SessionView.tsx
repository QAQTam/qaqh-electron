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
import IconLoader from "~icons/lucide/loader-circle";
import { TurnView } from "../turn/TurnView";
import { anchorScrollTop, clampPlaceholderHeight, EVICT_SCREENS, shouldLoadOlder, TURN_WINDOW } from "../session/pagination";
import { sessionTurnFromSnapshot } from "../session/reducer";
import { STR } from "../lib/strings";
import type { SessionStore } from "../session/store";
import { gapHeight, type Slot, type Wait } from "../session/types";
import type { Tab } from "../tabs/store";
import type { ExecSessionView } from "@qaqh/sdk/protocol";

export const SessionView: Component<{ tab: Tab }> = (props) => {
  let scroller: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(true);
  const [unseen, setUnseen] = createSignal(false);
  const [activeNavKey, setActiveNavKey] = createSignal<string | null>(null);
  const [hoveredNavKey, setHoveredNavKey] = createSignal<string | null>(null);
  const [execSessionLayoutVersion, setExecSessionLayoutVersion] = createSignal(0);
  const store = props.tab.store;
  const state = () => store.state[0];
  const execSessions = createMemo(() => Object.values(state().execSessions).sort((a, b) => b.started_at_ms - a.started_at_ms));
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
    () => [state().slots.length, tailVisibleChars(), execSessionLayoutVersion(), pinned()] as const,
    ([count, chars, execLayout, follow], prev) => {
      const grewExecList = prev !== undefined && execLayout > prev[2];
      if (count === 0 && !grewExecList) return;
      const newSlots = prev === undefined || count > prev[0];
      const grewTail = prev !== undefined && chars > prev[1];
      if (!newSlots && !grewTail && !grewExecList) return;
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
      {/* 阶段4:SessionHeader 已迁入 TopBar 中格(spec §6.4),会话页不再有 40px 标题行。 */}
      <Show when={store.providerRetry[0]()}>
        {(retry) => (
          <div class="provider-retry" role="status" aria-live="polite">
            <span>{STR.providerRetrying(retry().attempt, retry().maxRetries, retry().delaySecs)}</span>
            <Show when={retry().error.trim() !== ""}>
              <span class="provider-retry-detail">{retry().error}</span>
            </Show>
          </div>
        )}
      </Show>
      <div
        id="messages"
        ref={scroller}
        onScroll={onScroll}
        onWheel={markUserScrolled}
        onTouchMove={markUserScrolled}
        onPointerDown={markUserScrolled}
        onKeyDown={markUserScrolled}
      >
        <ExecSessionList
          sessions={execSessions()}
          contentStatus={store.contentStatus[0]()}
          onLayoutChange={() => setExecSessionLayoutVersion((version) => version + 1)}
          hasLoadedCall={(callId) => Object.values(state().turns).some((turn) => turn.steps.some((step) => step.kind === "tool" && step.id === callId))}
          onLocateCall={(callId) => {
            const target = scroller?.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(callId)}"]`);
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
          store={store}
        />
        {/* 后台标签已卸载转录,重新激活后等 attach 权威首页落地(BUG-2026-10-29):
            未 hydrate 时显式给「消息同步中」,不闪空态。 */}
        <Show when={!store.hydrated[0]()}>
          <div class="sync-note" role="status" aria-live="polite">
            <IconLoader class="spin" />
            <span>{STR.syncingMessages}</span>
          </div>
        </Show>
        <Show when={state().truncatedBefore}>
          <div class="history-note">{STR.truncatedWindow}</div>
        </Show>
        <Show when={store.loadError[0]()}>
          <button type="button" class="history-note retry" onClick={() => store.loadBootstrap()}>
            {STR.loadFailedRetry}
          </button>
        </Show>
        <Show when={Object.values(store.contentStatus[0]()).some((status) => status === "failed")}>
          <button type="button" class="history-note retry" onClick={() => store.retryContent()}>
            部分正文加载失败，点击重试
          </button>
        </Show>
        <For each={slotGroups()} keyed={(group) => group.key}>
          {(group) => <div class="session-group"><For each={group().keys}>{(key) => (
            <Show when={slotTable().get(key)?.kind === "turn"} fallback={<>
              <GapRow slot={slotTable().get(key) ?? { kind: "gap", key, spans: [] }} />
            </>}>
              <TurnSlot store={store} slotKey={key} />
            </Show>
          )}</For></div>}
        </For>
      </div>
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

const ExecSessionList: Component<{
  sessions: ExecSessionView[];
  contentStatus: Record<string, "loading" | "ready" | "failed">;
  onLayoutChange: () => void;
  hasLoadedCall: (callId: string) => boolean;
  onLocateCall: (callId: string) => void;
  store: SessionStore;
}> = (props) => {
  let observer: ResizeObserver | undefined;
  onCleanup(() => observer?.disconnect());
  const observeLayout = (element: HTMLElement): void => {
    observer?.disconnect();
    observer = new ResizeObserver(() => props.onLayoutChange());
    observer.observe(element);
  };
  return (
    <Show when={props.sessions.length > 0}>
      <section class="exec-session-list" aria-label="后台执行会话" ref={observeLayout}>
        <header class="exec-session-list-head"><strong>后台执行</strong><span>{props.sessions.length}</span></header>
        <For each={props.sessions} keyed={(session) => session.id}>{(session) => (
          <ExecSessionCard
            session={session()}
            contentStatus={props.contentStatus}
            hasLoadedCall={props.hasLoadedCall(session().origin_call_id)}
            onLocateCall={() => props.onLocateCall(session().origin_call_id)}
            store={props.store}
          />
        )}</For>
      </section>
    </Show>
  );
};

const ExecSessionCard: Component<{
  session: ExecSessionView;
  contentStatus: Record<string, "loading" | "ready" | "failed">;
  hasLoadedCall: boolean;
  onLocateCall: () => void;
  store: SessionStore;
}> = (props) => {
  const [pending, setPending] = createSignal<"interrupt" | "terminate" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [originPending, setOriginPending] = createSignal(false);
  const [originError, setOriginError] = createSignal<string | null>(null);
  const [originExpanded, setOriginExpanded] = createSignal(false);
  const originSnapshot = () => props.store.state[0].originTurns[props.session.origin_turn_id];
  const originTurn = createMemo(() => {
    const snapshot = originSnapshot();
    return snapshot ? sessionTurnFromSnapshot(snapshot) : null;
  });
  const canLocateOriginCall = createMemo(() => props.hasLoadedCall || (
    originExpanded()
    && originTurn()?.steps.some((step) => step.kind === "tool" && step.id === props.session.origin_call_id) === true
  ));
  const outputRef = () => props.session.output?.kind === "ref" ? props.session.output.data.content_ref : null;
  const outputText = () => props.session.output?.kind === "inline"
    ? props.session.output.data.text
    : props.session.output_preview;
  let outputScroller: HTMLPreElement | undefined;
  let outputFollowing = true;
  let outputFrame: number | undefined;
  createEffect(() => outputText(), () => {
    if (outputFrame != null) cancelAnimationFrame(outputFrame);
    outputFrame = requestAnimationFrame(() => {
      outputFrame = undefined;
      if (outputFollowing && outputScroller) outputScroller.scrollTop = outputScroller.scrollHeight;
    });
  });
  onCleanup(() => { if (outputFrame != null) cancelAnimationFrame(outputFrame); });
  const active = () => props.session.state.kind === "running";
  const nonzeroExit = () => props.session.state.kind === "finished"
    && props.session.state.outcome.kind === "exited"
    && props.session.state.outcome.exit_code !== 0;
  const status = (): string => {
    const state = props.session.state;
    if (state.kind === "running") return "运行中";
    if (state.kind === "stopping") return state.reason === "interrupt" ? "正在中断" : state.reason === "terminate" ? "正在终止" : "正在停止";
    const outcome = state.outcome;
    if (outcome.kind === "exited") return outcome.exit_code === 0 ? "已退出 · 0" : `退出码 ${outcome.exit_code}`;
    if (outcome.kind === "cancelled") return `已取消 · ${outcome.reason}${outcome.exit_code == null ? "" : ` · 退出码 ${outcome.exit_code}`}`;
    if (outcome.kind === "timed_out") return `已超时${outcome.exit_code == null ? "" : ` · 退出码 ${outcome.exit_code}`}`;
    return `执行已中断 · ${outcome.reason}`;
  };
  const stop = async (action: "interrupt" | "terminate"): Promise<void> => {
    setPending(action);
    setError(null);
    try {
      if (action === "interrupt") await props.store.interruptExecSession(props.session.id);
      else await props.store.terminateExecSession(props.session.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  };
  const toggleOrigin = async (): Promise<void> => {
    if (originSnapshot()) {
      setOriginExpanded((expanded) => !expanded);
      return;
    }
    setOriginPending(true);
    setOriginError(null);
    try {
      await props.store.loadExecSessionOrigin(props.session.origin_turn_id);
      setOriginExpanded(true);
    } catch (reason) {
      setOriginError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOriginPending(false);
    }
  };
  return (
    <article class={{ "exec-session-card": true, failed: nonzeroExit() }}>
      <div class="exec-session-card-head">
        <strong class="exec-session-status">{status()}</strong>
        <time>{new Date(props.session.started_at_ms).toLocaleString()}</time>
        <Show when={props.session.finished_at_ms != null}><time>结束 {new Date(props.session.finished_at_ms!).toLocaleString()}</time></Show>
        <Show when={active()}>
          <span class="spacer" />
          <button type="button" class="ghost-mini" disabled={pending() !== null} onClick={() => void stop("interrupt")}>{pending() === "interrupt" ? "中断中…" : "中断"}</button>
          <button type="button" class="ghost-mini danger" disabled={pending() !== null} onClick={() => void stop("terminate")}>{pending() === "terminate" ? "终止中…" : "终止"}</button>
        </Show>
      </div>
      <pre class="exec-session-command">{props.session.command}</pre>
      <div class="exec-session-meta">
        <span title={props.session.id}>会话 {props.session.id}</span>
        <span title={`会话 ${props.store.seed} / 回合 ${props.session.origin_turn_id} / 调用 ${props.session.origin_call_id}`}>来源 {props.session.origin_turn_id} · {props.session.origin_call_id}</span>
        <Show when={canLocateOriginCall()}><button type="button" class="ghost-mini" onClick={props.onLocateCall}>定位来源调用</button></Show>
        <button type="button" class="ghost-mini" disabled={originPending()} onClick={() => void toggleOrigin()}>
          {originPending() ? "加载来源回合…" : originSnapshot() ? originExpanded() ? "收起来源回合" : "查看来源回合" : "读取来源回合"}
        </button>
      </div>
      <Show when={originError()}><div class="exec-session-note exec-session-error" role="alert">{originError()}</div></Show>
      <Show when={originExpanded() && originTurn()}>
        {(turn) => <div class="exec-session-origin">
          <TurnView turn={turn()} waits={[]} store={props.store} isLatestTurn={false} />
        </div>}
      </Show>
      <Show when={outputText() || outputRef()}>
        <pre
          ref={outputScroller}
          class="exec-session-output"
          tabindex={0}
          role="region"
          aria-label="执行会话输出"
          onWheel={(event) => { if (event.deltaY < 0) outputFollowing = false; }}
          onPointerDown={() => { outputFollowing = false; }}
          onTouchStart={() => { outputFollowing = false; }}
          onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) outputFollowing = false; }}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (element.scrollHeight - element.scrollTop - element.clientHeight <= 2) outputFollowing = true;
          }}
        >{outputText()}</pre>
      </Show>
      <Show when={outputRef() && props.contentStatus[outputRef()!] === "loading"}>
        <div class="exec-session-note" role="status"><IconLoader class="spin" />正在加载完整输出…</div>
      </Show>
      <Show when={!outputText() && !outputRef() && props.session.state.kind === "running"}>
        <div class="exec-session-note">等待命令输出…</div>
      </Show>
      <div class="exec-session-notes">
        <Show when={props.session.preview_start_offset > 0}><span>当前显示输出尾部</span></Show>
        <Show when={props.session.stream_dropped_bytes > 0}><span>实时流缺失 {props.session.stream_dropped_bytes} 字节</span></Show>
        <Show when={props.session.capture_omitted_bytes > 0}><span>完整记录省略 {props.session.capture_omitted_bytes} 字节</span></Show>
        <Show when={props.session.state.kind === "finished" && !props.session.output_complete}><span>输出未完整收尾</span></Show>
        <Show when={outputRef() && props.contentStatus[outputRef()!] === "failed"}><span>完整输出加载失败，仍显示实时尾窗</span></Show>
        <Show when={error()}><span class="exec-session-error">{error()}</span></Show>
      </div>
    </article>
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
    </div>
  );
};
