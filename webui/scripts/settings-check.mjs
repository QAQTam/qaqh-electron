/**
 * 设置浮层的浏览器验收(开发工具,不进产品构建)。
 *
 * 跑的是真 `App` + 真设置组件 + 假宿主 IPC(`src/settings-check.tsx`):
 * 断言的是「webview 到底往外发了什么 patch」,而不是组件长什么样。
 *
 * 用法:
 *   pnpm exec vite --port 5173            # 另开一个终端
 *   pnpm exec node scripts/settings-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_CDP_PORT ?? "9334");
const TARGET = process.env.SETTINGS_URL ?? `http://127.0.0.1:5173/settings-check.html`;
const SHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "settings-check.png");
const SHOT_BOTTOM = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "settings-check-bottom.png");

const exceptions = [];
const consoleErrors = [];

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json());
      const page = list.find((item) => item.type === "page" && item.url === TARGET);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP target not found: ${TARGET}(vite 起没起?)`);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const detail = msg.params?.exceptionDetails;
      exceptions.push(detail?.exception?.description ?? detail?.text ?? "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push((msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)) });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    open,
    send,
    async evaluate(expression, timeoutMs = 30_000) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await Promise.race([
            send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluate 超时:${expression.slice(0, 60)}`)), timeoutMs)),
          ]);
          if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
          }
          return result.result?.value;
        } catch (error) {
          if (/Execution context was destroyed|Cannot find context/i.test(String(error?.message)) && attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            continue;
          }
          throw error;
        }
      }
    },
  };
}

const BOOTSTRAP = `
window.__t = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  // 浮层根类名是 settings-page(SettingsView.tsx:121);此处曾写 settings-modal,
  // 自改类名起夹具一直取不到浮层,首步与 Esc/零会话几步长期假红。
  modal: () => document.querySelector(".settings-page"),
  // label 与 src/lib/strings.ts 的 STR.settings* 文案保持一致;改文案要同步这里。
  field: (label) => [...document.querySelectorAll(".field")]
    .find((item) => item.querySelector(".field-label")?.textContent === label)
    ?.querySelector("input,select"),
  value: (label) => window.__t.field(label)?.value ?? null,
  type: (label, next) => {
    const el = window.__t.field(label);
    el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  pick: (label, next) => {
    const el = window.__t.field(label);
    el.value = next;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  },
  click: (sel) => document.querySelector(sel)?.click(),
  // 切换式单页:按 data-section-id 点导航切 pane(visual-capture 同款语义)。
  // 注意:本文件 helper 整体在一个外层模板串里,这里不能用嵌套反引号。
  nav: (id) => document.querySelector('.settings-nav-item[data-section-id="' + id + '"]')?.click(),
  text: (sel) => document.querySelector(sel)?.innerText ?? "",
  key: (key, opts = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts })),
  calls: (method) => window.__qaqhProbe.calls.filter((item) => item.command?.type === method),
  saves: () => window.__qaqhProbe.saves,
  lastSave: () => window.__qaqhProbe.saves[window.__qaqhProbe.saves.length - 1] ?? null,
  foot: () => document.querySelector(".settings-foot-state")?.innerText ?? "",
};
"ok";
`;

const steps = [
  {
    name: "Ctrl+, 打开浮层并读一次 config.load",
    code: `
      // 首帧后 App 还在挂全局监听(实测约 1.1s),这一发 Ctrl+, 会掉在监听之前——
      // 重试到浮层出现为止,断言的本意是「Ctrl+, 能打开」,不是「600ms 内能打开」。
      for (let attempt = 0; attempt < 20 && __t.modal() == null; attempt += 1) {
        __t.key(",", { ctrlKey: true });
        await __t.wait(250);
      }
      // 2026-10-06 起宿主启动时会多拉一次 config.load(主题预取),故 ≥1。
      return { ok: __t.modal() != null && __t.calls("config.load").length >= 1,
               detail: { modal: __t.modal() != null, loads: __t.calls("config.load").length } };
    `,
  },
  {
    name: "服务商目录与 profile 摘要分别读取",
    code: `
      const lists = __t.calls("profile.list").length;
      const providerLists = __t.calls("provider.list").length;
      __t.nav("section-providers");
      await __t.wait(350);
      const providers = document.querySelectorAll(".provider-row").length;
      const referenced = __t.text(".provider-row");
      __t.nav("section-profiles");
      await __t.wait(350);
      const profiles = document.querySelectorAll(".profile-row").length;
      const hasDefault = document.querySelector(".profile-row.active")?.innerText.includes("默认模型") === true;
      return { ok: lists >= 1 && providerLists >= 1 && providers === 2 && profiles === 2 && hasDefault
                 && referenced.includes("OpenCode Zen"),
               detail: { lists, providerLists, providers, profiles, hasDefault, referenced } };
    `,
  },
  {
    name: "应用设置走 config.save（只发差异项）",
    code: `
      __t.nav("section-permission");
      await __t.wait(250);
      const before = __t.saves().length;
      __t.click('input[name="permission-tier"][value="1"]');
      await __t.wait(250);
      const foot = __t.foot();
      document.querySelector(".settings-foot-actions .primary-mini")?.click();
      await __t.wait(600);
      const patch = __t.lastSave();
      return { ok: foot.includes("1 项") && __t.saves().length === before + 1
                 && JSON.stringify(Object.keys(patch ?? {})) === '["permissionLevel"]'
                 && patch?.permissionLevel === 1,
               detail: { foot, patchKeys: Object.keys(patch ?? {}), saved: __t.saves().length } };
    `,
  },
  {
    name: "默认模型走 model.selection.set_default，不碰 config.save",
    code: `
      __t.nav("section-profiles");
      await __t.wait(300);
      const saves = __t.saves().length;
      const before = __t.calls("model.selection.set_default").length;
      const target = [...document.querySelectorAll(".profile-row:not(.active) button")]
        .find((button) => button.textContent.includes("设为默认"));
      target?.click();
      await __t.wait(700);
      const active = document.querySelector(".profile-row.active")?.innerText ?? "";
      return { ok: __t.calls("model.selection.set_default").length === before + 1
                 && __t.saves().length === saves && active.includes("默认模型"),
               detail: { before, after: __t.calls("model.selection.set_default").length, saves, active } };
    `,
  },
  {
    name: "新建 legacy profile 使用平铺 profile.create，且不丢应用设置草稿",
    code: `
      // 先制造一份应用设置草稿（权限档降到 3，不保存）。
      __t.nav("section-permission");
      await __t.wait(250);
      __t.click('input[name="permission-tier"][value="3"]');
      await __t.wait(250);
      const dirtyBefore = document.querySelector(".settings-dirty-pill")?.innerText ?? "";
      const saves = __t.saves().length;

      __t.nav("section-profiles");
      await __t.wait(300);
      const creates = __t.calls("profile.create").length;
      document.querySelector(".provider-cta")?.click();
      await __t.wait(300);
      __t.type("存档名称", "Fixture 存档");
      document.querySelector('.profile-wizard-card [aria-label="模型"]')?.click();
      await __t.wait(100);
      [...document.querySelectorAll('[role="option"]')]
        .find((option) => option.textContent.includes("ox-alpha-free"))?.click();
      await __t.wait(200);
      document.querySelector(".profile-wizard-card .primary-mini")?.click();
      await __t.wait(800);

      const dirtyAfter = document.querySelector(".settings-dirty-pill")?.innerText ?? "";
      const cards = document.querySelectorAll(".profile-row").length;
      const created = __t.calls("profile.create").at(-1)?.command ?? {};
      return { ok: __t.calls("profile.create").length === creates + 1
                 && __t.saves().length === saves && dirtyBefore.includes("1 项")
                 && dirtyAfter.includes("1 项") && cards === 3
                 && created.name === "Fixture 存档" && created.model === "ox-alpha-free"
                 && created.profile === undefined,
               detail: { creates: __t.calls("profile.create").length, created, saves, dirtyBefore, dirtyAfter, cards } };
    `,
  },
  {
    name: "编辑服务商走带 config_revision 的 ProviderUpsertDto，同一份草稿仍然保留",
    code: `
      __t.nav("section-providers");
      await __t.wait(350);
      const saves = __t.saves().length;
      const before = __t.calls("provider.upsert").length;
      [...document.querySelectorAll(".provider-row button")]
        .find((button) => button.textContent === "编辑")?.click();
      await __t.wait(250);
      __t.type("服务商名称", "OpenCode Zen Edited");
      await __t.wait(150);
      document.querySelector(".provider-editor .primary-mini")?.click();
      await __t.wait(700);
      const renamed = __t.text(".provider-row").includes("OpenCode Zen Edited");
      const dirty = document.querySelector(".settings-dirty-pill")?.innerText ?? "";
      const call = __t.calls("provider.upsert").at(-1) ?? {};
      const provider = call.command?.provider ?? {};
      const guard = call.preconditions?.find((item) => item.kind === "config_revision");
      return { ok: __t.calls("provider.upsert").length === before + 1
                 && __t.saves().length === saves && renamed && dirty.includes("1 项")
                 && typeof provider.base_url === "string" && provider.baseUrl === undefined
                 && provider.api_key?.operation === "keep"
                 && guard?.revision === window.__qaqhProbe.providerCatalog.revision - 1,
               detail: { before, after: __t.calls("provider.upsert").length, provider, guard, saves, renamed, dirty } };
    `,
  },
  {
    name: "默认模型 profile 不可删；其他 profile 删除使用 name",
    code: `
      __t.nav("section-profiles");
      await __t.wait(350);
      const defaultDisabled = document.querySelector(".profile-row.active .ghost-mini.is-danger")?.disabled === true;
      const before = __t.calls("profile.delete").length;
      const target = document.querySelector(".profile-row:not(.active) .ghost-mini.is-danger");
      const removable = target?.disabled === false;
      target?.click();
      for (let attempt = 0; attempt < 20 && document.querySelectorAll(".profile-row").length !== 2; attempt += 1) {
        await __t.wait(100);
      }
      const deleted = __t.calls("profile.delete").at(-1)?.command ?? {};
      const remaining = document.querySelectorAll(".profile-row").length;
      const profileIds = Object.keys(window.__qaqhProbe.registry.profiles);
      return { ok: defaultDisabled && removable && __t.calls("profile.delete").length === before + 1
                 && typeof deleted.name === "string" && deleted.id === undefined
                 && remaining === 2,
               detail: { defaultDisabled, removable, deleted, deletes: __t.calls("profile.delete").length, remaining, profileIds } };
    `,
  },
  {
    name: "重新读取丢弃草稿并回到基线（应用设置）",
    code: `
      __t.nav("section-permission");
      await __t.wait(300);
      const before = __t.saves().length;
      [...document.querySelectorAll(".settings-foot-actions .ghost-mini")]
        .find((button) => button.textContent.includes("重新读取"))?.click();
      await __t.wait(300);
      [...document.querySelectorAll(".settings-confirm-actions button")]
        .find((button) => button.textContent.includes("放弃并读取"))?.click();
      await __t.wait(700);
      const restored = document.querySelector('input[name="permission-tier"][value="1"]')?.checked === true;
      return { ok: restored && __t.saves().length === before && !__t.foot().includes("项未保存"),
               detail: { restored, saves: __t.saves().length, foot: __t.foot() } };
    `,
  },
  {
    name: "Esc 关闭遇脏草稿 → 先问放弃/留下",
    code: `
      __t.click('input[name="permission-tier"][value="3"]');
      await __t.wait(250);
      __t.key("Escape");
      await __t.wait(300);
      const asked = document.querySelector(".settings-discard") != null && __t.modal() != null;
      [...document.querySelectorAll(".settings-discard .ghost-mini")].find((b) => b.textContent.includes("继续编辑"))?.click();
      await __t.wait(200);
      const stayed = __t.modal() != null;
      [...document.querySelectorAll(".settings-foot-actions .ghost-mini")].find((b) => b.textContent.includes("重新读取"))?.click();
      await __t.wait(300);
      [...document.querySelectorAll(".settings-confirm-actions button")]
        .find((b) => b.textContent.includes("放弃并读取"))?.click();
      await __t.wait(700);
      __t.key("Escape");
      await __t.wait(300);
      [...document.querySelectorAll(".settings-discard .ghost-mini")].find((b) => b.textContent.includes("放弃并关闭"))?.click();
      await __t.wait(300);
      return { ok: asked && stayed && __t.modal() == null, detail: { asked, stayed, closed: __t.modal() == null } };
    `,
  },
  {
    name: "授权卡压在遮罩之上(超时不被设置页吃掉)",
    code: `
      // 真 #approval-slot 只在有待处理授权时挂载(零会话夹具里没有),
      // 所以插一个同 id 的探针元素来验规则本身是否进了样式表。
      const probe = document.createElement("div");
      probe.id = "approval-slot";
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const got = { zIndex: style.zIndex, position: style.position };
      probe.remove();
      return { ok: got.zIndex === "80" && got.position === "fixed", detail: got };
    `,
  },
  {
    name: "零会话也能开设置(config.load 用 service_query 且不带 session id)",
    code: `
      const bootErrorShown = document.querySelector(".boot-error") != null;
      __t.key(",", { ctrlKey: true });
      await __t.wait(600);
      const loads = __t.calls("config.load");
      return { ok: !bootErrorShown && __t.modal() != null && loads.length >= 1
                 && loads.every((call) => Object.keys(call.params ?? {}).length === 0),
               detail: { bootErrorShown, opened: __t.modal() != null, commands: loads.map((call) => call.command) } };
    `,
  },
];

const child = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-settings-"))}`,
    "--window-size=1280,1000",
    "--disable-gpu",
    "--no-first-run",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    TARGET,
  ],
  { stdio: "ignore" },
);

let failed = 0;
try {
  const wsUrl = await waitForTarget();
  const cdp = connect(wsUrl);
  await cdp.open;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // vite 首次请求会补优化依赖并整页 reload → 注入过的 helper 会跟着没了。
  // 所以每步之前确认 helper 在,不在就重注入(探针 `__qaqhProbe` 由页面自己装)。
  const ensure = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await cdp
        .evaluate(`(() => ({ probe: !!window.__qaqhProbe, helper: !!window.__t }))()`, 10_000)
        .catch(() => ({ probe: false, helper: false }));
      if (state.probe && state.helper) return;
      if (state.probe && !state.helper) {
        await cdp.evaluate(BOOTSTRAP);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("夹具页面未就绪(__qaqhProbe 缺失)");
  };

  await ensure();
  await cdp.evaluate(`(async () => { await window.__t.wait(1_200); return "ready"; })()`);

  const results = [];
  for (const step of steps) {
    await ensure();
    const value = await cdp.evaluate(`(() => { const __t = window.__t; return (async () => {${step.code}})(); })()`);
    const ok = value?.ok === true;
    if (!ok) failed += 1;
    results.push({ name: step.name, ok, detail: value?.detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${step.name}`);
    if (!ok) console.log(`      ${JSON.stringify(value?.detail)}`);
  }

  // 截图:重新打开浮层,停在有改动状态。
  await ensure();
  await cdp.evaluate(`(() => { const __t = window.__t; return (async () => {
    if (__t.modal() == null) __t.key(",", { ctrlKey: true });
    await __t.wait(700);
    // 切换式单页:截图停在新的「存档」分区。
    __t.nav("section-profiles");
    await __t.wait(300);
    return "shot-ready";
  })(); })()`);
  mkdirSync(dirname(SHOT), { recursive: true });
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  // 第二张:切到子代理 pane,看子代理字段与底部保存栏(原「滚到底」语义的 pane 版)。
  await cdp.evaluate(`(() => { const __t = window.__t; return (async () => {
    __t.nav("section-subagent");
    await __t.wait(300);
    return document.querySelector(".settings-foot-state")?.innerText ?? "";
  })(); })()`);
  const bottom = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(SHOT_BOTTOM, Buffer.from(bottom.data, "base64"));

  const noise = [...exceptions, ...consoleErrors];
  console.log(`\n结果:${steps.length - failed}/${steps.length} 通过;截图 ${SHOT}`);
  if (noise.length > 0) {
    console.log(`页面异常/控制台报错 ${noise.length} 条:`);
    for (const line of noise.slice(0, 6)) console.log(`  ${line.split("\n")[0]}`);
    failed += 1;
  }
} catch (error) {
  failed += 1;
  console.error(`驱动失败:${error?.message ?? error}`);
} finally {
  child.kill();
}
process.exit(failed === 0 ? 0 : 1);
