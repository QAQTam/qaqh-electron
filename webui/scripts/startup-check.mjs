/**
 * 首页(StartupView)布局探针:工作区下拉的裁剪、建议卡片的响应式列数、页面横向溢出。
 *
 * 用法:
 *   pnpm exec vite --host 127.0.0.1 --port 5173      # 另开一个终端
 *   pnpm exec node scripts/startup-check.mjs         # 截图 + 量测
 *
 * 走的是 `/settings-check.html?workspaces=multi` —— 真 `App` + 假宿主 IPC,三条真实
 * 形状的 Windows 工作区。截图落 `out/startup-check/`,同名文件每轮覆盖,便于改一版
 * 样式就 diff 一次观感。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_STARTUP_CDP_PORT ?? "9336");
const BASE = process.env.QAQH_STARTUP_URL ?? "http://127.0.0.1:5173/settings-check.html?workspaces=multi";
const OUT = resolve(process.env.QAQH_STARTUP_OUT ?? "out/startup-check");
const SIZES = (process.env.QAQH_STARTUP_SIZES ?? "1566x790,1280x900,1024x768,820x700,520x640")
  .split(",")
  .map((pair) => pair.split("x").map(Number));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

mkdirSync(OUT, { recursive: true });

const child = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-startup-"))}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

let socket;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json()))
        .find((page) => page.type === "page");
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* Browser is starting. */ }
    await delay(200);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("Headless Edge did not expose a CDP target");

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
  await new Promise((open, fail) => {
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, { resolve: done, reject: fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`Fixture did not become ready: ${expression}`);
  };
  const capture = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  };
  /** 放大截一个元素:量的是字形与间距,1x 的整屏图看不清 10px 的前缀目录。 */
  const captureClip = async (name, box) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: box.left - 6, y: box.top - 6, width: box.width + 12, height: box.height + 12, scale: 2 },
    });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  };

  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('tauri'));",
  });

  const probe = `(() => {
    const rect = (node) => {
      if (node == null) return null;
      const r = node.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const cards = [...document.querySelectorAll('.startup-suggestion-card')];
    const menu = document.querySelector('.composer-workspace-menu');
    const content = document.querySelector('.workspace-content');
    const page = document.querySelector('.startup-container');
    const rows = new Map();
    for (const card of cards) {
      const top = Math.round(card.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    const menuRect = rect(menu);
    const contentRect = rect(content);
    // 菜单顶边被谁盖住/被视口切掉:elementFromPoint 落不到菜单自己身上就是被裁了。
    const menuTopHit = menuRect == null ? null
      : (document.elementFromPoint(menuRect.left + 8, Math.max(menuRect.top + 1, 0))?.closest('.composer-menu') != null);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overflowX: document.documentElement.scrollWidth - innerWidth,
      content: contentRect,
      cards: { count: cards.length, rows: [...rows.values()], cardRect: rect(cards[0]) },
      suggestions: rect(document.querySelector('.startup-suggestions')),
      // 首页自身的滚动容器:横向滚动条 = 有元素撑破了内容宽度(辉光/长路径都踩过)。
      page: page == null ? null : {
        top: Math.round(page.getBoundingClientRect().top),
        scrollWidth: page.scrollWidth, clientWidth: page.clientWidth,
        scrollHeight: page.scrollHeight, clientHeight: page.clientHeight,
        scrollTop: page.scrollTop,
      },
      hero: rect(document.querySelector('.startup-hero')),
      menu: menuRect,
      menuScroll: menu == null ? null : { scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight },
      menuItems: menu == null ? null : [...menu.querySelectorAll('button')].map((b) => ({
        text: (b.querySelector('span')?.textContent ?? '').trim(),
        sub: (b.querySelector('small')?.textContent ?? '').trim(),
        rect: rect(b),
      })),
      menuClippedAbove: menuRect == null || contentRect == null ? null : menuRect.top < contentRect.top,
      menuTopHit,
      docScrollTop: document.scrollingElement?.scrollTop ?? null,
    };
  })()`;

  const failures = [];
  const report = [];
  for (const [width, height] of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: BASE });
    await waitFor("Boolean(document.querySelector('.startup-container')) && document.fonts.status === 'loaded'");
    await delay(200);
    await capture(`startup-${width}x${height}`);

    const closed = await evaluate(probe);
    await evaluate("document.querySelector('.composer-workspace-button').click()");
    await waitFor("Boolean(document.querySelector('.composer-workspace-menu'))");
    await delay(150);
    await capture(`menu-${width}x${height}`);
    const opened = await evaluate(probe);
    if (opened.menu != null) await captureClip(`menu-zoom-${width}x${height}`, opened.menu);
    // 关掉菜单,免得影响下一轮截图
    await evaluate("document.querySelector('.composer-workspace-button').click()");

    const tag = `${width}x${height}`;
    const cols = Math.max(...opened.cards.rows);
    if (opened.cards.count === 4 && ![1, 2, 4].includes(cols)) {
      failures.push(`${tag}: 建议卡片列数 ${cols} 会把 4 张卡排成 3+1 孤儿行(rows=${JSON.stringify(opened.cards.rows)})`);
    }
    if (opened.overflowX > 0) failures.push(`${tag}: 首页横向溢出 ${opened.overflowX}px`);
    if (opened.page != null && opened.page.scrollWidth > opened.page.clientWidth + 1) {
      failures.push(`${tag}: 首页内部横向滚动 ${opened.page.clientWidth}/${opened.page.scrollWidth}px`);
    }
    // 装不下时必须从顶部开始排(safe center),标题不能被顶到滚动区外面。
    if (opened.hero != null && opened.page != null && opened.page.scrollHeight > opened.page.clientHeight
      && opened.hero.top < opened.page.top) {
      failures.push(`${tag}: 内容超高时标题被顶出可视区(hero.top=${opened.hero.top} < page.top=${opened.page.top})`);
    }
    if (opened.menuClippedAbove) {
      failures.push(`${tag}: 工作区菜单顶边被裁(menu.top=${opened.menu?.top} < content.top=${opened.content?.top})`);
    }
    // 菜单内部滚动本身不算问题(窗口矮时那是唯一正确的降级);要守的是
    // 「菜单整体落在视口内」——被视口切掉才叫渲染不全。
    if (opened.menu != null && (opened.menu.bottom > height + 0.5 || opened.menu.top < 0)) {
      failures.push(`${tag}: 工作区菜单越出视口(top=${opened.menu.top}, bottom=${opened.menu.bottom})`);
    }
    report.push({ size: tag, cols, rows: opened.cards.rows, cardWidth: opened.cards.cardRect?.width,
      contentWidth: opened.content?.width, suggestionsWidth: opened.suggestions?.width,
      menu: opened.menu, menuClippedAbove: opened.menuClippedAbove, overflowX: opened.overflowX,
      firstItem: opened.menuItems?.[0] ?? null, closedCards: closed.cards.rows });
  }

  console.log(JSON.stringify(report, null, 2));
  // 深色再走一轮:辉光、图标底色、卡片描边在深色 token 下是另一套值,
  // 只看浅色容易把「对比度刚好」的调色带进深色。
  await send("Emulation.setDeviceMetricsOverride", { width: 1566, height: 790, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: BASE });
  await waitFor("Boolean(document.querySelector('.startup-container')) && document.fonts.status === 'loaded'");
  await evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
  await delay(250);
  await capture("startup-dark");
  await evaluate("document.querySelector('.composer-workspace-button').click()");
  await waitFor("Boolean(document.querySelector('.composer-workspace-menu'))");
  await delay(150);
  const dark = await evaluate(probe);
  if (dark.menu != null) await captureClip("menu-zoom-dark", dark.menu);

  // ── 右键菜单:选中文本 → 复制 / 全选本段 ─────────────────────
  // 用真 MouseEvent 打在文本节点上,走的是 App 里那条 window 级 contextmenu 监听。
  await send("Page.navigate", { url: BASE });
  await waitFor("Boolean(document.querySelector('.startup-subtitle')) && document.fonts.status === 'loaded'");
  await delay(200);
  const selectedText = await evaluate(`(() => {
    const node = document.querySelector('.startup-subtitle');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.top + 8 }));
    return selection.toString();
  })()`);
  await waitFor("Boolean(document.querySelector('.context-menu'))");
  await delay(120);
  const contextMenu = await evaluate(`(() => {
    const menu = document.querySelector('.context-menu');
    const r = menu.getBoundingClientRect();
    return {
      rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) },
      items: [...menu.querySelectorAll('button')].map((b) => b.textContent.trim()),
      focused: document.activeElement?.closest('.context-menu') != null,
    };
  })()`);
  await captureClip("context-menu-text", contextMenu.rect);
  await capture("context-menu-text-full");
  if (contextMenu.rect.top < 0 || contextMenu.rect.left < 0
    || contextMenu.rect.bottom > 790 || contextMenu.rect.left + contextMenu.rect.width > 1566) {
    failures.push(`右键菜单越出视口:${JSON.stringify(contextMenu.rect)}`);
  }
  if (contextMenu.items.length === 0) failures.push("右键菜单没有任何条目");

  // 点一条动作:菜单必须先关(剪贴板在无头环境可能被拒,这里只验交互闭环)。
  await evaluate("document.querySelector('.context-menu button')?.click()");
  await delay(120);
  if (await evaluate("Boolean(document.querySelector('.context-menu'))")) {
    failures.push("点击菜单项后右键菜单没有关闭");
  }

  // 输入框里右键:必须放行原生菜单(剪切/粘贴/拼写检查),不能弹通用菜单。
  const editableMenu = await evaluate(`(() => {
    const area = document.querySelector('#composer textarea');
    const r = area.getBoundingClientRect();
    area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
    return Boolean(document.querySelector('.context-menu'));
  })()`);
  if (editableMenu) failures.push("输入框里右键弹出了通用菜单(应放行原生编辑菜单)");

  // 空白处没有可做的事:不该弹空菜单(弹了比不弹更糟),也不该拦掉原生。
  const blankMenu = await evaluate(`(() => {
    window.getSelection()?.removeAllRanges();
    const blank = document.querySelector('.startup-container');
    const r = blank.getBoundingClientRect();
    blank.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 16, clientY: r.bottom - 16 }));
    return Boolean(document.querySelector('.context-menu'));
  })()`);
  if (blankMenu) failures.push("空白处右键也弹了菜单(应当不弹)");

  // ── 会话输入区的同一个选择器 ────────────────────────────────
  // 空态与已开会话用的是同一个 `WorkspaceMenu`(只是展开方向相反),会话里也要拍
  // 一张:它贴着窗口底部向上弹,被顶出视口上边的风险更高。
  // 夹具没有 daemon,这里只替身「建会话/发消息」几条 IPC,其余仍走假宿主。
  await send("Page.navigate", { url: BASE });
  await waitFor("Boolean(document.querySelector('#composer textarea'))");
  await evaluate(`(() => {
    const internals = window.__TAURI_INTERNALS__;
    const original = internals.invoke.bind(internals);
    // 开局必须**空**:createSessionWithCwd 靠「轮询 session_list 找新 seed」判定
    // 建好了,先摆一条同名会话会让它一直等不到新条目、六秒后抛「会话创建超时」。
    const sessions = [];
    internals.invoke = async (cmd, args = {}) => {
      if (cmd === "create_session") {
        sessions.push({ session_id: "s1", title: "演示会话" });
        return { status: "accepted" };
      }
      if (cmd === "session_list") return structuredClone(sessions);
      if (cmd === "timeline_status") return { status: "open", session_id: args.seed };
      if (cmd === "session_bootstrap") return { control: { state: { activity: "idle" } } };
      if (cmd === "pending_approvals") return [];
      if (cmd === "send_message") return { status: "accepted" };
      return original(cmd, args);
    };
  })()`);
  await evaluate("document.querySelector('#composer textarea').focus()");
  await send("Input.insertText", { text: "演示会话" });
  await delay(150);
  await evaluate("document.querySelector('#composer .send').click()");
  await waitFor("Boolean(document.querySelector('.composer-workspace-button'))");
  await delay(300);
  await capture("session-composer");
  await evaluate("document.querySelector('.composer-workspace-button').click()");
  await waitFor("Boolean(document.querySelector('.composer-workspace-menu'))");
  await delay(150);
  const session = await evaluate(probe);
  if (session.menu != null) await captureClip("session-menu-zoom", session.menu);
  await capture("session-menu");
  if (session.menu != null && session.menu.top < 0) {
    failures.push(`会话输入区: 工作区菜单被视口顶边裁掉(top=${session.menu.top})`);
  }
  // 窄窗口:多出来的这枚 chip 会不会把工具条挤破(≤620 时它只留图标)。
  await evaluate("document.querySelector('.composer-workspace-button').click()");
  await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 700, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  const narrow = await evaluate(`(() => {
    const bar = document.querySelector('.composer-toolbar');
    const box = document.querySelector('.composer-surface');
    if (bar == null || box == null) return null;
    return { overflow: bar.scrollWidth - box.clientWidth, chip: Boolean(document.querySelector('.composer-workspace-button')) };
  })()`);
  await capture("session-composer-narrow");
  if (narrow != null && narrow.overflow > 1) {
    failures.push(`会话输入区 820x700: 工具条横向溢出 ${narrow.overflow}px`);
  }

  // 侧栏会话行的右键菜单是**内联**展开的(不浮层),高度直接吃掉会话列表:
  // 这里量它的总高,并确认它没有被通用右键菜单顶掉(两者只该出一个)。
  await send("Emulation.setDeviceMetricsOverride", { width: 1566, height: 790, deviceScaleFactor: 1, mobile: false });
  await delay(200);
  await evaluate(`(() => {
    const row = document.querySelector('.message-session-row');
    if (row == null) return false;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
    return true;
  })()`);
  await delay(200);
  const moveMenu = await evaluate(`(() => {
    const menu = document.querySelector('.message-session-menu');
    const generic = document.querySelector('.context-menu');
    if (menu == null) return { height: null, generic: Boolean(generic) };
    return {
      height: Math.round(menu.getBoundingClientRect().height),
      rows: menu.querySelectorAll('button').length,
      generic: Boolean(generic),
    };
  })()`);
  await capture("sidebar-move-menu");
  if (moveMenu.height == null) failures.push("侧栏会话行右键没有展开移动菜单");
  else if (moveMenu.height > 200) failures.push(`侧栏移动菜单仍偏高 ${moveMenu.height}px(期望 ≤200)`);
  if (moveMenu.generic) failures.push("侧栏会话行右键同时弹出了通用菜单(应当只保留移动菜单)");

  // 中文在 pwsh 控制台会被按 GBK 解码成乱码,所以失败清单同时落一份 JSON,
  // 用编辑器/`read` 看原文,控制台只看条数。
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ report, failures }, null, 2));
  if (failures.length > 0) {
    console.error(`\nFAIL (${failures.length})`);
    for (const line of failures) console.error(`  - ${line}`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS startup: menu stays inside the viewport, cards reflow 4/2/1, no horizontal overflow");
  }
} finally {
  socket?.close();
  child.kill();
}
