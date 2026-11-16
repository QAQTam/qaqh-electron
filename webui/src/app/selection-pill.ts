/**
 * WinUI 3 NavigationView 选中指示器(单个共享 pill)驱动器。
 *
 * 公式逐行对齐 microsoft-ui-xaml `controls/dev/NavigationView/NavigationView.cpp`
 * 的 AnimateSelectionChanged / PlayIndicatorAnimations():全程 600ms,1/3 处位置
 * 跳变、缩放锚边翻转;拉伸段 c_frame1 = bezier(.9,.1,1,.2)(加速),收回段
 * c_frame2 = bezier(.1,.9,.2,1)(减速);缩放峰值 = 行程/指示器高 + 1,pill 拉到
 * 「跨过两枚指示器 + 间隔」再收回。WinUI 每项各一枚指示器、新旧两枚重叠播放;
 * 这里用单个 pill + 等价关键帧复刻同一条轨迹:位移与缩放共用同一条缓动,
 * 端点一致则逐帧一致(旧枚的淡出在新枚不透明度 1 下本就不可见)。
 *
 * 语义(同 WinUI AnimateSelectionChanged):
 *  - 同目标重复激活:保留第一段动画,让它飞完;
 *  - 异目标:强制完成上一次(inline 样式钉到旧终点再 cancel fill),从终点起跳;
 *  - 无选中/目标不在 DOM:隐藏;重新出现走首摆快照;
 *  - 低配(isLowSpecActive)与 prefers-reduced-motion:一律快照,不播动画;
 *  - 布局变化:ResizeObserver 与 `invalidation`(如会话目录轮询重排——行盒子
 *    尺寸不变、RO 抓不到的纯移位)都触发**静默**重对位,不打断在飞动画,
 *    onfinish 会按当下 DOM 重新取落点自愈。
 *
 * pill 的几何(top:0 + translateY)由这里全权接管;CSS 只负责外观
 * (宽高/圆角/颜色/transform-origin: top)与「非目标主题 display:none」。
 */
import { createEffect, onCleanup, type Accessor } from "solid-js";
import { isLowSpecActive } from "../lib/visual";

export const SELECTION_PILL_H = 16;
export const SELECTION_PILL_MS = 600;
/** c_frame1:拉伸段(加速)。 */
export const SELECTION_PILL_STRETCH = "cubic-bezier(0.9, 0.1, 1.0, 0.2)";
/** c_frame2:收回段(减速)。 */
export const SELECTION_PILL_SETTLE = "cubic-bezier(0.1, 0.9, 0.2, 1.0)";

/** 换位方式:
 *  - "slide":同级位移(PlayIndicatorAnimations)——拉伸到「跨过两枚指示器 +
 *    间隔」再收回,位移与缩放共用同一条缓动;
 *  - "swap":跨层级(PlayIndicatorNonSameLevelAnimations)——600ms 线性,旧枚
 *    朝行进方向锚边收缩、新枚从对侧锚边生长;单 pill 近似为前半程收缩、
 *    后半程在目标槽位生长(scale 0 处瞬移,不可见)。 */
export type PillMoveKind = "slide" | "swap";

export function createSelectionPill(opts: {
  /** pill 的包含块:同时是 offsetTop/offsetLeft 测量基准与滚动内容根。 */
  container: Accessor<HTMLElement | undefined>;
  pill: Accessor<HTMLElement | undefined>;
  /** 选择键(响应式):变化触发换位动画;null = 无选中,pill 隐藏。 */
  selection: Accessor<string | null>;
  /** 由容器定位激活项;用 aria-current / data-* 等稳定属性,别按位置。 */
  findTarget: (container: HTMLElement, selection: string) => HTMLElement | null;
  /** 结构观察目标:盒子尺寸变化(增删/折叠/字体加载)触发静默重对位。 */
  observe?: (container: HTMLElement) => Array<Element>;
  /** 布局失效源(响应式):变化即静默重对位。用于 RO 抓不到的纯移位(重排)。 */
  invalidation?: Accessor<unknown>;
  /** 换位方式判定(缺省一律 "slide")。网格布局用:同列 slide、跨列 swap。 */
  classify?: (from: HTMLElement, to: HTMLElement) => PillMoveKind;
}): void {
  /** pill 当前应处的 y(item 内指示器中心,相对容器 padding 盒);null = 尚未摆位。 */
  let pillY: number | null = null;
  let pillAnim: Animation | null = null;
  let pillAnimTargetY = 0;
  let pillAnimTargetBtn: HTMLElement | null = null;
  /** 在飞动画是否为退场(收缩离场):强制完成时终结到隐藏态,而不是旧摆位。 */
  let pillAnimExiting = false;
  let placedContainer: HTMLElement | null = null;
  let resizeObs: ResizeObserver | null = null;
  /** pill 当前逻辑上的宿主项:classify 的 "from",与强制完成的落点回填。 */
  let pillBtn: HTMLElement | null = null;
  /** 上一轮的选择键:undefined = 首轮。键没变而 effect 重跑 = 纯布局失效。 */
  let lastSelection: string | null | undefined = undefined;

  const centerOf = (btn: HTMLElement): number =>
    btn.offsetTop + (btn.offsetHeight - SELECTION_PILL_H) / 2;
  /** 动画可播性:容器在渲染树 + 未开"减弱动态" + 未进低配;不可播一律快照落位/直隐。 */
  const playable = (pill: HTMLElement, lowSpec: boolean): boolean =>
    pill.offsetParent != null &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    !lowSpec;
  /** 按当下 DOM 重新解析目标(RO 回调 / onfinish 里用,不依赖 effect 那一轮的键)。 */
  const targetNow = (nav: HTMLElement): HTMLElement | null => {
    const sel = opts.selection();
    return sel == null ? null : opts.findTarget(nav, sel);
  };
  /** 落位写样式(摆位三件套:left 跟随 item,transform 定 y,显形)。 */
  const place = (pill: HTMLElement, btn: HTMLElement, y: number): void => {
    pillY = y;
    pillBtn = btn;
    pill.style.left = `${btn.offsetLeft}px`;
    pill.style.transform = `translateY(${y}px)`;
    pill.style.opacity = "1";
  };

  createEffect(
    () => [
      opts.container(),
      opts.pill(),
      opts.selection(),
      opts.invalidation?.() ?? null,
      isLowSpecActive(),
    ] as const,
    ([nav, pill, sel, , lowSpec]) => {
      if (nav == null || pill == null || !nav.isConnected) return;

      // 换容器实例(页面卸载再挂)→ 重建观察器并强制走首摆快照。
      if (placedContainer !== nav) {
        resizeObs?.disconnect();
        resizeObs = new ResizeObserver(() => {
          // 静默对位/隐藏:折叠会把活动项卸载(选择键没变,effect 不会重跑),
          // 「目标消失 → 藏、目标重现 → 摆」只能靠这里。在飞动画不打断,
          // onfinish 会按当下 DOM 取新落点自愈。
          if (pillAnim != null) return;
          const p = opts.pill();
          if (p == null) return;
          const cur = targetNow(nav);
          if (cur == null) {
            if (pillY != null) {
              pillY = null;
              p.style.opacity = "0";
            }
            return;
          }
          place(p, cur, centerOf(cur));
        });
        placedContainer = nav;
        pillY = null;
      }
      // observe 每轮幂等重挂:RO 对同一元素重复 observe 是更新而非叠加,
      // 新出现的分组/条目借此进入观察集。
      if (resizeObs != null) opts.observe?.(nav).forEach((el) => resizeObs!.observe(el));

      const selChanged = lastSelection !== sel;
      lastSelection = sel;
      const btn = sel == null ? null : opts.findTarget(nav, sel);
      if (btn == null) {
        // 无选中:焦点交棒离场。摆位动画在飞时直接终结(退场起点应是稳定在场态);
        // 静止在场时播锚顶收缩(WinUI non-same-level 旧枚段),播完隐藏。
        if (pillAnim != null) {
          pillAnim.onfinish = null;
          pillAnim.cancel();
          pillAnim = null;
          pillAnimExiting = false;
          pillY = null;
          pillBtn = null;
          pill.style.opacity = "0";
          return;
        }
        if (pillY != null && playable(pill, lowSpec)) {
          const fromY = pillY;
          // 逻辑上此刻已离场(pillY/pillBtn 即刻清空),动画只是视觉余韵;
          // RO 有 pillAnim 守卫,期间布局变化不会抢跑。
          pillY = null;
          pillBtn = null;
          const exit = pill.animate(
            [
              { transform: `translateY(${fromY}px) scaleY(1)`, offset: 0 },
              { transform: `translateY(${fromY}px) scaleY(0)`, offset: 1 },
            ],
            { duration: SELECTION_PILL_MS, easing: "linear", fill: "forwards" },
          );
          pillAnim = exit;
          pillAnimExiting = true;
          exit.onfinish = () => {
            if (pillAnim !== exit) return;
            pillAnim = null;
            pillAnimExiting = false;
            pill.style.opacity = "0";
            exit.cancel();
          };
          return;
        }
        pillY = null;
        pillBtn = null;
        pill.style.opacity = "0";
        return;
      }
      const targetY = centerOf(btn);

      if (pillAnim != null) {
        if (pillAnimExiting) {
          // 退场在飞又被召回:终结为隐藏态,随后从 null 走进场生长。
          pillAnim.onfinish = null;
          pillAnim.cancel();
          pillAnim = null;
          pillAnimExiting = false;
          pillY = null;
          pillBtn = null;
          pill.style.opacity = "0";
        } else {
          if (pillAnimTargetY === targetY) return; // 同目标:WinUI 保留第一段动画
          if (!selChanged) return; // 纯布局变化:不打断,onfinish 自会取新落点
          // 异目标:强制完成(WinUI "force it to complete")——先把 inline 样式
          // 钉到旧终点再 cancel fill,避免闪回基态。进场动画的终点含 opacity,
          // 钉位时必须一并补上,否则 cancel 后 pill 留在 inline 的隐藏态。
          const stale = pillAnim;
          pillAnim = null;
          stale.onfinish = null;
          pillY = pillAnimTargetY;
          if (pillAnimTargetBtn != null) pillBtn = pillAnimTargetBtn;
          pill.style.transform = `translateY(${pillY}px)`;
          pill.style.opacity = "1";
          stale.cancel();
        }
      }

      // 键没变的重跑(轮询重排/折叠)是布局失效:静默对位,不播动画。
      if (!selChanged && pillY != null) {
        place(pill, btn, targetY);
        return;
      }

      if (!playable(pill, lowSpec)) {
        place(pill, btn, targetY);
        return;
      }
      if (pillY == null) {
        // 进场(WinUI non-same-level 新枚段):在目标槽位锚顶生长,同步淡入。
        // 冷启动首摆与交棒召回共用这一段;低配/减弱动态已在上面快照落位。
        const enter = pill.animate(
          [
            { transform: `translateY(${targetY}px) scaleY(0)`, opacity: 0, offset: 0 },
            { transform: `translateY(${targetY}px) scaleY(1)`, opacity: 1, offset: 1 },
          ],
          { duration: SELECTION_PILL_MS, easing: "linear", fill: "forwards" },
        );
        pillAnim = enter;
        pillAnimExiting = false;
        pillAnimTargetY = targetY;
        pillAnimTargetBtn = btn;
        enter.onfinish = () => {
          if (pillAnim !== enter) return;
          pillAnim = null;
          // 落定前按当下 DOM 重取目标:动画期间布局变了(折叠/重排/删除)也能自愈。
          const cur = targetNow(nav);
          if (cur == null) {
            pillY = null;
            pill.style.opacity = "0";
          } else {
            place(pill, cur, centerOf(cur));
          }
          enter.cancel();
        };
        return;
      }
      const fromBtn = pillBtn;
      const swap =
        fromBtn != null && pillY != null && opts.classify?.(fromBtn, btn) === "swap";
      // 同位(含同行跨列——那是 swap 的活,见下):快照落位。
      const leftChanged = swap && fromBtn != null && fromBtn.offsetLeft !== btn.offsetLeft;
      if (pillY === targetY && !leftChanged) {
        place(pill, btn, targetY);
        return;
      }
      const fromY = pillY;
      pillY = targetY;
      let anim: Animation;
      if (swap) {
        // 跨层级交换(单 pill 近似):前半程朝行进方向锚边收缩,后半程从目标
        // 的对侧锚边生长。WinUI 原实现是新旧两枚 600ms 线性同时播;这里的
        // scale 0 瞬移点不可见,且方向语义与其一致(下行:缩进旧槽位底缘、
        // 从新槽位顶缘长出;上行/同行:缩进顶缘、从底缘长出)。
        // 跨列时 left 也走关键帧:横向跳变同样落在 scale 0 的不可见交叉点,
        // 可见阶段(收缩/生长)里 left 恒定,不产生逐帧重排。
        const down = targetY > fromY;
        const fromLeft = `${fromBtn!.offsetLeft}px`;
        const toLeft = `${btn.offsetLeft}px`;
        anim = pill.animate(
          [
            { transform: `translateY(${fromY}px) scaleY(1)`, left: fromLeft, offset: 0 },
            {
              transform: `translateY(${fromY + (down ? SELECTION_PILL_H : 0)}px) scaleY(0)`,
              left: fromLeft,
              offset: 0.5,
            },
            {
              transform: `translateY(${targetY + (down ? 0 : SELECTION_PILL_H)}px) scaleY(0)`,
              left: toLeft,
              offset: 0.5001,
            },
            { transform: `translateY(${targetY}px) scaleY(1)`, left: toLeft, offset: 1 },
          ],
          { duration: SELECTION_PILL_MS, fill: "forwards" },
        );
      } else {
        // 同级位移:拉伸(锚行进侧边缘,bezier(.9,.1,1,.2))→ 1/3 跳变 →
        // 收回(bezier(.1,.9,.2,1)),位移与缩放共用同一条缓动。
        const dist = targetY - fromY;
        const scale = 1 + Math.abs(dist) / SELECTION_PILL_H;
        const up = dist < 0;
        anim = pill.animate(
          [
            { transform: `translateY(${fromY}px) scaleY(1)`, easing: SELECTION_PILL_STRETCH, offset: 0 },
            {
              transform: `translateY(${up ? targetY : fromY}px) scaleY(${scale})`,
              easing: SELECTION_PILL_SETTLE,
              offset: 1 / 3,
            },
            { transform: `translateY(${targetY}px) scaleY(1)`, offset: 1 },
          ],
          { duration: SELECTION_PILL_MS, fill: "forwards" },
        );
      }
      pillAnim = anim;
      pillAnimTargetY = targetY;
      pillAnimTargetBtn = btn;
      anim.onfinish = () => {
        if (pillAnim !== anim) return;
        pillAnim = null;
        // 落定前按当下 DOM 重取目标:动画期间布局变了(折叠/重排/删除)也能自愈。
        const cur = targetNow(nav);
        if (cur == null) {
          pillY = null;
          pill.style.opacity = "0";
        } else {
          place(pill, cur, centerOf(cur));
        }
        anim.cancel();
      };
    },
  );

  onCleanup(() => {
    resizeObs?.disconnect();
    pillAnim?.cancel();
    pillAnim = null;
  });
}

