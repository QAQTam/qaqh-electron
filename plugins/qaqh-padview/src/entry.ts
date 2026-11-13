/**
 * QAQ 插件 #3：手柄映射图（live gamepad diagram）。
 *
 * 纯 DOM + SVG，无框架、无外部 import（plugins-watch 不做 bundle）。输入走宿主
 * facade 的 gamepadRaw——每帧把 buttons/axes 直接写进 SVG 元素属性，无中间状态。
 * 布局按 W3C standard mapping 编号：0=A/底部、12-15=D-pad、6/7=扳机(按 value 缩放)。
 * 键帽字形按手柄族切换(xbox: A/B/X/Y，playstation: ✕◯□△)，与核心的 prompt 分族同判据。
 */
interface PluginHost {
  gamepadRaw?: (onFrame: (pad: Gamepad | null) => void) => () => void;
}

const OPEN_KEY = "qaqh.padview.open";
const GLYPHS: Record<string, string[]> = {
  xbox: ["A", "B", "X", "Y"],
  playstation: ["✕", "◯", "□", "△"],
  generic: ["1", "2", "3", "4"],
};

function familyOf(id: string): "xbox" | "playstation" | "generic" {
  const v = id.toLowerCase();
  if (/dualsense|dualshock|playstation|sony|054c/.test(v)) return "playstation";
  if (/xbox|xinput|045e/.test(v)) return "xbox";
  return "generic";
}

const SVG = `
<svg viewBox="0 0 640 232" xmlns="http://www.w3.org/2000/svg">
  <path class="body" d="M120 60 C60 60 30 110 24 158 C18 204 44 222 74 214 C100 207 112 186 132 176 L508 176 C528 186 540 207 566 214 C596 222 622 204 616 158 C610 110 580 60 520 60 Z"/>
  <text class="cap pv-lb">LB</text><text class="cap pv-rb">RB</text>
  <rect class="shoulder" data-el="btn4" x="120" y="24" width="72" height="22" rx="10"/>
  <rect class="shoulder" data-el="btn5" x="448" y="24" width="72" height="22" rx="10"/>
  <rect class="trigger" data-el="btn6" x="120" y="4" width="72" height="16" rx="7"/>
  <rect class="trigger" data-el="btn7" x="448" y="4" width="72" height="16" rx="7"/>
  <circle class="stick-base" cx="170" cy="106" r="30"/>
  <circle class="stick-thumb" data-el="ls" cx="170" cy="106" r="17"/>
  <circle class="stick-ring" data-el="btn10" cx="170" cy="106" r="30"/>
  <circle class="stick-base" cx="470" cy="150" r="30"/>
  <circle class="stick-thumb" data-el="rs" cx="470" cy="150" r="17"/>
  <circle class="stick-ring" data-el="btn11" cx="470" cy="150" r="30"/>
  <g data-el="dpad">
    <rect class="pad" data-el="btn12" x="150" y="138" width="16" height="26" rx="4" transform="translate(0,-8)"/>
    <rect class="pad" data-el="btn13" x="150" y="172" width="16" height="26" rx="4" transform="translate(0,8)"/>
    <rect class="pad" data-el="btn14" x="128" y="157" width="26" height="16" rx="4" transform="translate(-8,0)"/>
    <rect class="pad" data-el="btn15" x="162" y="157" width="26" height="16" rx="4" transform="translate(8,0)"/>
  </g>
  <g class="face"><circle data-el="btn0" cx="545" cy="140" r="14"/><text class="fg" data-glyph="0" y="145" x="545"></text></g>
  <g class="face"><circle data-el="btn1" cx="569" cy="116" r="14"/><text class="fg" data-glyph="1" y="121" x="569"></text></g>
  <g class="face"><circle data-el="btn2" cx="521" cy="116" r="14"/><text class="fg" data-glyph="2" y="121" x="521"></text></g>
  <g class="face"><circle data-el="btn3" cx="545" cy="92" r="14"/><text class="fg" data-glyph="3" y="97" x="545"></text></g>
  <rect class="tiny" data-el="btn8" x="280" y="112" width="20" height="12" rx="4"/>
  <rect class="tiny" data-el="btn9" x="340" y="112" width="20" height="12" rx="4"/>
  <circle class="guide" data-el="btn16" cx="320" cy="82" r="12"/>
  <text class="hint" x="290" y="150">⌾</text>
</svg>`;

const CSS = `
[data-qaqh-plugin="qaqh-padview"] .pv-fab{position:fixed;right:14px;bottom:14px;pointer-events:auto;width:34px;height:34px;border-radius:50%;border:1px solid var(--surface-2,#333);background:var(--surface-1,#1b1b1f);color:var(--muted,#888);font-size:15px;cursor:pointer;z-index:2147483001;}
[data-qaqh-plugin="qaqh-padview"] .pv-fab.on{color:var(--accent,#7aa2f7);border-color:var(--accent,#7aa2f7);}
[data-qaqh-plugin="qaqh-padview"] .pv-card{position:fixed;right:14px;bottom:56px;pointer-events:none;width:340px;padding:10px 12px 8px;border-radius:12px;border:1px solid var(--surface-2,#333);background:color-mix(in srgb, var(--surface-1,#1b1b1f) 88%, transparent);box-shadow:0 8px 28px rgba(0,0,0,.35);}
[data-qaqh-plugin="qaqh-padview"] .pv-card[hidden]{display:none;}
[data-qaqh-plugin="qaqh-padview"] .pv-meta{font:11px system-ui;color:var(--muted,#888);display:flex;justify-content:space-between;gap:8px;}
[data-qaqh-plugin="qaqh-padview"] .pv-meta b{color:var(--fg,#ddd);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-qaqh-plugin="qaqh-padview"] svg{width:100%;display:block;color:var(--fg,#ddd);}
[data-qaqh-plugin="qaqh-padview"] .body{fill:none;stroke:currentColor;stroke-width:2;opacity:.55;}
[data-qaqh-plugin="qaqh-padview"] .pv-lb{transform:translate(122px,39px);font:10px system-ui;}
[data-qaqh-plugin="qaqh-padview"] .pv-rb{transform:translate(450px,39px);font:10px system-ui;}
[data-qaqh-plugin="qaqh-padview"] .stick-base,.pad,.face circle,.tiny,.guide{fill:none;stroke:currentColor;stroke-width:1.6;}
[data-qaqh-plugin="qaqh-padview"] .stick-thumb{fill:currentColor;opacity:.7;}
[data-qaqh-plugin="qaqh-padview"] .stick-ring{fill:none;stroke:transparent;stroke-width:3;}
[data-qaqh-plugin="qaqh-padview"] .shoulder,.trigger{fill:currentColor;opacity:.12;}
[data-qaqh-plugin="qaqh-padview"] .cap{fill:currentColor;opacity:.6;}
[data-qaqh-plugin="qaqh-padview"] .fg{fill:currentColor;font:11px system-ui;text-anchor:middle;}
[data-qaqh-plugin="qaqh-padview"] .hint{fill:currentColor;opacity:.35;}
[data-qaqh-plugin="qaqh-padview"] .down{fill:var(--accent,#7aa2f7)!important;stroke:var(--accent,#7aa2f7)!important;opacity:1!important;}
[data-qaqh-plugin="qaqh-padview"] svg.off{opacity:.28;}
`;

export default {
  mount(container: HTMLElement, host: PluginHost): () => void {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);

    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "pv-fab";
    fab.title = "手柄映射图";
    fab.textContent = "🎮";
    const card = document.createElement("div");
    card.className = "pv-card";
    card.innerHTML = `<div class="pv-meta"><b data-el="name">未连接手柄</b><span data-el="map"></span></div>${SVG}`;
    container.append(fab, card);

    let open = false;
    try { open = localStorage.getItem(OPEN_KEY) === "1"; } catch { /* 存不下就用默认关 */ }
    const applyOpen = (): void => {
      card.hidden = !open;
      fab.classList.toggle("on", open);
    };
    applyOpen();
    const onFab = (): void => {
      open = !open;
      applyOpen();
      try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* 同上 */ }
    };
    fab.addEventListener("click", onFab);

    const els = new Map<string, SVGElement>();
    for (const el of card.querySelectorAll<SVGElement>("[data-el]")) els.set(el.getAttribute("data-el") ?? "", el);
    const nameEl = card.querySelector<HTMLElement>("[data-el=name]");
    const mapEl = card.querySelector<HTMLElement>("[data-el=map]");
    const svg = card.querySelector("svg");
    const triggers = { lb: els.get("btn4"), rb: els.get("btn5"), lt: els.get("btn6"), rt: els.get("btn7") };
    let faceFamily = "";

    const setDown = (key: string, on: boolean): void => {
      const el = els.get(key);
      if (el != null) el.classList.toggle("down", on);
    };

    const unsub = host.gamepadRaw?.((pad) => {
      if (svg != null) svg.classList.toggle("off", pad == null);
      if (pad == null) {
        if (nameEl != null && nameEl.textContent !== "未连接手柄") nameEl.textContent = "未连接手柄";
        if (mapEl != null) mapEl.textContent = "";
        for (let i = 0; i < 17; i += 1) setDown(`btn${i}`, false);
        return;
      }
      const family = familyOf(pad.id);
      if (faceFamily !== family) {
        faceFamily = family;
        const glyphs = GLYPHS[family] ?? GLYPHS.generic;
        // FACE 顺序 0,1,2,3 = 底/右/左/上 = A/B/X/Y
        for (const label of card.querySelectorAll<SVGTextElement>("[data-glyph]")) {
          label.textContent = glyphs[Number(label.getAttribute("data-glyph"))] ?? "";
        }
        if (nameEl != null) nameEl.textContent = pad.id.slice(0, 42);
      }
      if (mapEl != null) mapEl.textContent = `${pad.mapping} · ${pad.buttons.length}键`;
      for (let i = 0; i < Math.min(17, pad.buttons.length); i += 1) {
        setDown(`btn${i}`, pad.buttons[i]!.pressed);
      }
      const axis = (i: number): number => pad.axes[i] ?? 0;
      const move = (key: string, x: number, y: number): void => {
        els.get(key)?.setAttribute("transform", `translate(${(x * 16).toFixed(1)},${(y * 16).toFixed(1)})`);
      };
      move("ls", axis(0), axis(1));
      move("rs", axis(2), axis(3));
      const scale = (el: SVGElement | undefined, value: number, x: number): void => {
        if (el == null) return;
        const h = 4 + value * 14;
        el.setAttribute("y", String(20 - h));
        el.setAttribute("height", String(h));
        el.setAttribute("x", String(x));
        el.classList.toggle("down", value > 0.5);
      };
      scale(triggers.lt, pad.buttons[6]?.value ?? 0, 120);
      scale(triggers.rt, pad.buttons[7]?.value ?? 0, 448);
    }) ?? (() => undefined);

    return () => {
      unsub();
      fab.removeEventListener("click", onFab);
      card.remove();
      fab.remove();
      style.remove();
    };
  },
};
