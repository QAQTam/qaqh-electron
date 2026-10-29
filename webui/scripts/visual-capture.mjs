/**
 * Capture repeatable visual-review screenshots from the dev-only stress fixture.
 *
 * Usage:
 *   pnpm exec vite --host 127.0.0.1
 *   pnpm exec node scripts/visual-capture.mjs
 *
 * Output defaults to artifacts/ui-visual-review. Override with QAQH_VISUAL_OUT.
 */
import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_VISUAL_CDP_PORT ?? "9334");
const BASE = process.env.QAQH_VISUAL_URL ?? "http://127.0.0.1:5173/stress.html";
const OUT = resolve(process.env.QAQH_VISUAL_OUT ?? "artifacts/ui-visual-review");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
/** 单场景护栏:CDP 对端崩溃时 send 可能永不返回,把挂死变成响亮失败(实测 exit 13)。 */
const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: capture timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/** Edge + CDP 连接:崩溃后可整体重建(重试护栏用)。cdp 的三个字段是可变的。 */
let child;
const cdp = { socket: null, send: null, evaluate: null };
const killStale = () => {
  // 模式不以连字符开头,避免被 pkill 当作选项;无匹配时 pkill 退出码 1,吞掉即可。
  try { execSync(`pkill -f "remote.debugging.port=${PORT}"`); } catch { /* 无残留即成功 */ }
};

async function spawnEdgeAndConnect() {
  killStale();
  child = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-visual-"))}`,
      "--window-size=1280,900",
      "--no-first-run",
      "--disable-extensions",
      "--disable-sync",
      "--no-default-browser-check",
      // 低内存护栏曾试过 --disable-gpu/--disable-dev-shm-usage:在这台 Edge 上
      // 会让 CDP 连接静默挂死(实测),故不采用;OOM 场景靠重试护栏兜底。
      `${BASE}?view=settings&theme=light&material=solid`,
    ],
    { stdio: "ignore" },
  );

  let target;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
      target = pages.find((page) => page.type === "page" && page.url.startsWith(BASE));
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* Edge is still starting. */
    }
    await delay(250);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`CDP page not found for ${BASE}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  cdp.socket = socket;
  cdp.send = send;
  cdp.evaluate = evaluate;
}

await spawnEdgeAndConnect();

async function waitForFixture(view) {
  const selector = view === "settings" ? ".settings-page .settings-section" : view === "tools" ? ".tools-page" : view === "messages" ? "#messages .turn" : "#approval-slot .card";
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const ready = await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})) && document.fonts.status === "loaded"`);
    if (ready) {
      await delay(250);
      return;
    }
    await delay(150);
  }
  throw new Error(`Visual fixture did not become ready: ${view}`);
}

async function clickTodo() {
  const point = await cdp.evaluate(`(() => {
    const button = document.querySelector('.workspace-panel-head'), r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Todo header is not pointer-accessible');
    return { x, y };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function capture(name, { view, theme, material, width, height, section, closed = false, scale = 1, reduced = false, typography = false, pending = false, contextMenu = false, shellMenu = false, sidebarDrawer = false, railDrawer = false, sidebarResize = false } ) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  const url = `${BASE}?view=${view}&theme=${theme}&material=${material}${pending ? "&pending=1" : ""}${sidebarDrawer ? "&sidebarDrawer=1" : ""}${railDrawer ? "&railDrawer=1" : ""}`;
  await cdp.send("Page.navigate", { url });
  await waitForFixture(view);
  // 阶段5:抽屉态断言——遮罩在、面板覆盖层就位、不出横向滚动。
  if (sidebarDrawer) {
    const ok = await cdp.evaluate("(() => { const el = document.querySelector('.app-sidebar.drawer.open'); return el != null && getComputedStyle(el).display !== 'none'; })()");
    if (!ok) throw new Error(`${name}: sidebar drawer did not open`);
  }
  // 侧栏拖拽调宽(用户侧需求):真实鼠标拖拽 → 宽度生效;拖到阈值下 → 等效汉堡收回。
  if (sidebarResize) {
    const edgePoint = () => cdp.evaluate(`(() => {
      const el = document.querySelector('.app-sidebar-resizer');
      if (el == null) throw new Error('resizer missing');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200) };
    })()`);
    const dragEdge = async (dx) => {
      const p = await edgePoint();
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 10; step++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x + Math.round((dx * step) / 10), y: p.y, button: "left", buttons: 1 });
        await delay(16);
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x + dx, y: p.y, button: "left", clickCount: 1 });
    };
    await dragEdge(100);
    await delay(350); // 轨道过渡(--dur-layout 220ms)播完再量
    const wide = await cdp.evaluate(`(() => {
      const app = document.getElementById('app');
      const side = document.getElementById('app-sidebar').getBoundingClientRect();
      return { cssVar: app.style.getPropertyValue('--sidebar-width').trim(), width: Math.round(side.width), collapsed: app.classList.contains('sidebar-collapsed') };
    })()`);
    if (wide.cssVar !== "388px" || Math.abs(wide.width - 388) > 2 || wide.collapsed) {
      throw new Error(`${name}: sidebar drag resize failed ${JSON.stringify(wide)}`);
    }
    await dragEdge(-170); // 388 - 170 = 218 ∈ [200, 224):低于收回阈值,且未被 MIN=200 夹持
    await delay(400);
    const narrow = await cdp.evaluate(`(() => {
      const app = document.getElementById('app');
      const side = document.getElementById('app-sidebar').getBoundingClientRect();
      return { width: Math.round(side.width), collapsed: app.classList.contains('sidebar-collapsed') };
    })()`);
    if (!narrow.collapsed || narrow.width !== 48) {
      throw new Error(`${name}: drag below collapse threshold must collapse to 48px ${JSON.stringify(narrow)}`);
    }
    // 收回后再用汉堡展开:恢复到记忆宽度(218px),不是默认 288。
    const menu = await cdp.evaluate(`(() => { const b = document.querySelector('.titlebar-menu'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: menu.x, y: menu.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: menu.x, y: menu.y, button: "left", clickCount: 1 });
    await delay(400);
    const restored = await cdp.evaluate(`(() => {
      const app = document.getElementById('app');
      const side = document.getElementById('app-sidebar').getBoundingClientRect();
      return { cssVar: app.style.getPropertyValue('--sidebar-width').trim(), width: Math.round(side.width), collapsed: app.classList.contains('sidebar-collapsed') };
    })()`);
    if (restored.collapsed || restored.cssVar !== "218px" || Math.abs(restored.width - 218) > 2) {
      throw new Error(`${name}: re-expand must restore remembered width ${JSON.stringify(restored)}`);
    }
    console.log(`${name}: sidebar resize ok (388px → collapse → restore 218px)`);
  }
  if (railDrawer) {
    const ok = await cdp.evaluate("(() => { const el = document.querySelector('.workspace-panel.drawer'); return el != null && getComputedStyle(el).display !== 'none'; })()");
    if (!ok) throw new Error(`${name}: rail drawer did not open`);
    if (await cdp.evaluate("document.documentElement.scrollWidth > innerWidth")) {
      throw new Error(`${name}: rail drawer caused horizontal overflow`);
    }
  }
  if (scale !== 1) await cdp.evaluate(`document.documentElement.style.zoom = ${scale}`);
  if (view === "messages") {
    if (await cdp.evaluate("Boolean(document.querySelector('.session-capsule'))")) throw new Error('Future Goal capsule must not render');
    // Local fixture only: exercise every task state without contacting the daemon.
    await cdp.evaluate(`window.__stress.store.todos[1]([
      { title: '统一布局与内容对齐', status: 'completed' },
      { title: '收敛圆角、字体与表面层级', status: 'completed' },
      { title: '检查亮暗主题与动效细节', status: 'in_progress' },
      { title: '验证窄窗口、长文本与键盘操作', status: 'pending' }
    ])`);
    await delay(300);
    if (typography) await cdp.evaluate(`(async () => {
      const { renderMarkdownHtml } = await import('/src/markdown/render.ts');
      const tick = String.fromCharCode(96);
      const source = ['# Markdown 排版基准', '正文采用 GitHub Primer 的 16px / 24px。**强调不改变字号**，中途回复与最终回答一致。',
        '## 二级标题 · 24px', '### 三级标题 · 20px', '#### 四级标题 · 16px', '##### 五级标题 · 14px', '###### 六级标题 · 13.6px',
        '- 列表继承正文尺寸，不单独缩小。\\n- 行内代码 ' + tick + 'session_id' + tick + ' 使用 85%。',
        '> 引用保留正文尺寸，使用边线与次级颜色。',
        '    const session = { ready: true };\\n    console.log(session);',
        '| 内容 | 字号 | 行高 |\\n| --- | --- | --- |\\n| 正文 | 16px | 24px |\\n| 代码 | 13.6px | 19.72px |'].join('\\n\\n');
      const messages = document.querySelector('#messages');
      messages.innerHTML = '<section class="turn"><div class="turn-answer"><div class="md-host"></div></div></section>';
      messages.querySelector('.md-host').innerHTML = renderMarkdownHtml(source); messages.scrollTop = 0;
    })()`);
    if (closed) await clickTodo();
    await delay(300);
    const geometry = await cdp.evaluate(`(() => {
      const turn = document.querySelector('#messages .turn');
      const composer = document.querySelector('.composer-surface');
      const messages = document.querySelector('#messages');
      const panel = document.querySelector('.workspace-panel');
      const surface = document.querySelector('.workspace-panel-surface');
      const head = document.querySelector('.workspace-panel-head');
      const body = document.querySelector('.workspace-panel-body');
      const a = turn.getBoundingClientRect(), b = composer.getBoundingClientRect();
      const m = messages.getBoundingClientRect();
      // 抽屉未挂载(cols≥2 且未开抽屉)时,列 dock 断言整体跳过,只保留正文对齐。
      if (panel == null || surface == null || head == null || body == null) {
        return { leftDelta: Math.abs(a.left - b.left), rightDelta: Math.abs(a.right - b.right), messageWidth: a.width, messagesWidth: m.width, composerWidth: b.width, panelHeight: 0, panelDocked: true, bodyBelowHeader: true, overflow: document.documentElement.scrollWidth > innerWidth, panelOpen: false, panelHidden: true, noOverlap: true, identityBelowSurface: true, identityAligned: true, profileChip: true };
      }
      const p = surface.getBoundingClientRect();
      const h = head.getBoundingClientRect(), c = body.getBoundingClientRect();
      // 身份行(§1.5):在表面外下方、与表面同宽;profile chip 必须在动作行里。
      const id = document.querySelector('.composer-identity');
      const i = id == null ? null : id.getBoundingClientRect();
      const panelOpen = !panel.classList.contains('collapsed');
      const panelHidden = getComputedStyle(panel).display === 'none';
      const hasIdentity = i != null;
      const dock = document.querySelector('.session-column').getBoundingClientRect();
      return { leftDelta: Math.abs(a.left - b.left), rightDelta: Math.abs(a.right - b.right), messageWidth: a.width, messagesWidth: m.width, composerWidth: b.width, panelHeight: p.height, panelDocked: Math.abs(p.top - dock.top) <= 2 && Math.abs(p.bottom - dock.bottom) <= 2, bodyBelowHeader: !panelOpen || c.top >= h.bottom - 1, overflow: document.documentElement.scrollWidth > innerWidth, panelOpen, panelHidden, noOverlap: p.left >= m.right - 1, identityBelowSurface: !hasIdentity || i.top >= b.bottom - 1, identityAligned: !hasIdentity || (Math.abs(i.left - b.left) <= 2 && Math.abs(i.right - b.right) <= 2), profileChip: !hasIdentity || document.querySelector('.composer-profile-button') != null };
    })()`);
    // 阶段5 断言语义:列态验 dock/推挤;抽屉态验覆盖层就位(它本来就覆盖正文,
    // noOverlap/bodyBelowHeader 不适用);抽屉未挂载只验正文对齐/溢出。
    const panelDrawer = await cdp.evaluate("document.querySelector('.workspace-panel')?.classList.contains('drawer') === true");
    const panelFail = geometry.panelHidden || panelDrawer
      ? false
      : (!geometry.noOverlap || !geometry.bodyBelowHeader || !geometry.panelDocked);
    if (geometry.leftDelta > 2 || geometry.rightDelta > 2 || geometry.overflow || panelFail
      || !geometry.identityBelowSurface || !geometry.identityAligned || !geometry.profileChip) {
      throw new Error(`${name}: alignment failed ${JSON.stringify(geometry)}`);
    }
    // 收合/回弹只对列态右栏有意义;抽屉态由 App 控制挂载,不在此流里。
    if (closed && !geometry.panelHidden) {
      // Refresh the local snapshot while collapsed: the same header must survive.
      await cdp.evaluate("window.__stress.store.todos[1](window.__stress.store.todos[0]().map(item => ({ ...item })))");
      await delay(50);
      await clickTodo();
      // 右栏是真实列:展开必须推窄消息列,但绝不能盖住它;正文与输入框始终同宽。
      const motion = await cdp.evaluate(`new Promise(resolve => {
        const started = performance.now(); let worst = 0; let frames = 0, maxPanelHeight = 0, minMessagesWidth = Infinity, overlapped = false;
        function sample() {
          const a = document.querySelector('#messages .turn').getBoundingClientRect();
          const b = document.querySelector('.composer-surface').getBoundingClientRect();
          const m = document.querySelector('#messages').getBoundingClientRect();
          const surface = document.querySelector('.workspace-panel-surface').getBoundingClientRect();
          worst = Math.max(worst, Math.abs(a.left - b.left), Math.abs(a.right - b.right));
          minMessagesWidth = Math.min(minMessagesWidth, m.width);
          overlapped = overlapped || surface.left < m.right - 1;
          maxPanelHeight = Math.max(maxPanelHeight, surface.height); frames++;
          if (performance.now() - started < 300) requestAnimationFrame(sample);
          else resolve({ worst, frames, closedPanelHeight: ${geometry.panelHeight}, maxPanelHeight, minMessagesWidth, collapsedMessagesWidth: ${geometry.messagesWidth}, overlapped });
        }
        requestAnimationFrame(sample);
      })`);
      if (motion.worst > 2 || motion.overlapped || Math.abs(motion.maxPanelHeight - motion.closedPanelHeight) > 2 || motion.minMessagesWidth >= motion.collapsedMessagesWidth - 1) {
        throw new Error(`${name}: docked rail must push (never cover) the message column and keep its full height ${JSON.stringify(motion)}`);
      }
      console.log(`${name}: motion ${JSON.stringify(motion)}`);
      if (!await cdp.evaluate("!document.querySelector('.workspace-panel').classList.contains('collapsed')")) throw new Error(`${name}: workspace rail did not reopen`);
      // Keyboard toggle follows the same control, without a page reload.
      await cdp.evaluate("document.querySelector('.workspace-panel-head').focus()");
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await delay(300);
      if (await cdp.evaluate("!document.querySelector('.workspace-panel').classList.contains('collapsed')")) throw new Error(`${name}: keyboard collapse failed`);
    }
    console.log(`${name}: aligned ${JSON.stringify(geometry)}`);
    // 待响应弹卡(§6.2):夹具给前几条会话铺了三种待人态(`?pending=1`)。这里验
    // 三件真实引擎才知道的事——卡片渲染出来了、跑马灯的「半轨宽度」量测非零
    // (量为 0 时轨道静止,动画看起来像坏了,而 jsdom 测不出来)、相位机真的
    // 从 in 走进了 hold(animationend 没接上时卡片会停在入场终态上)。
    if (pending) {
      const cards = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('.session-pending')];
        return {
          kinds: cards.map((card) => card.dataset.kind).sort(),
          // 相位机真的走完了一圈:入场动画结束的 animationend 把 in 推到了 hold。
          // 引擎里动画名写错/被裁掉时,这里会停在 in——比肉眼看截图可靠。
          phases: cards.map((card) => card.dataset.phase),
          animations: cards.map((card) => getComputedStyle(card.querySelector('.session-pending-body')).animationName),
          // 呼吸落在 ::before 上(动 opacity,不动 box-shadow):这张卡会挂几分钟,
          // 每帧重绘阴影是不可接受的常驻成本。
          breaths: cards.map((card) => getComputedStyle(card.querySelector('.session-pending-body'), '::before').animationName),
          travels: cards.map((card) => {
            const track = card.querySelector('.session-pending-track');
            return Number(getComputedStyle(track).getPropertyValue('--mq-travel').replace('px', '')) || 0;
          }),
          coversRow: cards.every((card) => {
            const row = card.closest('.message-session-row');
            const box = card.getBoundingClientRect();
            const item = row.querySelector('.message-session-item').getBoundingClientRect();
            // inset:0 的绝对定位盒对齐的是会话按钮的 padding box(不含它自己
            // 那 1px 透明边框),所以留 3px 容差;要的是「铺满整行」而不是像素级同框。
            return Math.abs(box.width - item.width) <= 3 && Math.abs(box.height - item.height) <= 3;
          }),
        };
      })()`);
      if (cards.kinds.join(",") !== "ask,permission,plan") {
        throw new Error(`${name}: pending cards missing ${JSON.stringify(cards)}`);
      }
      if (!cards.coversRow) throw new Error(`${name}: pending card must cover the whole session row ${JSON.stringify(cards)}`);
      if (!reduced && cards.travels.some((travel) => travel <= 0)) {
        throw new Error(`${name}: marquee half-track must be measured ${JSON.stringify(cards)}`);
      }
      // 相位机:入场必须已经播完并转进 hold(呼吸),否则说明 animationend 没接上,
      // 卡片会一直停在 in 的 both 终态上(看起来像静止,其实动画链断了)。
      if (!reduced && cards.phases.some((phase) => phase !== "hold")) {
        throw new Error(`${name}: slide-in must settle into hold ${JSON.stringify(cards)}`);
      }
      if (!reduced && !cards.breaths.every((animation) => animation === "session-pending-breathe")) {
        throw new Error(`${name}: hold phase must breathe ${JSON.stringify(cards)}`);
      }
      if (reduced && cards.breaths.some((animation) => animation !== "none")) {
        throw new Error(`${name}: reduced motion must stop the breathe glow ${JSON.stringify(cards)}`);
      }
      if (reduced && cards.animations.some((animation) => animation !== "none")) {
        throw new Error(`${name}: reduced motion must stop every card animation ${JSON.stringify(cards)}`);
      }
      console.log(`${name}: pending ${JSON.stringify(cards)}`);
    }
    // BUG-2026-10-28 回归:右键菜单曾被「任意 scroll 一律关闭」误伤——流式输出的
    // 跟随尾部是程序化滚动,把用户在旧消息上打开的菜单连续刷掉。现在滚动不关闭
    // (菜单位于视口坐标,与原生菜单一致);resize/外点/Escape 仍关闭。
    if (contextMenu) {
      await cdp.evaluate(`(() => {
        const turn = document.querySelector('#messages .turn');
        const pre = document.createElement('pre');
        pre.textContent = 'const regression = "menu survives programmatic scroll";';
        turn.appendChild(pre);
        const rect = pre.getBoundingClientRect();
        pre.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 10 }));
      })()`);
      await delay(200);
      if (!await cdp.evaluate("document.querySelector('.context-menu') != null")) {
        throw new Error(`${name}: context menu did not open`);
      }
      await cdp.evaluate("(() => { const m = document.querySelector('#messages'); m.scrollTop += 120; })()");
      await delay(150);
      if (!await cdp.evaluate("document.querySelector('.context-menu') != null")) {
        throw new Error(`${name}: context menu closed by programmatic scroll (stream follow)`);
      }
      await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await delay(120);
      if (await cdp.evaluate("document.querySelector('.context-menu') != null")) {
        throw new Error(`${name}: Escape did not close the context menu`);
      }
      await cdp.evaluate(`(() => { document.querySelector('#messages .turn pre:last-child')?.remove(); })()`);
      console.log(`${name}: context menu survives scroll`);
    }
    // 阶段1(spec §5.5):壳层 ⋯ 菜单必须包含模型两项/设置/关于/退出,键盘可关。
    if (shellMenu) {
      await cdp.evaluate("document.querySelector('.titlebar-more')?.click()");
      await delay(200);
      const menu = await cdp.evaluate(`(() => {
        const menu = document.querySelector('.context-menu');
        if (menu == null) return null;
        return [...menu.querySelectorAll('.context-menu-label')].map((el) => el.textContent);
      })()`);
      const required = ["选择新会话默认模型…", "更改当前会话模型…", "设置…", "关于 QAQ-Harness", "退出…"];
      const missing = required.filter((label) => !Array.isArray(menu) || !menu.includes(label));
      if (missing.length > 0) throw new Error(`${name}: shell menu missing ${JSON.stringify({ missing, menu })}`);
      await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await delay(120);
      if (await cdp.evaluate("document.querySelector('.context-menu') != null")) {
        throw new Error(`${name}: Escape did not close the shell menu`);
      }
      console.log(`${name}: shell menu complete (${required.length} entries)`);
    }
  }
  if (section) {
    // 按 data-section-id 点，不按位置索引：设置分区一增删，索引版就静默拍错分区
    // （pairing 曾经在第 6 项）。
    await cdp.evaluate(
      `document.querySelector('.settings-nav-item[data-section-id=${JSON.stringify(section)}]')?.click()`,
    );
    await delay(300);
  }
  // 截图单独 30s 护栏:OOM 压力下 captureScreenshot 可能挂死,丢截图但不能丢断言。
  let shot;
  try {
    shot = await withTimeout(cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }), 30_000, `${name}: screenshot`);
  } catch (error) {
    console.error(`${name}: screenshot skipped (${error.message})`);
  }
  if (shot != null) {
    mkdirSync(OUT, { recursive: true });
    const path = join(OUT, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    console.log(`${path} (${width}x${height})`);
  } else {
    console.log(`${name}: (screenshot unavailable this run)`);
  }
}

try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const scenarios = [
    ["markdown-primer-light", { view: "messages", theme: "light", material: "solid", width: 1920, height: 1080, typography: true, closed: true }],
    ["markdown-primer-dark", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 1000, typography: true, closed: true }],
    ["messages-light-desktop", { view: "messages", theme: "light", material: "glass", width: 1920, height: 1080 }],
    ["messages-light-dock-closed", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, closed: true }],
    ["messages-dark-desktop", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 900 }],
    ["messages-light-1024", { view: "messages", theme: "light", material: "solid", width: 1024, height: 768 }],
    ["messages-dark-800", { view: "messages", theme: "dark", material: "solid", width: 800, height: 600 }],
    ["messages-light-640", { view: "messages", theme: "light", material: "solid", width: 640, height: 480 }],
    ["messages-dark-narrow", { view: "messages", theme: "dark", material: "glass", width: 480, height: 640 }],
    ["messages-light-125pct", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, scale: 1.25 }],
    ["messages-dark-150pct", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 900, scale: 1.5 }],
    ["messages-reduced-motion", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, reduced: true, closed: true, pending: true }],
    // 侧栏待响应卡(§6.2):浅/深各一张,另有 reduced-motion 那张验「动画全停」。
    ["sidebar-pending-light", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, pending: true }],
    ["sidebar-pending-dark", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 900, pending: true }],
    ["sidebar-pending-640", { view: "messages", theme: "light", material: "solid", width: 640, height: 480, pending: true, sidebarDrawer: true }],
    // 阶段5:抽屉态——右栏抽屉(1024,两列)与侧栏抽屉(640,单列)。
    ["rail-drawer-1024", { view: "messages", theme: "dark", material: "solid", width: 1024, height: 800, railDrawer: true }],
    ["sidebar-drawer-640", { view: "messages", theme: "light", material: "solid", width: 640, height: 480, sidebarDrawer: true }],
    // 侧栏拖拽调宽(用户侧需求):拖宽生效;拖到阈值下等效汉堡收回;再展开恢复记忆宽度。
    ["sidebar-resize-1280", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, sidebarResize: true }],
    // BUG-2026-10-28 回归:右键菜单必须在程序化滚动(流式跟随)下存活。
    ["context-menu-stream-scroll", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 900, contextMenu: true }],
    // 阶段1(spec §5.5):壳层 ⋯ 菜单完整性。
    ["shell-menu-light", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, shellMenu: true }],
    ["settings-light-solid-desktop", { view: "settings", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["settings-dark-glass-narrow", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820 }],
    ["settings-dark-glass-narrow-pairing", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820, section: "section-pairing" }],
    ["settings-dark-glass-narrow-about", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820, section: "section-about" }],
    ["tools-light-solid-desktop", { view: "tools", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["tools-dark-solid-narrow", { view: "tools", theme: "dark", material: "solid", width: 480, height: 820 }],
    ["tools-light-solid-800x600", { view: "tools", theme: "light", material: "solid", width: 800, height: 600 }],
    ["tools-dark-solid-480x640", { view: "tools", theme: "dark", material: "solid", width: 480, height: 640 }],
    ["approval-light-solid-desktop", { view: "approval", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["approval-light-glass-desktop", { view: "approval", theme: "light", material: "glass", width: 1280, height: 900 }],
    ["approval-dark-glass-narrow", { view: "approval", theme: "dark", material: "glass", width: 480, height: 820 }],
    ["approval-dark-solid-narrow", { view: "approval", theme: "dark", material: "solid", width: 480, height: 820 }],
    ["approval-light-solid-1024x768", { view: "approval", theme: "light", material: "solid", width: 1024, height: 768 }],
    ["approval-dark-glass-800x600", { view: "approval", theme: "dark", material: "glass", width: 800, height: 600 }],
    ["approval-light-solid-640x480", { view: "approval", theme: "light", material: "solid", width: 640, height: 480 }],
    ["approval-dark-glass-480x640", { view: "approval", theme: "dark", material: "glass", width: 480, height: 640 }],
  ];
  const filter = process.env.QAQH_VISUAL_FILTER;
  // 低内存环境(本机 7.9G/swap 常 满)偶发 Edge 被挤死:每场景最多重试 2 次,
  // 间隔 3s 让系统缓口气;重试会 killStale + 整体重建 Edge/CDP。
  const attempts = Number(process.env.QAQH_VISUAL_ATTEMPTS ?? "3");
  for (const [name, options] of scenarios) {
    if (filter != null && !new RegExp(filter).test(name)) continue;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await withTimeout(capture(name, options), 120_000, name);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.error(`[retry ${attempt}/${attempts}] ${name}: ${error.message}`);
        try { cdp.socket.close(); } catch {}
        try { child.kill(); } catch {}
        killStale();
        await delay(3_000);
        // 重建 CDP(原 socket/child 已废弃):复用顶部同款连接逻辑。
        await spawnEdgeAndConnect();
      }
    }
    if (lastError != null) throw lastError;
  }
} finally {
  cdp.socket.close();
  child.kill();
}
