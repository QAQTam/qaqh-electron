/**
 * 宣传片舞台（promo.html，dev-only，不进口产品链路）。
 *
 * 两种模式：
 *  1) 浏览器直开（人眼预览）：真实时钟，setTimeout 时间轴自然播放。
 *  2) ?capture=1（渲染器逐帧）：**零真实 timer**——渲染器对每帧调
 *     window.__PROMO_SEEK(virtualMs)：场景信号按时间轴幂等派发、
 *     打字机/倒计时/HUD 数字是 seek 的纯函数、所有 CSS/WAAPI 动画
 *     登记后统一设 currentTime（新出现的动画以出现时刻为起点）。
 *     确定性来自构造，不依赖 CDP 虚拟时间（其 screenshot 死锁实测于 2026-11-12）。
 *
 * 时间轴唯一事实源 ./scenes.json（音效轴同源，成片秒已折算）。
 * 卡面用真实类名结构（.handoff-card/.handoff-icon/SealRitual），画的就是产品本体；
 * B 侧直挂真 HandoffOpenCard + OpenRitual（组件在无 onDone 时不会自拆，交给 seek）。
 */
import { createSignal, Show, type Component } from "solid-js";
import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import { markPlatform } from "./lib/platform";
import { applyTheme } from "./lib/theme";
import { Markdown } from "./markdown/Markdown";
import { HandoffOpenCard, type HandoffOpenSource } from "./session/HandoffOpenCard";
import { BoxSeal } from "./ui/box-anim";
import { SealRitual, OpenRitual } from "./ui/box-ritual";
import scenes from "./promo/scenes.json";
import "./styles/app.css";
import "./promo/promo.css";

markPlatform();
applyTheme("light");

// **必须传 location.search**：`new URLSearchParams()` 空参 = 空集，
// `?capture=1` 会被解析失败 → 整页退回真实时间轴（2026-11-12 血案根因）。
const qp = new URLSearchParams(location.search);
const CAPTURE = qp.has("capture");
type Scene = { id: string; at: number; caption: string; kind: string };
const SCENES = scenes.scenes as Scene[];
const CHILD_ID = "sess-promo-child";

const DOC = [
  "# 交接文档",
  "",
  "封箱/开箱动画盒完工：`box-anim` 24 视野描线，盖板绕铰链 75°，基态=终态。",
  "lite / zen / reduced-motion 三档静置终态画。",
  "",
  "- 下一步：宣传片管线（seek 逐帧渲染，确定性出片）",
].join("\n");

const FULL_TEXT = [
  "封箱动画盒收尾完毕：盖板绕铰链合拢 75°，对勾 dasharray 描出；**基态=终态**，",
  "lite/zen/降级偏好三档静置即得正确画。已顺手把 -21 的动画段过了一遍 typecheck。",
  "",
  "```css",
  "@keyframes bxSealL { 0%,12% { transform: rotate(-75deg); } 55%,100% { transform: rotate(0deg); } }",
  "```",
].join("\n");

// ── 舞台状态（两种模式共用；capture 下全部由 seek 写入）──
type Stage = "black" | "a" | "b" | "phi" | "end";
const [stage, setStage] = createSignal<Stage>("black");
const [caption, setCaption] = createSignal("");
const [cover, setCover] = createSignal(false);
const [warm, setWarm] = createSignal(false);
const [hudHi, setHudHi] = createSignal(false);
const [cardOn, setCardOn] = createSignal(false); // A 侧封箱卡（含仪式）
const [ritualOn, setRitualOn] = createSignal(false);
const [flyOn, setFlyOn] = createSignal(false); // 飞箱 ghost
const [openOn, setOpenOn] = createSignal(false); // B 侧开箱卡
const [openRitualOn, setOpenRitualOn] = createSignal(false);
const [typed, setTyped] = createSignal("");
const [cdPct, setCdPct] = createSignal<number | null>(null);
const [sideExtra, setSideExtra] = createSignal<{ id: string; title: string; newborn: boolean } | null>(null);
const [daemonRss, setDaemonRss] = createSignal(25.8);
const [heap, setHeap] = createSignal(171);

function applyScene(s: Scene): void {
  setCaption(s.caption);
  setWarm(s.kind.includes("warm"));
  setHudHi(s.kind.includes("hud"));
  switch (s.id) {
    case "hook": case "hook2": setStage("black"); break;
    case "thread": setStage("a"); break;
    case "seal":
      setCardOn(true); setRitualOn(true); break;
    case "countdown": setCdPct(1); break;
    case "fly": setCdPct(0); setFlyOn(true); break;
    case "blackout": setCover(true); break;
    case "open":
      setCover(false); setStage("b"); setOpenRitualOn(true); setOpenOn(true);
      setSideExtra({ id: CHILD_ID, title: "交接自 A · B", newborn: true });
      break;
    case "warmpaper": break;
    case "phi": setStage("phi"); break;
    case "hud": setStage("b"); break;
    case "end": setWarm(false); setStage("end"); break;
  }
}

// ── capture：seek 引擎 ──
// 时间锚（虚拟 ms，与 scenes.json 对齐；ritual/fly 的卸载点也钉在这里）
const SEAL_AT = 10_700, CD_END = 20_700, FLY_AT = 20_700, OPEN_AT = 22_700;
const anims = new Map<Animation, number>(); // anim → 起点(虚拟ms)
function seekAnims(t: number): void {
  for (const a of document.getAnimations()) {
    if (!anims.has(a)) { anims.set(a, t); try { a.pause(); } catch { /* noop */ } }
    const start = anims.get(a)!;
    try { a.currentTime = Math.max(0, t - start); } catch { /* 已结束/方向不符 */ }
  }
}
const seekFn = (t: number): void => {
  for (const s of SCENES) {
    if (s.at <= t) applyScene(s); // 幂等：信号重设同值无害
  }
  if (t > SEAL_AT + 2450) setRitualOn(false);
  if (t > FLY_AT + 150) ensureFlyCreate();
  if (t > FLY_AT + 1500) setFlyOn(false);
  if (t > OPEN_AT + 1850) setOpenRitualOn(false);
  // 打字机：thread 起点后 4600ms 打完全篇
  const tp = Math.max(0, Math.min(1, (t - 5200) / 4600));
  setTyped(FULL_TEXT.slice(0, Math.floor(tp * FULL_TEXT.length)));
  // 倒计时条：卡挂载(SEAL_AT)起 10s 虚拟毫秒燃尽
  if (t >= SEAL_AT + 2500 && t <= CD_END) setCdPct(1 - (t - (SEAL_AT + 2500)) / (CD_END - SEAL_AT - 2500));
  else if (t > CD_END) setCdPct(0);
  // HUD：确定性抖动（渲染器每一帧同 t 同值）
  setDaemonRss(25.6 + Math.sin(t / 610) * 0.9);
  setHeap(168 + Math.sin(t / 433) * 6);
  if (t > FLY_AT + 120 && sideExtra() == null && !openOn()) {
    // 飞箱途中 B 行先出现在侧栏（真链路里 pollSessions 回表≈这个位置）
    setSideExtra({ id: CHILD_ID, title: "交接自 A · B", newborn: true });
  }
  seekAnims(t);
};

if (!CAPTURE) {
  for (const s of SCENES) window.setTimeout(() => applyScene(s), s.at);
  let n = 0;
  const typing = window.setInterval(() => {
    n += 6; setTyped(FULL_TEXT.slice(0, n));
    if (n >= FULL_TEXT.length) window.clearInterval(typing);
  }, 55);
  window.setTimeout(() => { setSideExtra({ id: CHILD_ID, title: "交接自 A · B", newborn: true }); setFlyOn(true); }, FLY_AT);
  window.setTimeout(() => ensureFlyCreate(), FLY_AT + 200);
  window.setTimeout(() => setRitualOn(false), SEAL_AT + 2500);
  window.setTimeout(() => setFlyOn(false), FLY_AT + 1600);
  window.setTimeout(() => setOpenRitualOn(false), OPEN_AT + 1900);
  window.setTimeout(() => setCdPct(1), SEAL_AT + 2500);
  const cd = window.setInterval(() => setCdPct((p) => (p == null ? p : Math.max(0, p - 0.1))), 1000);
  window.setTimeout(() => window.clearInterval(cd), CD_END + 500);
  window.setInterval(() => { setDaemonRss(25.2 + Math.random() * 2.1); }, 260);
  // 录制友好：播完自动循环（?loop=0 关闭）。reload 即回到静置首帧，随录随停。
  if (new URLSearchParams(location.search).get("loop") !== "0") {
    window.setTimeout(() => location.reload(), (SCENES[SCENES.length - 1]?.at ?? 35_000) + 4_000);
  }
} else {
  (window as unknown as { __PROMO_SEEK?: (t: number) => void }).__PROMO_SEEK = seekFn;
}
void document.fonts.ready.then(() => {
  (window as unknown as { __PROMO_READY?: boolean }).__PROMO_READY = true;
});

// ── 视图 ──
const Hud: Component = () => {
  const spark = () => Array.from({ length: 32 }, (_, i) => 24.4 + Math.sin((i + daemonRss()) * 1.3) * 1.1);
  const points = () => spark().map((v, i) => `${i * 6},${58 - (v - 23) * 5}`).join(" ");
  return (
    <aside class={{ "promo-hud": true, pulse: hudHi() }}>
      <div class="hud-title">资源占用 · 演示</div>
      <div class="hud-card">
        <label>qaqh-daemon RSS</label>
        <strong>{daemonRss().toFixed(1)}<small>MB</small></strong>
        <svg viewBox="0 0 192 58" class="hud-spark" aria-hidden="true">
          <polyline points={points()} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="hud-card"><label>renderer JS heap</label><strong>{heap().toFixed(0)}<small>MB</small></strong></div>
      <div class="hud-card"><label>热更包</label><strong>1.4<small>MB</small></strong></div>
      <div class="hud-foot">后端 Rust · 会话不断线</div>
    </aside>
  );
};

const SideBar: Component = () => (
  <nav class="promo-side" aria-label="会话列表">
    <div class="side-head">会话</div>
    <div class="side-row active" data-session-id="sess-promo-A">
      <span class="side-dot" />qaqh-electron · A
    </div>
    <Show when={sideExtra()}>{(row) => (
      <div class="side-row newborn" data-session-id={row().id}>
        <span class="side-dot" />{row().title}
      </div>
    )}</Show>
  </nav>
);

// 封箱卡：真实类名骨架 + 真 SealRitual（不传 onDone，拆挂由 seek 控制）。
// 视觉与产品 HandoffCard 同构；避开组件内部 10s setInterval。
const PromoHandoffCard: Component = () => (
  <div class="handoff-card">
    <Show when={ritualOn()}><SealRitual /></Show>
    <div class="handoff-head">
      <span class="handoff-icon" aria-hidden="true"><BoxSeal /></span>
      <div class="handoff-title-wrap">
        <strong>已封箱交接</strong>
        <small>模型已封存上下文，等待继续</small>
      </div>
      <span class="handoff-occupancy">84%（168k / 200k tokens）</span>
    </div>
    <p class="handoff-summary"><span class="handoff-summary-label">工作简述：</span>封箱/开箱动画盒完工，待发 -21</p>
    <p class="handoff-meta">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /></svg>
      改动 3 个文件
    </p>
    <Show when={cdPct() != null}>
      <div class="handoff-countdown" role="timer">
        <div class="handoff-countdown-track"><div class="handoff-countdown-bar" style={{ width: `${Math.round((cdPct() ?? 0) * 100)}%`, "transition": "none" }} /></div>
        <span class="handoff-countdown-label">{Math.max(0, Math.ceil(((cdPct() ?? 0) * 10)))} s 后自动继续交接</span>
      </div>
    </Show>
    <div class="handoff-actions">
      <button type="button" class="handoff-continue">继续交接</button>
      <button type="button" class="handoff-doc-toggle">查看交接文档</button>
    </div>
  </div>
);

// 飞箱 ghost：与 box-fly 同款画形；capture 下由 seekAnims 接管（WAAPI 进 getAnimations 集合）。
// 创建时机不能挂在组件 mount——侧栏 B 行比 ghost 晚 120ms 虚拟毫秒才出现，
// 所以 seekFn 里到点统一调 ensureFlyCreate()（两种模式走同一入口）。
let flyHost: HTMLDivElement | null = null;
let flyCreated = false;
const ensureFlyCreate = (): void => {
  if (flyCreated || flyHost == null) return;
  const from = document.querySelector(".handoff-card .handoff-icon");
  const to = document.querySelector(`[data-session-id="${CHILD_ID}"]`);
  if (from == null || to == null) return;
  flyCreated = true;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  flyHost.style.left = `${a.left + a.width / 2 - 21}px`;
  flyHost.style.top = `${a.top + a.height / 2 - 21}px`;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = flyHost.animate(
    [
      { transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1, offset: 0 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 90}px) scale(.92) rotate(-10deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(.34) rotate(6deg)`, opacity: 0.35, offset: 1 },
    ],
    { duration: 680, easing: "cubic-bezier(.2,0,.35,1)", fill: "forwards" },
  );
  if (CAPTURE) { anim.pause(); anims.set(anim, FLY_AT); }
};

const FlyGhost: Component = () => (
  <div class="bx-fly-ghost" ref={(el) => { flyHost = el; }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 9h16v12H4z" /><path d="M4 9 11 5" /><path d="M20 9 13 5" /><path d="m8.5 15.5 2.5 2.5 4.5-5" />
    </svg>
  </div>
);

const AppWindow: Component<{ children?: JSX.Element }> = (props) => (
  <div class="promo-window">
    <div class="promo-titlebar">
      <span class="tb-dots"><i /><i /><i /></span>
      <span class="tb-title">Qaq-Harness — 宣传片舞台（demo）</span>
      <span class="tb-snake" title="🐍">🐍</span>
    </div>
    <div class="promo-body">
      <SideBar />
      <main class={{ "promo-main": true, "workspace-content": true, warmpaper: warm() }}>{props.children}</main>
      <Hud />
    </div>
  </div>
);

const ThreadView: Component = () => (
  <div class="promo-thread">
    <div class="turn turn-user"><div class="bubble">交接动画盒收尾，发 -21。</div></div>
    <div class="promo-answer">
      <Show when={typed() !== ""}>
        <div class="promo-md"><Markdown text={typed} streaming={!cardOn()} /></div>
      </Show>
    </div>
    <Show when={cardOn()}>
      <PromoHandoffCard />
    </Show>
  </div>
);

const OPEN_SOURCE: HandoffOpenSource = {
  sessionId: "sess-promo-A",
  workSummary: "封箱/开箱动画盒完工，待发 -21",
  // 固定演示时刻：卡上"封箱于"有真实感；且与 Date.now() 差 >12s，
  // 组件自带的开箱小仪式不会触发（大仪式由 seek 层的 openRitualOn 控制）。
  atMs: Date.parse("2026-11-12T17:31:00"),
};

const BView: Component = () => (
  <div class="promo-thread">
    <div class="turn turn-user turn-user-open" style={{ position: "relative" }}>
      <Show when={openRitualOn()}><OpenRitual /></Show>
      <HandoffOpenCard doc={DOC} source={OPEN_SOURCE} />
    </div>
  </div>
);

const PhiPlate: Component = () => (
  <div class="promo-phi">
    <div class="phi-line fs-xs">13 — 辅助与标注</div>
    <div class="phi-line fs-sm">15 — 正文默认</div>
    <div class="phi-line fs-md">17 — 小标题</div>
    <div class="phi-line fs-lg">22 — 展示</div>
    <div class="phi-chips"><span>radius 6·10·16</span><span>阴影 Fibonacci</span><span>时长 160·260ms ≈ φ</span></div>
  </div>
);

const EndCard: Component = () => (
  <div class="promo-end">
    <span class="promo-end-box"><BoxSeal /></span>
    <div class="promo-end-brand">Qaq-Harness</div>
    <div class="promo-end-sub">3.0 · 交接，像寄一封信</div>
  </div>
);

const PromoStage: Component = () => (
  <div class="promo-stage">
    <div class="promo-safe">
      <div class="promo-bezel">
        <Show when={stage() !== "black"}>
          <Show when={stage() === "a"}><AppWindow><ThreadView /></AppWindow></Show>
          <Show when={stage() === "b"}><AppWindow><BView /></AppWindow></Show>
          <Show when={stage() === "phi"}><AppWindow><PhiPlate /></AppWindow></Show>
          <Show when={stage() === "end"}><EndCard /></Show>
        </Show>
      </div>
      <Show when={cover() || stage() === "black"}><div class="promo-cover" /></Show>
      <Show when={caption() !== "" && !cover()}>
        <div class={{ "promo-caption": true, show: true }}>{caption()}</div>
      </Show>
      <Show when={flyOn()}><FlyGhost /></Show>
      <div class="promo-brand-corner">Qaq-Harness 3.0 · 演示录屏</div>
    </div>
  </div>
);

render(() => <PromoStage />, document.getElementById("root")!);
