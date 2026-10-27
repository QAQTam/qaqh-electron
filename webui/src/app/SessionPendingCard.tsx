/**
 * 会话行上的「待响应」弹出卡(slide-in / slide-out + 跑马灯)。
 *
 * 生命周期由后端状态驱动,不由用户点击驱动——这正是它和 `ui/toast.tsx` 的区别:
 * toast 是命令式、会自己消退;这张卡代表一件**还挂着的事**,只有状态回到非待人
 * 才会离场,所以静置期用低频呼吸光晕代替倒计时。
 *
 * 相位机:`in` --slide-in 结束--> `hold` --状态离开待人--> `out` --动画结束--> 卸载。
 * 入场动画故意用 `animationend` 而不是定时器推进,这样离场能立刻打断入场
 * (用户可能在动画没播完时就响应了)。
 */
import { createEffect, createSignal, For, onCleanup, Show, untrack, type Component } from "solid-js";
import IconClipboardList from "~icons/lucide/clipboard-list";
import IconCircleHelp from "~icons/lucide/circle-help";
import IconShieldAlert from "~icons/lucide/shield-alert";
import type { SidebarSession } from "../tabs/store";
import type { ApprovalView } from "../lib/transport";
import { pendingPresentation, type PendingKind } from "./session-pending";

/** 跑马灯线速度(px/s)。匀速而不是固定时长:文案长短只改变一圈用时,不改变速度。 */
const MARQUEE_SPEED_PX_PER_S = 34;
/** 半轨短于此值就不值得动(退化尺寸兜底),静止显示。 */
const MARQUEE_MIN_TRAVEL_PX = 40;
/** 离场动画兜底:reduced-motion 下动画被关掉,`animationend` 永不到来。 */
const EXIT_FALLBACK_MS = 260;

type Phase = "in" | "hold" | "out";

const KIND_ICON = {
  permission: IconShieldAlert,
  ask: IconCircleHelp,
  plan: IconClipboardList,
} as const;

export const SessionPendingCard: Component<{ session: SidebarSession; fastApproval?: ApprovalView | null }> = (props) => {
  const [kind, setKind] = createSignal<PendingKind | null>(null);
  const [label, setLabel] = createSignal("");
  const [phase, setPhase] = createSignal<Phase>("in");

  // 测量产物:半轨宽度(px)与每个半轨里的文案份数。
  const [travel, setTravel] = createSignal(0);
  const [perHalf, setPerHalf] = createSignal(1);

  let marqueeEl: HTMLSpanElement | undefined;
  let observer: ResizeObserver | null = null;
  onCleanup(() => observer?.disconnect());

  /**
   * 量出「半轨」宽度:份数取到能盖住卡片内宽为止(短文案也能铺满并滚动),
   * 轨道由两个完全相同的半轨拼成,位移恰好一个半轨宽 → 无缝循环。
   * 位移改成别的值就会在接缝处跳一下,这是这类动画唯一的坑。
   */
  const remeasure = (): void => {
    const unit = marqueeEl?.querySelector<HTMLElement>(".session-pending-unit");
    if (marqueeEl == null || unit == null) return;
    const unitWidth = unit.getBoundingClientRect().width;
    const boxWidth = marqueeEl.getBoundingClientRect().width;
    if (!(unitWidth > 0) || !(boxWidth > 0)) return;
    const needed = Math.max(1, Math.ceil((boxWidth + 8) / unitWidth));
    if (needed !== perHalf()) setPerHalf(needed);
    const half = unitWidth * needed;
    const next = half > MARQUEE_MIN_TRAVEL_PX ? Math.round(half) : 0;
    if (next !== travel()) setTravel(next);
  };

  const attachMarquee = (el: HTMLSpanElement): void => {
    marqueeEl = el;
    observer?.disconnect();
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => remeasure());
      observer.observe(el);
    }
    // 字体/宽度在首帧之后才稳定,补量一次。
    requestAnimationFrame(remeasure);
  };

  // 状态驱动:进入待人 → 播入场;离开待人 → 播离场(离场播完才卸载)。
  createEffect(
    () => pendingPresentation(props.session, props.fastApproval),
    (next) => {
      if (next != null) {
        setKind(next.kind);
        setLabel(next.label);
        // 已在播入场就不打断;从 hold 回到 in 说明状态换了一轮,重播。
        if (untrack(phase) !== "in") setPhase("in");
      } else if (untrack(kind) != null) {
        setPhase("out");
      }
    },
  );

  // 离场兜底:动画被 prefers-reduced-motion 关掉时,animationend 不会来。
  createEffect(
    () => phase(),
    (current) => {
      if (current !== "out") return;
      const timer = window.setTimeout(() => setKind(null), EXIT_FALLBACK_MS);
      onCleanup(() => window.clearTimeout(timer));
    },
  );

  const onBodyAnimationEnd = (event: AnimationEvent): void => {
    if (event.animationName === "session-pending-slide-in") setPhase("hold");
    else if (event.animationName === "session-pending-slide-out") setKind(null);
  };

  const duration = (): string => `${(travel() / MARQUEE_SPEED_PX_PER_S).toFixed(2)}s`;

  return (
    <Show when={kind()}>
      {(current) => (
        // 整卡 aria-hidden:它挂在会话按钮**内部**,若让它参与可访问名计算,
        // 按钮的名字会被跑马灯的重复文案灌成「请求授权 请求授权 请求授权…」。
        // 状态改由按钮自己的 aria-label 承载(`MessageSidebar`),读屏在导航到
        // 该行时就能听到「<标题>:请求授权」。
        <span class="session-pending" data-kind={current()} data-phase={phase()} aria-hidden="true">
          <span class="session-pending-body" onAnimationEnd={onBodyAnimationEnd}>
            {(() => {
              const Icon = KIND_ICON[current()];
              return <Icon class="session-pending-icon" />;
            })()}
            <span class="session-pending-marquee" ref={attachMarquee}>
              <span
                class="session-pending-track"
                data-run={travel() > 0 ? "true" : "false"}
                style={{ "--mq-travel": `${travel()}px`, "--mq-duration": duration() }}
              >
                <For each={[0, 1]}>
                  {() => (
                    <span class="session-pending-half">
                      <For each={Array.from({ length: perHalf() })}>
                        {() => (
                          <span class="session-pending-unit">
                            <span>{label()}</span>
                            <i class="session-pending-dot" />
                          </span>
                        )}
                      </For>
                    </span>
                  )}
                </For>
              </span>
            </span>
          </span>
        </span>
      )}
    </Show>
  );
};