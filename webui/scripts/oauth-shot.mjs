/**
 * 接入页截图与交互复核：所有 RPC 都由独立浏览器配置中的本地夹具响应。
 *
 * 与 `visual-capture.mjs` 的区别：只拍这一张、不改动 `artifacts/ui-visual-review/`
 * 里已入库的视觉基线，并在应用脚本之前把 Tauri 判定 stub 成真——否则接入页
 * 只会渲染「浏览器预览下不可用」的兜底文案。
 *
 * 用法（dev server 需已在跑；QAQH_SHOT_MATRIX=1 验证亮暗、窄窗与登录状态矩阵）：
 *   node scripts/oauth-shot.mjs
 * 环境变量：QAQH_SHOT_URL / QAQH_SHOT_OUT / QAQH_SHOT_VIEW / QAQH_EDGE
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_SHOT_CDP_PORT ?? "9335");
const BASE = process.env.QAQH_SHOT_URL ?? "http://127.0.0.1:5173/stress.html";
const VIEW = process.env.QAQH_SHOT_VIEW ?? "oauth";
const OUT = resolve(process.env.QAQH_SHOT_OUT ?? "artifacts/oauth-check.png");
const MATRIX = process.env.QAQH_SHOT_MATRIX === "1";
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const child = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-shot-"))}`,
    "--window-size=1280,1400",
    "--no-first-run",
    "--disable-extensions",
    "--disable-sync",
    "--no-default-browser-check",
    BASE,
  ],
  { stdio: "ignore" },
);

let target;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    target = pages.find((page) => page.type === "page" && page.url.startsWith(BASE));
    if (target?.webSocketDebuggerUrl) break;
  } catch {
    /* Edge 还在启动 */
  }
  await delay(250);
}
if (!target?.webSocketDebuggerUrl) throw new Error(`CDP page not found for ${BASE}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const browserErrors = [];
let nextId = 0;
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    const error = message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text;
    browserErrors.push(error);
    console.error('[browser]', error);
  }
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
const send = (method, params = {}) =>
  new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};

const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function until(expression) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${expression}\n${JSON.stringify(await evaluate("({ url: location.href, rows: document.querySelectorAll('.oauth-provider').length, requests: window.__oauthRequests, text: document.body.innerText.slice(0, 1800) })"))}`);
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing control');
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Control is obscured');
    return { x, y };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  // 必须在应用脚本之前：`isTauriRuntime()` 只看这个全局。
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      const scenario = new URLSearchParams(location.search).get('oauthState') ?? 'signed-in';
      const signedIn = scenario === 'signed-in';
      localStorage.setItem('qaqh.oauth.lastAccountProvider', signedIn ? 'deepseek-account' : 'openai');
      const expiresAtMs = Date.now() + 60000;
      const FIXTURES = {
        "config.load": { credential: signedIn ? "deepseek_account" : "api_key", model: signedIn ? "deepseek-flash" : "saved-byok-model", reasoningEffort: "high", wire: "chat", baseUrl: "https://api.deepseek.com", contextLength: 1048576, profiles: [], activeProfile: null },
        "siwc.status": { status: "disconnected", sharing: false },
        "siwc.models": [{ slug: "gpt-5.2", displayName: "GPT-5.2" }],
        "dsaccount.status": {
          signedIn,
          account: signedIn ? { user_id: "fixture-user", label: "Fixture 用户", provider: "WECHAT", currency: "CNY", inference_origin: "https://api.deepseek.com", saved_at_ms: Date.now(), has_credential: true } : null,
          storageError: null, inferenceOrigin: "https://api.deepseek.com",
          usageUrl: "https://platform.deepseek.com/usage", topUpUrl: "https://platform.deepseek.com/top_up",
          flow: { attemptId: null, state: "idle", authorizeUrl: null, expiresAtMs: 0, error: null },
        },
        "dsaccount.balance": {
          recharge: [{ currency: "CNY", balance: "0E-16", tokenEstimation: "0" }],
          bonus: [{ currency: "CNY", balance: "0", tokenEstimation: "0" }],
          totalCost: [{ currency: "CNY", amount: "5.9028406400000000" }],
          hasUsableBalance: false,
        },
        "dsaccount.bonuses": [],
        "dsaccount.models": [
          { id: "deepseek-flash", display_name: "DeepSeek Flash" },
          { id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
        ],
      };
      if (scenario === 'identity-only') FIXTURES['siwc.status'] = { status: 'connected', sharing: false, name: 'Fixture 用户' };
      if (scenario === 'connecting') {
        FIXTURES['siwc.status'] = { status: 'connecting', sharing: false };
        FIXTURES['dsaccount.status'].flow.state = 'authorizing';
      }
      if (scenario === 'damaged') FIXTURES['dsaccount.status'].storageError = '本地凭据无法读取，请重新登录';
      if (scenario === 'failed') {
        FIXTURES['siwc.status'] = { status: 'reauth_required', sharing: false, error: { code: 'expired', message: '授权已过期，请重新登录' } };
        FIXTURES['dsaccount.status'].flow = { attemptId: 'previous', state: 'failed', authorizeUrl: null, expiresAtMs: 0, error: '授权未完成，请重试' };
      }
      window.__oauthRequests = [];
      window.__oauthFixture = FIXTURES;
      window.__TAURI_INTERNALS__ = {
        invoke: (cmd, args) => {
          window.__oauthRequests.push({ cmd, method: args?.method, params: args?.params });
          if (cmd !== "service_rpc") return Promise.resolve(null);
          const method = args?.method;
          if (method === 'config.save') { Object.assign(FIXTURES['config.load'], args.params); return Promise.resolve(null); }
          if (method === 'siwc.sign_in.start') return Promise.resolve({ flowId: 'fixture-flow', authorizeUrl: 'https://example.test/oauth', expiresAtMs, redirectUri: '', usageUrl: '' });
          if (method === 'siwc.sign_in.status') return Promise.resolve({ flowId: 'fixture-flow', state: 'failed', error: { code: 'cancelled', message: '演示：授权被取消' } });
          if (method === 'dsaccount.sign_in.start') return Promise.resolve({ attemptId: 'fixture-attempt', authorizeUrl: 'https://example.test/oauth', expiresAtMs });
          if (method === 'dsaccount.sign_in.status') return Promise.resolve({ attemptId: 'fixture-attempt', state: 'failed', expiresAtMs, error: '演示：授权被取消' });
          if (!(method in FIXTURES)) return Promise.reject(new Error("no fixture for " + method));
          return Promise.resolve(FIXTURES[method]);
        },
        transformCallback: (callback) => callback,
      };
    `,
  });
  const scenarios = MATRIX ? [
    { name: 'oauth-light', state: 'signed-out', theme: 'light', width: 1280, height: 800 },
    { name: 'oauth-dark', state: 'signed-in', theme: 'dark', width: 1280, height: 800 },
    { name: 'oauth-expanded', state: 'signed-in', theme: 'light', width: 1280, height: 900, expanded: true },
    { name: 'oauth-identity-only', state: 'identity-only', theme: 'light', width: 1280, height: 800 },
    { name: 'oauth-connecting', state: 'connecting', theme: 'light', width: 1280, height: 800 },
    { name: 'oauth-damaged', state: 'damaged', theme: 'dark', width: 800, height: 600 },
    { name: 'oauth-failed-narrow', state: 'failed', theme: 'dark', width: 480, height: 820 },
    { name: 'oauth-150pct', state: 'signed-out', theme: 'light', width: 1280, height: 900, scale: 1.5 },
    { name: 'oauth-contrast', state: 'signed-out', theme: 'light', width: 1280, height: 800, contrast: true },
  ] : [{ name: 'oauth', state: 'signed-in', theme: 'light', width: 1280, height: 800 }];
  const toggle = '.oauth-provider[data-provider="deepseek-account"] .oauth-provider__toggle';
  for (const scenario of scenarios) {
    await send("Emulation.setDeviceMetricsOverride", { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: 'forced-colors', value: scenario.contrast ? 'active' : 'none' }] });
    await send("Page.navigate", { url: `${BASE}?view=${VIEW}&theme=${scenario.theme}&material=solid&oauthState=${scenario.state}` });
    await until("document.querySelectorAll('.oauth-provider').length === 2 && document.fonts.status === 'loaded' && !document.querySelector('.oauth-pill input').disabled");
    if (scenario.scale) await evaluate(`document.documentElement.style.zoom = ${scenario.scale}`);
    const geometry = await evaluate(`(() => {
      const body = document.querySelector('.oauth-page-body');
      return { heights: [...document.querySelectorAll('.oauth-provider')].map(row => row.getBoundingClientRect().height), hidden: [...document.querySelectorAll('.oauth-provider__details')].every(el => el.hidden && el.offsetHeight === 0), overflow: document.documentElement.scrollWidth > innerWidth || body.scrollWidth > body.clientWidth, scroll: body.scrollHeight > body.clientHeight + 1 };
    })()`);
    assert(geometry.hidden && !geometry.overflow, `${scenario.name}: collapsed details or horizontal overflow ${JSON.stringify(geometry)}`);
    if (scenario.width >= 1280 && !scenario.scale) assert(!geometry.scroll && Math.max(...geometry.heights) <= 112, `${scenario.name}: summary should fit without scrolling`);
    if (scenario.expanded) {
      const writes = await evaluate("window.__oauthRequests.filter(r => r.method === 'config.save').length");
      await click(toggle);
      await until("!document.querySelector('#oauth-details-deepseek-account').hidden && document.querySelector('#oauth-details-deepseek-account [role=option]') != null");
      assert(await evaluate("document.querySelector('#oauth-details-deepseek-account .dsaccount-rows') != null"), 'Expanded account balance is missing');
      assert(await evaluate("window.__oauthRequests.filter(r => r.method === 'config.save').length") === writes, 'Expanding must not write configuration');
      await evaluate("window.__savedOAuthDetails = document.querySelector('#oauth-details-deepseek-account')");
      await evaluate(`document.querySelector(${JSON.stringify(toggle)}).focus()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await until("document.querySelector('#oauth-details-deepseek-account').hidden");
      assert(await evaluate("document.querySelector('#oauth-details-deepseek-account') === window.__savedOAuthDetails && window.__savedOAuthDetails.offsetHeight === 0"), 'Collapsing must keep detail state without reserving height');
      await click(toggle);
      await until("!document.querySelector('#oauth-details-deepseek-account').hidden");
      assert(await evaluate("window.__oauthRequests.filter(r => r.method === 'dsaccount.models').length") === 1, 'Reopening should reuse the model catalog');
      await click('[data-provider="openai"] .oauth-provider__toggle');
      assert(await evaluate("!document.querySelector('[data-provider=openai] .oauth-quota').textContent.includes('deepseek-flash')"), 'Inactive provider must not claim the active provider model');
      await click('[data-provider="openai"] .oauth-provider__toggle');
      await evaluate("document.querySelector('.oauth-page-body').scrollTop = 0");
    }
    await delay(150);
    const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const output = MATRIX ? join(dirname(OUT), `${scenario.name}.png`) : OUT;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, Buffer.from(data, "base64"));
    console.log(`PASS ${scenario.name}: ${JSON.stringify(geometry)} → ${output}`);
    if (scenario.name === 'oauth-light') {
      await click('[data-provider="openai"] .siwc-signin');
      await until("document.querySelector('.oauth-page-error')?.textContent.includes('演示：授权被取消')");
      await click('[data-provider="deepseek-account"] .oauth-provider__connect');
      await until("window.__oauthRequests.some(r => r.method === 'dsaccount.sign_in.status') && document.querySelector('.oauth-page-error')?.textContent.includes('演示：授权被取消')");
      assert(await evaluate("window.__oauthRequests.filter(r => r.cmd === 'open_external').length") === 2, 'Both login buttons must use the host browser command');
      assert(await evaluate("window.__oauthRequests.filter(r => r.method === 'config.save').length") === 0, 'Failed login must not change the active source');
      console.log('PASS login actions: both providers invoke host authorization; failures remain visible without config writes');
    }
    if (scenario.expanded) {
      await click('.oauth-pill');
      await until("window.__oauthFixture['config.load'].credential === 'api_key' && !document.querySelector('.oauth-pill input').checked && !document.querySelector('.oauth-pill input').disabled");
      await click('.oauth-pill');
      await until("window.__oauthFixture['config.load'].credential === 'deepseek_account' && document.querySelector('.oauth-pill input').checked && !document.querySelector('.oauth-pill input').disabled");
      console.log('PASS source toggle: BYOK and last-used account source are restored');
    }
  }
  assert(browserErrors.length === 0, `Browser runtime errors: ${browserErrors.join('\n')}`);
} finally {
  socket.close();
  child.kill();
}
process.exit(0);
