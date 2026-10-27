/** Real App + mock IPC layout/composer regression checks. Run after `pnpm dev`.
 * Screenshots are saved under out/layout-check for visual review.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.QAQH_LAYOUT_URL ?? "http://localhost:5173/settings-check.html";
const port = Number(process.env.QAQH_LAYOUT_CDP_PORT ?? "9335");
const output = "out/layout-check";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-layout-"))}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "about:blank",
], { stdio: "ignore" });
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()))
        .find((page) => page.type === "page");
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* Browser is starting. */ }
    await delay(200);
  }
  assert.ok(target?.webSocketDebuggerUrl, "Headless Edge must start");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    // 夹具超时:把探针与关键 DOM 一起带出来,省一轮盲猜。
    const dump = await evaluate(`(() => {
      const p = window.__composerProbe ?? null;
      return JSON.stringify({ probe: p == null ? null : { creates: p.creates, sends: p.sends.length, failCreate: p.failCreate, failSend: p.failSend },
        toasts: [...document.querySelectorAll('.toast')].map((el) => el.textContent),
        toastLog: window.__toastLog ?? null,
        panels: [...document.querySelectorAll('[id^="panel-tab-"]')].map((el) => el.id),
        composerValue: document.querySelector('#composer textarea')?.value ?? null,
        sendDisabled: document.querySelector('#composer .send')?.disabled ?? null,
        startup: Boolean(document.querySelector('.startup-container')) });
    })()`).catch(() => "(dump failed)");
    throw new Error(`Fixture did not become ready: ${expression}\nstate: ${dump}`);
  };
  const geometry = () => evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const back = document.querySelector('.titlebar-back');
    const b = back?.getBoundingClientRect();
    return { top: rect('#top'), nav: rect('.global-nav'), workspace: rect('.workspace'),
      main: rect('#main'), tools: rect('.tools-page'), settings: rect('.settings-page'),
      body: rect('.settings-body'), foot: rect('.settings-foot'),
      backVisible: b ? back.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) : null,
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
  })()`);
  const capture = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${name}.png`), Buffer.from(data, "base64"));
  };
  await send("Page.enable");
  // App reads this at module evaluation. The fixture installs its full mock before rendering.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__TAURI_INTERNALS__ = {}; document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('tauri'));" });
  for (const [width, height] of [[1566, 790], [800, 600], [480, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base });
    await waitFor("Boolean(document.querySelector('#app.tauri-shell .startup-container')) && document.fonts.status === 'loaded'");
    let g = await geometry();
    assert.ok(g.top != null, "Native messages view must render the shared titlebar");
    assert.ok(g.workspace.top >= g.top.bottom, "Messages must start below the titlebar");
    assert.ok(g.workspace.height > height - 110, "Messages must fill the shell below the titlebar");
    // Render actual Markdown inside a paint-contained turn in the actual message scroller.
    // 启动页重构后没有 #messages 容器了:临时造一个挂在 #main 里,测 Markdown 排版。
    await evaluate(`(async () => {
      const { render } = await import('/node_modules/.vite/deps/@solidjs_web.js');
      const { Markdown } = await import('/src/markdown/Markdown.tsx');
      let messages = document.querySelector('#messages');
      if (messages == null) {
        messages = document.createElement('div');
        messages.id = 'messages';
        document.querySelector('#main').append(messages);
      }
      messages.replaceChildren();
      const turn = document.createElement('section');
      turn.className = 'turn';
      messages.append(turn);
      render(() => Markdown({ text: () => '结论依据两点：\\n\\n1. **第一条序号应该完整显示。** 这是一段足够长的内容，用来验证窄屏下换行后的文字仍然与正文对齐。\\n2. 第二条序号应该完整显示。\\n\\n多位数列表：\\n\\n99. 两位数序号\\n100. 三位数序号\\n\\n- 无序列表\\n  1. 嵌套序号', streaming: false }), turn);
      await document.fonts.ready;
    })()`);
    const typography = await evaluate("(() => { const s = getComputedStyle(document.querySelector('.md-host')); return { size: s.fontSize, height: s.lineHeight }; })()");
    assert.equal(typography.size, "14px", "Markdown body must sit at the 14px Codex-parity baseline");
    assert.equal(typography.height, "24px", "Markdown body must keep the 24px line pitch decoupled from the glyph size");
    // 设置页把「全局字号缩放」写成"等比缩放界面中所有字阶",阅读区必须一起走。
    // 正文吃 --font-scale,行距靠无单位比例、标题/代码靠 em 与 85% 自己跟上;
    // 这里同时钉住"测完必须还原",否则后面的 tools/settings 步骤会带着 1.2 跑。
    const scaled = await evaluate(`(async () => {
      const root = document.documentElement, host = document.querySelector('.md-host');
      const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      root.style.setProperty('--font-scale', '1.2');
      await settle();
      const style = getComputedStyle(host);
      const atScale = { size: style.fontSize, leading: style.lineHeight };
      root.style.removeProperty('--font-scale');
      await settle();
      return { atScale, restored: getComputedStyle(host).fontSize };
    })()`);
    assert.equal(scaled.atScale.size, "16.8px", `Reading text must follow --font-scale, got ${JSON.stringify(scaled)}`);
    assert.equal(scaled.atScale.leading, "28.8px", `Line pitch must scale with the glyph, got ${JSON.stringify(scaled)}`);
    assert.equal(scaled.restored, typography.size, `Probe must leave no --font-scale residue: ${JSON.stringify(scaled)}`);
    const matrix = await evaluate(`(async () => {
      const { renderMarkdownHtml } = await import('/src/markdown/render.ts');
      const tick = String.fromCharCode(96);
      const source = ['# H1', '## H2', '### H3', '#### H4', '##### H5', '###### H6',
        '正文 **强调** ' + tick + 'inline' + tick, '    const n = 1;', '| A | B |\\n| --- | --- |\\n| 一 | 二 |'].join('\\n\\n');
      const results = [];
      for (const kind of ['turn-intermediate', 'turn-answer']) {
        const wrapper = document.createElement('div'); wrapper.className = kind;
        const probe = document.createElement('div'); probe.className = 'md-host'; probe.innerHTML = renderMarkdownHtml(source);
        wrapper.append(probe); document.querySelector('#messages').append(wrapper);
        const result = {};
        for (const selector of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'p code', 'pre', 'pre code', 'table', 'strong']) {
          const style = getComputedStyle(probe.querySelector(selector));
          result[selector] = { size: parseFloat(style.fontSize), leading: parseFloat(style.lineHeight), weight: style.fontWeight };
        }
        results.push(result); wrapper.remove();
      }
      return results;
    })()`);
    assert.deepEqual(matrix[0], matrix[1], "Intermediate and final Markdown must have identical typography");
    // 矩阵按「相对正文的比例」核，正文 px 与行距由上面两条 assert.equal 单独钉住。
    // 之前 11 个数全是 16px 基准的手算展开值，改一次字号就得重算一遍。
    const body = parseFloat(typography.size), pitch = parseFloat(typography.height);
    const heading = (ratio) => [body * ratio, body * ratio * 1.25];
    const expected = {
      h1: heading(2), h2: heading(1.5), h3: heading(1.25), h4: heading(1), h5: heading(.875), h6: heading(.85),
      p: [body, pitch], table: [body, pitch],
      // 行内代码 85% 只缩字号；line-height 是无单位数值，继承下来按自己的字号算。
      'p code': [body * .85, pitch * .85],
      pre: [body * .85, body * .85 * 1.45], 'pre code': [body * .85, body * .85 * 1.45],
    };
    for (const [selector, [size, leading]] of Object.entries(expected)) {
      assert.ok(Math.abs(matrix[0][selector].size - size) < .05, `${selector} must sit at its documented ratio of the ${body}px body: ${JSON.stringify(matrix[0][selector])}`);
      assert.ok(Math.abs(matrix[0][selector].leading - leading) < .05, `${selector} line box must be ${leading}px: ${JSON.stringify(matrix[0][selector])}`);
    }
    assert.equal(matrix[0].strong.weight, '600', "Emphasis must not alter the font size");
    assert.equal(await evaluate("document.querySelector('.session-tabs-region')"), null, "Goal capsule must remain unrendered");
    // 内容列对齐(§4):「此前已压缩」分隔线与截断提示必须和回合共用同一条居中列。
    // composer.css 里 `.compact-divider { margin: 8px 0 }` 的简写会清掉 timeline.css
    // 组规则给的 `margin-inline: auto`,只在 #messages 内容宽 > --content-width 的
    // 宽窗下才暴露(1920 下实测偏 394px),窄屏三档全都看不出差别。
    const column = await evaluate(`(() => {
      const messages = document.querySelector('#messages');
      const note = document.createElement('div'); note.className = 'history-note'; note.textContent = '对照';
      const divider = document.createElement('div'); divider.className = 'compact-divider'; divider.setAttribute('role', 'separator');
      divider.innerHTML = '<span>此前已压缩</span>';
      messages.append(note, divider);
      const edges = [...messages.querySelectorAll(':scope > .turn, :scope > .history-note, :scope > .compact-divider')]
        .map((el) => { const r = el.getBoundingClientRect(); return { cls: el.className, left: +r.left.toFixed(1), right: +r.right.toFixed(1) }; });
      note.remove(); divider.remove();
      return edges;
    })()`);
    assert.ok(column.length >= 3, `Content-column alignment needs a turn, note and divider to compare: ${JSON.stringify(column)}`);
    assert.equal(new Set(column.map((edge) => `${edge.left}/${edge.right}`)).size, 1,
      `Content-column rows must share one centered box: ${JSON.stringify(column)}`);
    const markers = await evaluate(`(() => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      return Array.from(document.querySelectorAll('.md-host ol')).map((ol) => {
        const li = ol.lastElementChild;
        const style = getComputedStyle(li);
        context.font = style.font;
        const lastNumber = Number(ol.getAttribute('start') ?? 1) + ol.children.length - 1;
        return { lastNumber, padding: parseFloat(getComputedStyle(ol).paddingLeft), markerWidth: context.measureText(lastNumber + '. ').width };
      });
    })()`);
    assert.ok(markers.length >= 2, "Exercise top-level and nested ordered lists");
    assert.ok(markers.some((marker) => marker.lastNumber === 100), "Exercise actual three-digit markers");
    for (const marker of markers) assert.ok(marker.padding + 0.1 >= marker.markerWidth, `Decimal marker must fit inside the turn: ${JSON.stringify(marker)}`);
    await capture(`messages-${width}`);

    // 按标签点,不按下标:导航项后来加了「接入」,写死的 [2] 已经指到别的页面去了。
    await evaluate("[...document.querySelectorAll('.global-nav-item')].find((n) => n.textContent.includes('工具')).click()");
    await waitFor("Boolean(document.querySelector('.tools-page'))");
    g = await geometry();
    assert.ok(g.workspace.top >= g.top.bottom, "Tools must start below the titlebar");
    assert.ok(g.workspace.bottom <= height + 1, "Tools must stay inside the window");
    assert.ok(g.main.height >= g.workspace.height - 60, "Tools content must fill the remaining height");
    assert.ok(g.tools.height > 200, "Tools must not collapse into the 56px tabs row");
    // Skills 目录(§6.5.1):两层发现范围各一组,组头常显、卡片可展开。夹具的
    // 用户级回包走宿主命令 `skills_user_scan`(settings-check.tsx 的假 invoke);
    // 旧壳没有这条命令时这一组只剩提示条,所以这里断言的是「两组都在、组头带得出
    // 发现根、展开后正文真的渲染」。
    const skills = await evaluate(`(() => {
      const groups = [...document.querySelectorAll('.skill-group')];
      const cards = [...document.querySelectorAll('.skill-card')];
      const heads = groups.map((group) => ({
        title: group.querySelector('.skill-group-head strong')?.textContent ?? '',
        hint: group.querySelector('.skill-group-hint')?.textContent ?? '',
        cards: group.querySelectorAll('.skill-card').length,
      }));
      const shadowed = document.querySelectorAll('.skill-card.is-shadowed').length;
      // 展开第一条:卡片的折叠是卸载子树,正文必须真的挂上。
      cards[0]?.querySelector('.skill-card-head')?.click();
      return { heads, shadowed, total: cards.length };
    })()`);
    assert.equal(skills.heads.length, 2, `Skills must show both scopes: ${JSON.stringify(skills)}`);
    assert.equal(skills.heads[0]?.title, "项目级");
    assert.equal(skills.heads[1]?.title, "用户级");
    assert.ok(skills.heads[0]?.hint.includes(".agents/skills"), `项目级组头要写清扫的是哪些目录: ${JSON.stringify(skills)}`);
    assert.ok(skills.heads[1]?.hint.includes("~/.agents/skills"), `用户级组头要带出发现根: ${JSON.stringify(skills)}`);
    assert.ok(skills.heads[0].cards > 0, "项目级夹具至少一条 skill");
    assert.ok(skills.heads[1].cards > 0, "用户级夹具至少一条 skill");
    assert.ok(skills.shadowed > 0, "同名覆盖要标出来,不能静默删条目");
    await waitFor("Boolean(document.querySelector('.skill-card-body .md-host'))");
    g = await geometry();
    // headless 首帧竞态:切视图后 ~100ms 内 elementFromPoint 可能命中未绘制的根节点,短暂等待重测。
    for (let attempt = 0; attempt < 60 && g.backVisible !== true; attempt++) { await delay(50); g = await geometry(); }
    assert.equal(g.backVisible, true, "Global back button must remain unobstructed");
    assert.ok(g.scrollWidth <= width, "Shell must not overflow horizontally");
    await capture(`tools-${width}`);

    await evaluate("[...document.querySelectorAll('.global-nav-item')].find((n) => n.textContent.includes('设置')).click()");
    await waitFor("Boolean(document.querySelector('.settings-section'))");
    g = await geometry();
    assert.ok(g.workspace.top >= g.top.bottom, "Settings must start below the titlebar");
    assert.ok(g.body.height > 200, "Settings form must have a usable scroll area");
    assert.ok(g.foot.bottom <= g.workspace.bottom + 1, "Settings footer must stay inside its workspace");
    for (let attempt = 0; attempt < 60 && g.backVisible !== true; attempt++) { await delay(50); g = await geometry(); }
    assert.equal(g.backVisible, true, "Settings back button must remain unobstructed");
    await capture(`settings-${width}`);
    await evaluate("document.querySelector('.titlebar-back').click()");
    await waitFor("Boolean(document.querySelector('.workspace-messages'))");
    const restored = await geometry();
    assert.ok(restored.top != null && restored.workspace.top >= restored.top.bottom, "Returning to messages must keep the shared titlebar");
    console.log(`PASS native shell ${width}x${height}: messages, list markers, tools, settings, back navigation`);
  }

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: base });
  await waitFor("Boolean(document.querySelector('#composer .send'))");
  // Override only session IPC; keep the real App, Composer, tab store and transport.
  await evaluate(`(() => {
    const internals = window.__TAURI_INTERNALS__;
    const original = internals.invoke.bind(internals);
    const probe = window.__composerProbe = { sessions: [], creates: 0, sends: [], failCreate: true, failSend: false, deferSend: false, release: null, workspaces: [], workspaceCalls: [] };
    const callbacks = new Map();
    const listeners = new Map();
    let listenerId = 0;
    const transform = internals.transformCallback.bind(internals);
    internals.transformCallback = (callback, once) => {
      const id = transform(callback, once);
      callbacks.set(id, callback);
      return id;
    };
    probe.emit = (event, payload) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    // toast 是先到先得的证据:自动消失后 MutationObserver 日志还在。
    window.__toastLog = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.toast')) {
        const text = el.textContent ?? '';
        if (window.__toastLog.at(-1) !== text) window.__toastLog.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true });
    internals.invoke = async (cmd, args = {}) => {
      if (cmd === 'plugin:event|listen') {
        const id = ++listenerId;
        listeners.set(id, { event: args.event, handler: args.handler });
        return id;
      }
      if (cmd === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null; }
      if (cmd === 'session_list') return structuredClone(probe.sessions);
      if (cmd === 'create_session') {
        probe.creates++;
        if (probe.failCreate) throw new Error('fixture create failure');
        probe.sessions.push({ session_id: 'composer-' + probe.creates, title: '对话 ' + probe.creates });
        return { status: 'accepted' };
      }
      if (cmd === 'timeline_status') return { status: 'open', session_id: args.seed };
      if (cmd === 'session_bootstrap') return { control: { state: { activity: 'idle' } } };
      if (cmd === 'pending_approvals') return [];
      if (cmd === 'send_message') {
        probe.sends.push({ seed: args.seed, text: args.text });
        if (probe.failSend) throw new Error('fixture send failure');
        if (probe.deferSend) await new Promise(resolve => { probe.release = resolve; });
        return { status: 'accepted' };
      }
      if (cmd === 'service_rpc') {
        // 工作区名录 + 两个组织写面(归属只活在桩里,断言看调用参数与分组结果)。
        if (args.method === 'workspace.list') return structuredClone(probe.workspaces);
        if (args.method === 'workspace.move_session' || args.method === 'workspace.detach') {
          probe.workspaceCalls.push({ method: args.method, params: args.params });
          const target = probe.sessions.find((session) => session.session_id === args.params.session_id);
          if (target != null) target.workspace_id = args.method === 'workspace.detach' ? null : args.params.workspace_id;
          return null;
        }
      }
      return original(cmd, args);
    };
  })()`);
  const typeDraft = async (text) => {
    await evaluate("document.querySelector('#composer textarea').focus(); document.querySelector('#composer textarea').select()");
    await send("Input.insertText", { text });
    await waitFor(`document.querySelector('#composer textarea').value === ${JSON.stringify(text)}`);
  };
  const clickSend = () => evaluate("document.querySelector('#composer .send').click()");
  const key = (key, options = "") => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, ${options} }))`);

  assert.equal(await evaluate("document.querySelector('.message-create').disabled"), false, "Session list must expose an enabled create action");
  await capture("composer-empty-shell");
  // 启动页重构后空态按钮没了:StartupView 的发送键就是「建会话+发首条消息」的原子提交。
  await typeDraft("你好，先写草稿再新建对话");
  await evaluate("document.querySelector('#composer .send').click()");
  await waitFor("Boolean(document.querySelector('.toast.err')) && !document.querySelector('#composer .send').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "你好，先写草稿再新建对话", "Failed creation must preserve the draft");
  await evaluate("window.__composerProbe.failCreate = false; document.querySelector('#composer .send').click()");
  await waitFor("window.__composerProbe.sends.length === 1 && Boolean(document.querySelector('#panel-tab-composer-2'))");
  assert.deepEqual(await evaluate("window.__composerProbe.sends[0]"), { seed: "composer-2", text: "你好，先写草稿再新建对话" });

  await typeDraft("   ");
  assert.equal(await evaluate("document.querySelector('#composer .send').disabled"), true, "Whitespace must not enable Send");
  await typeDraft("输入法确认");
  await waitFor("!document.querySelector('#composer .send').disabled");
  await evaluate("document.querySelector('#composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))");
  assert.equal(await evaluate("window.__composerProbe.sends.length"), 1, "IME confirmation must not send");
  await evaluate("document.querySelector('#composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }))");
  assert.equal(await evaluate("window.__composerProbe.sends.length"), 1, "Shift+Enter must not send");

  await evaluate("window.__composerProbe.deferSend = true");
  await clickSend();
  await waitFor("window.__composerProbe.sends.length === 2 && Boolean(window.__composerProbe.release)");
  assert.equal(await evaluate("document.querySelector('#composer .send').disabled"), true, "Pending acknowledgement must prevent duplicate sends");
  await evaluate("document.querySelector('#composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  assert.equal(await evaluate("window.__composerProbe.sends.length"), 2, "Repeated Enter must not duplicate an in-flight send");
  await typeDraft("等待发送确认时写的下一条草稿");
  await evaluate("window.__composerProbe.deferSend = false; window.__composerProbe.release()");
  await waitFor("!document.querySelector('#composer .send').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "等待发送确认时写的下一条草稿", "Late acknowledgement must preserve newer text");

  await evaluate("window.__composerProbe.failSend = true");
  await clickSend();
  await waitFor("window.__composerProbe.sends.length === 3 && Boolean(document.querySelector('.toast.err')) && !document.querySelector('#composer .send').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "等待发送确认时写的下一条草稿", "Rejected send must preserve its draft");
  await evaluate("window.__composerProbe.failSend = false");
  await key("t", "ctrlKey: true");
  await waitFor("Boolean(document.querySelector('#panel-tab-composer-3')) && window.__composerProbe.creates === 3");
  await typeDraft("第二个会话的草稿");
  await waitFor("!document.querySelector('#composer .send').disabled");
  await clickSend();
  await waitFor("document.querySelector('#composer textarea').value === ''");
  await key("Tab", "ctrlKey: true, shiftKey: true");
  await waitFor("document.querySelector('#composer textarea').value === '等待发送确认时写的下一条草稿'");
  await key("w", "ctrlKey: true");
  await waitFor("Boolean(document.querySelector('#panel-tab-composer-3')) && document.querySelector('#composer textarea').value === ''");
  await key("w", "ctrlKey: true");
  await waitFor("Boolean(document.querySelector('#composer .send'))");
  await key("t", "ctrlKey: true");
  await waitFor("Boolean(document.querySelector('#panel-tab-composer-4')) && window.__composerProbe.creates === 4");
  await capture("composer-created-session");
  console.log("PASS composer: startup atomic create+send (failure keeps draft), whitespace/IME guards, duplicate-send prevention, late/rejected acknowledgements, tab isolation, Ctrl+T with no tabs");

  // 侧栏工作区归属:会话行的「…」菜单 → workspace.move_session / workspace.detach。
  // 只断言「发了什么参数 + 分组怎么变」;seed 由宿主注入与否是 Rust 侧的事。
  await evaluate(`(() => {
    const probe = window.__composerProbe;
    probe.workspaces = [
      { id: 'w1', title: '后端', path: 'E:\\\\qaqh-backend', order: 0 },
      { id: 'w2', title: '桌面壳', path: 'E:\\\\qaqh-desktop-app', order: 1 },
    ];
    probe.sessions[0].workspace_id = 'w1';
    window.dispatchEvent(new Event('focus'));
  })()`);
  const groupTitles = () => evaluate("[...document.querySelectorAll('.message-workspace-title')].map((el) => el.textContent)");
  const awaitGroup = (title) => waitFor(`[...document.querySelectorAll('.message-workspace-title')].map((el) => el.textContent).includes(${JSON.stringify(title)})`);
  const rowMenu = () => evaluate("[...document.querySelectorAll('.message-session-menu button')].map((el) => ({ text: el.innerText, checked: el.getAttribute('aria-checked') }))");
  const openRowMenu = async () => {
    await evaluate("document.querySelector('.message-session-more').click()");
    await waitFor("Boolean(document.querySelector('.message-session-menu'))");
  };
  await awaitGroup('后端');
  const seed = await evaluate("window.__composerProbe.sessions[0].session_id");
  const rows = await evaluate("document.querySelectorAll('.message-session-item').length");
  assert.ok(rows >= 2, "Fixture needs several sessions to exercise grouping");
  assert.equal(await evaluate("document.querySelectorAll('.message-session-more').length"), rows, "Every session row must expose a workspace action once a workspace exists");
  // 条目胶囊必须拉满行宽:长短不一的悬停/激活底色就是这里跑出来的。
  const widths = await evaluate("[...document.querySelectorAll('.message-session-item')].map((el) => Math.round(el.getBoundingClientRect().width))");
  assert.equal(new Set(widths).size, 1, `Session rows must render uniform-width pills, got ${JSON.stringify(widths)}`);

  await openRowMenu();
  const menuItems = await rowMenu();
  const checkedItems = menuItems.filter((item) => item.checked === 'true');
  assert.equal(checkedItems.length, 1, `Exactly one workspace must read as current, got ${JSON.stringify(menuItems)}`);
  assert.ok(checkedItems[0].text.includes('后端'), "Current workspace must be checked");
  await capture("sidebar-workspace-menu");

  await evaluate("[...document.querySelectorAll('.message-session-menu button')].find((el) => el.innerText.includes('桌面壳')).click()");
  await waitFor("window.__composerProbe.workspaceCalls.length === 1");
  assert.deepEqual(await evaluate("window.__composerProbe.workspaceCalls[0]"), { method: "workspace.move_session", params: { session_id: seed, workspace_id: "w2" } });
  assert.equal(await evaluate("document.querySelector('.message-session-menu')"), null, "Choosing a workspace must close the row menu");
  await awaitGroup('桌面壳');

  await openRowMenu();
  await evaluate("[...document.querySelectorAll('.message-session-menu button')].find((el) => el.innerText.includes('移出工作区')).click()");
  await waitFor("window.__composerProbe.workspaceCalls.length === 2");
  assert.deepEqual(await evaluate("window.__composerProbe.workspaceCalls[1]"), { method: "workspace.detach", params: { session_id: seed } });
  await awaitGroup('未分组');
  await openRowMenu();
  assert.equal((await rowMenu()).some((item) => item.text.includes('移出工作区')), false, "Ungrouped session must not offer detach");
  await evaluate("document.querySelector('.message-session-more').click()");
  assert.deepEqual(await groupTitles(), ['未分组'], "A workspace left with no session must not render an empty group");
  console.log("PASS workspace: row menu moves a session between workspaces, detaches it to 未分组, and hides detach once ungrouped");

  // 待响应弹卡(§6.2):status 翻转 → slide-in;响应完 → slide-out 卸载。
  // 走真实 App + 真实 transport,只把 `session_list` 回包里的 status 换成待人态。
  await evaluate(`(() => {
    const probe = window.__composerProbe;
    probe.sessions[0].status = 'waiting_permission';
    probe.sessions[1].status = 'waiting_ask';
    window.dispatchEvent(new Event('focus'));
  })()`);
  await waitFor("document.querySelectorAll('.session-pending').length === 2");
  // 入场是 240ms 的 slide-in,播完由 animationend 推相位;停在 in 说明动画链断了。
  await waitFor("[...document.querySelectorAll('.session-pending')].every((el) => el.dataset.phase === 'hold')");
  const cards = await evaluate(`[...document.querySelectorAll('.session-pending')].map((el) => ({
    kind: el.dataset.kind,
    phase: el.dataset.phase,
    travel: Number(getComputedStyle(el.querySelector('.session-pending-track')).getPropertyValue('--mq-travel').replace('px', '')),
    breathe: getComputedStyle(el.querySelector('.session-pending-body'), '::before').animationName,
    label: el.closest('.message-session-item').getAttribute('aria-label'),
    coversRow: Math.abs(el.getBoundingClientRect().width - el.closest('.message-session-item').getBoundingClientRect().width) <= 3,
  }))`);
  assert.deepEqual(cards.map((card) => card.kind), ["permission", "ask"], `Pending cards must map status → kind, got ${JSON.stringify(cards)}`);
  assert.ok(cards.every((card) => card.phase === "hold" && card.breathe === "session-pending-breathe"), `Hold phase must breathe, got ${JSON.stringify(cards)}`);
  // 半轨宽度是量出来的:为 0 时轨道静止(动画看起来像坏了),而 jsdom 测不出来。
  assert.ok(cards.every((card) => card.travel > 0), `Marquee half-track must be measured, got ${JSON.stringify(cards)}`);
  assert.ok(cards.every((card) => card.coversRow), `Card must cover the whole session row, got ${JSON.stringify(cards)}`);
  // 卡体是装饰(aria-hidden),可读名必须落在会话按钮上,否则读屏只听到跑马灯重复文案。
  assert.ok(cards.every((card) => card.label?.endsWith(`:${card.kind === "permission" ? "请求授权" : "请求回答"}`)), `Session button must carry the pending label, got ${JSON.stringify(cards)}`);
  await capture("sidebar-pending-cards");

  // 响应完成:状态回到非待人 → 原路 slide-out 并卸载(不是直接消失)。
  // 用 animationstart 事件记账,不用轮询撞相位:slide-out 只有 180ms,100ms 的
  // waitFor 去撞它是碰运气;而动画事件在卸载前必然派发,且顺带验了关键帧名接对。
  await evaluate(`(() => {
    window.__pendingAnims = [];
    document.addEventListener('animationstart', (event) => {
      if (String(event.animationName).startsWith('session-pending-')) window.__pendingAnims.push(event.animationName);
    }, true);
    const probe = window.__composerProbe;
    probe.sessions[0].status = 'working';
    probe.sessions[1].status = 'idle';
    window.dispatchEvent(new Event('focus'));
  })()`);
  await waitFor("document.querySelectorAll('.session-pending').length === 0");
  assert.equal(await evaluate("document.querySelectorAll('.message-session-item[aria-label]').length"), 0, "Resolved sessions must drop the pending aria-label");
  const anims = await evaluate("JSON.stringify(window.__pendingAnims)");
  assert.ok(anims.includes("session-pending-slide-out"), `Resolving must play slide-out before unmounting, got ${anims}`);
  console.log("PASS pending: status flips slide the card in (measured marquee, whole-row cover, labelled button) and slide it back out on resolve");

  // Reuse the existing message timeline: exactly one four-line thinking scroller,
  // with full history, and no second rendering beside the composer.
  await evaluate(`(() => {
    const probe = window.__composerProbe;
    const seed = probe.sessions.at(-1).session_id;
    let seq = 0;
    const feed = event => probe.emit('timeline://entry', { session_id: seed, entry: { timeline_seq: ++seq, turn_id: 'width-check', event } });
    window.__reasoningProbe = { feed };
    feed({ type: 'block_opened', block: { block_id: 'width-reasoning', kind: 'reasoning', state: 'open' } });
    feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '短思考' });
  })()`);
  await waitFor("document.querySelector('#messages .thinking-full')?.textContent === '短思考'");
  assert.equal(await evaluate("document.querySelector('.thinking-chain')"), null, "Bottom thinking strip must be removed");
  assert.equal(await evaluate("document.querySelectorAll('.thinking-full').length"), 1, "The existing timeline must render each reasoning block once");
  const reasoningBounds = () => evaluate(`(() => {
    const selectors = ['.workspace-content', '.session-column', '#session', '#messages', '#composer', '.thinking-full'];
    const result = {};
    for (const selector of selectors) {
      const r = document.querySelector(selector).getBoundingClientRect();
      result[selector] = { left: r.left, right: r.right, width: r.width };
    }
    const scroller = document.querySelector('.thinking-full');
    result.scroller = { height: scroller.clientHeight, lineHeight: parseFloat(getComputedStyle(scroller).lineHeight), top: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight, chars: scroller.textContent.length, tail: scroller.textContent.slice(-100) };
    return result;
  })()`);
  for (const [width, height] of [[1920, 1000], [1280, 800], [480, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__reasoningProbe.feed({ type: 'block_checkpoint', block_id: 'width-reasoning', text: '短思考' })");
    await waitFor("document.querySelector('.thinking-full')?.textContent === '短思考'");
    const before = await reasoningBounds();
    for (const [name, text] of [
      ['cjk', '很长的思考内容'.repeat(4000) + '可见的最新结尾'],
      ['path', 'C:\\workspace\\deeply-nested-directory\\filename-without-spaces.txt'.repeat(4000) + '-latest-end'],
      ['mixed', 'Thinking about中文代码与路径 '.repeat(4000) + 'latest-最新结尾'],
    ]) {
      await evaluate(`window.__reasoningProbe.feed({ type: 'block_checkpoint', block_id: 'width-reasoning', text: ${JSON.stringify(text)} })`);
      await waitFor(`document.querySelector('.thinking-full')?.textContent === ${JSON.stringify(text)}`);
      await waitFor("(() => { const el = document.querySelector('.thinking-full'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 2; })()");
      const after = await reasoningBounds();
      for (const selector of ['.session-column', '#session', '#messages', '#composer', '.thinking-full']) {
        assert.ok(Math.abs(after[selector].left - before[selector].left) < 1, `Long ${name} reasoning must not move ${selector}: ${JSON.stringify({ before: before[selector], after: after[selector] })}`);
        assert.ok(Math.abs(after[selector].width - before[selector].width) < 1, `Long ${name} reasoning must not expand ${selector}: ${JSON.stringify({ before: before[selector], after: after[selector] })}`);
        assert.ok(after[selector].right <= after['.workspace-content'].right + 1, `${selector} must remain inside the workspace`);
      }
      assert.ok(after.scroller.height <= after.scroller.lineHeight * 4 + 1, "Reasoning viewport must be no taller than four wrapped lines");
      assert.equal(after.scroller.chars, text.length, "Scrolling must expose the full reasoning history");
    }
    await capture(`thinking-long-${width}`);
    await evaluate("window.__reasoningProbe.feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '\\n' })");
    await waitFor("document.querySelector('.thinking-full').textContent.endsWith('latest-最新结尾\\n')");
    console.log(`PASS reasoning ${width}x${height}: four-line message viewport, full history, long CJK/path/mixed text without layout shifts`);
  }

  const history = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行思考`).join("\n");
  await evaluate(`window.__reasoningProbe.feed({ type: 'block_checkpoint', block_id: 'width-reasoning', text: ${JSON.stringify(history)} })`);
  await waitFor("(() => { const el = document.querySelector('.thinking-full'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 2; })()");
  let scroll = (await reasoningBounds()).scroller;
  assert.ok(Math.abs(scroll.height / scroll.lineHeight - 4) < 0.1, "Long thinking must display four lines");
  await evaluate("(() => { const el = document.querySelector('.thinking-full'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); })()");
  await evaluate("(async () => { window.__reasoningProbe.feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '\\n第 41 行思考' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()");
  scroll = (await reasoningBounds()).scroller;
  assert.equal(scroll.top, 0, "New streaming text must not pull the user away from earlier thinking");
  assert.ok(scroll.tail.endsWith("第 41 行思考"), "Thinking must continue streaming while reviewing history");
  await evaluate("(() => { const el = document.querySelector('.thinking-full'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); window.__reasoningProbe.feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '\\n第 42 行思考' }); })()");
  await waitFor("(() => { const el = document.querySelector('.thinking-full'); return el.textContent.endsWith('第 42 行思考') && el.scrollHeight - el.scrollTop - el.clientHeight <= 2; })()");
  await capture("thinking-four-lines-history");

  await evaluate("document.querySelector('.timeline-row.thinking .timeline-label').click()");
  await waitFor("document.querySelector('.thinking-full') == null");
  await evaluate("document.querySelector('.timeline-row.thinking .timeline-label').click()");
  await waitFor("document.querySelector('.thinking-full')?.textContent.endsWith('第 42 行思考')");
  await evaluate("window.__reasoningProbe.feed({ type: 'block_sealed', block_id: 'width-reasoning' })");
  assert.equal(await evaluate("document.querySelectorAll('.thinking-full').length"), 1, "Manually opened thinking should remain available after sealing");
  await evaluate("window.__reasoningProbe.feed({ type: 'turn_sealed', state: 'completed' })");
  await waitFor("document.querySelector('.thinking-full') == null");
  await evaluate("document.querySelector('.work-group .collapsed-row').click()");
  await waitFor("Boolean(document.querySelector('.timeline-row.thinking .timeline-label'))");
  await evaluate("document.querySelector('.timeline-row.thinking .timeline-label').click()");
  await waitFor("document.querySelector('.thinking-full')?.textContent.endsWith('第 42 行思考')");
  assert.equal((await reasoningBounds()).scroller.chars, (history + '\n第 41 行思考\n第 42 行思考').length, "Completed thinking must retain its full history");
  console.log("PASS thinking: auto-open, latest four lines, scroll-up pauses following, bottom resumes, collapse/reopen and completed history, no duplicate/footer rendering");
} finally {
  socket?.close();
  child.kill();
}
