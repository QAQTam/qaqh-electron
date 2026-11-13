/**
 * 飞箱：封箱卡头的盒子飞到侧栏新会话行（交接倒计时期望「箱子去新对话」）。
 *
 * 图层挂 body（fixed），不受切会话的视图切换影响；落点锚 =
 * `[data-session-id="<child>"]`（MessageSidebar 行）。fork 后 pollSessions
 * 异步回表，这里轮询目标行最多 1400ms，拿不到就飞侧栏列表容器兜底。
 * reduced-motion / 无起点 = 直接 resolve，调用方照常跳转。
 */

// 静置封好的盒（含合拢的盒盖线+勾），飞行画形与 BoxSeal 终态一致。
const BOX_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 9h16v12H4z"/><path d="M4 9 11 5"/><path d="M20 9 13 5"/>' +
  '<path d="m8.5 15.5 2.5 2.5 4.5-5"/></svg>';

const cssEscape = (value: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

export function flyBoxToSession(from: HTMLElement | null | undefined, childSessionId: string): Promise<void> {
  return new Promise((resolve) => {
    if (from == null || matchMedia("(prefers-reduced-motion: reduce)").matches) { resolve(); return; }
    void (async () => {
      const settle = (): void => { ghost.remove(); resolve(); };
      const start = from.getBoundingClientRect();
      const ghost = document.createElement("div");
      ghost.className = "bx-fly-ghost";
      ghost.innerHTML = BOX_SVG;
      ghost.style.left = `${start.left + start.width / 2 - 21}px`;
      ghost.style.top = `${start.top + start.height / 2 - 21}px`;
      document.body.appendChild(ghost);
      // 等列表回表：目标行最多轮询 1400ms。
      const deadline = performance.now() + 1_400;
      let target: Element | null = null;
      while (performance.now() < deadline) {
        target = document.querySelector(`[data-session-id="${cssEscape(childSessionId)}"]`);
        if (target != null) break;
        await new Promise((r) => setTimeout(r, 90));
      }
      const land = target ?? document.querySelector(".message-sidebar-list");
      const to = (land ?? document.body).getBoundingClientRect();
      const tx = to.left + (target != null ? to.width / 2 : to.width * 0.22);
      const ty = to.top + (target != null ? to.height / 2 : Math.min(to.height - 30, 60));
      const dx = tx - (start.left + start.width / 2);
      const dy = ty - (start.top + start.height / 2);
      const anim = ghost.animate(
        [
          { transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1, offset: 0 },
          { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 90}px) scale(.92) rotate(-10deg)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px) scale(.34) rotate(6deg)`, opacity: 0.35, offset: 1 },
        ],
        { duration: 680, easing: "cubic-bezier(.2,0,.35,1)", fill: "forwards" },
      );
      anim.finished.then(settle, settle);
      setTimeout(settle, 900); // WAAPI 缺席/被取消的兜底卸载
    })();
  });
}
