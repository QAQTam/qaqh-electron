/**
 * 插件主题链路真壳 E2E（定向,不进 `node --test scripts/*.test.mjs` 全局套）。
 *
 * 用法: node scripts/plugin-theme.e2e.mjs
 *
 * 起真实 Electron（app://localhost 加载 renderer/ 构建产物,独立 user-data-dir
 * 避开单实例锁）,验证用户投诉的「主题包插件不生效」整链:
 *   graph 帧到达 → 选择主题包 → <link> 挂载 → CSS 真实 fetch+解析 →
 *   --chat-* 未分层覆写压过 @layer tokens → overlay(snake) 同链挂载。
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright");
const electronPath = require("electron");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const userData = mkdtempSync(join(tmpdir(), "qaqh-plugin-e2e-"));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

let app;
try {
  const env = { ...process.env };
  delete env.QAQH_DEV_URL; // 强制走 app:// 产物路径,与打包态同源语义一致
  app = await _electron.launch({
    executablePath: electronPath,
    args: [root, `--user-data-dir=${userData}`, "--no-sandbox"],
    cwd: root,
    env,
    timeout: 90_000,
  });
  const page = await app.firstWindow();
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));
  await page.waitForLoadState("domcontentloaded");

  // 选择主题包(设置页同键),强制 light 档,整页重载让装载器从 localStorage 恢复。
  await page.evaluate(() => {
    localStorage.setItem("qaqh.theme-pack", "qaqh-theme-warmpaper");
    localStorage.setItem("qaqh.theme", "light");
    localStorage.setItem("qaqh.syntax-pack", "qaqh-syntax-warmpaper");
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // graph 帧 + reconcile 是异步的:等 link 出现(20s 护栏)。
  let linkAttached = true;
  try {
    await page.locator("link[data-qaqh-theme-pack]").waitFor({ state: "attached", timeout: 20_000 });
  } catch {
    linkAttached = false;
  }
  check("主题 link 挂载(graph 帧到达且选择被消费)", linkAttached);

  const info = await page.evaluate(async () => {
    const link = document.querySelector('link[data-qaqh-theme-pack]');
    document.documentElement.dataset.theme = "light";
    let rules = -1;
    let ruleError = "";
    try { rules = link?.sheet ? link.sheet.cssRules.length : -1; }
    catch (e) { ruleError = String(e); }
    // 直接 fetch 插件 CSS:看状态码/Content-Type/CORS 头,定位拦截层。
    let probe = null;
    try {
      const res = await fetch(link?.href ?? "");
      const text = await res.text();
      probe = {
        status: res.status,
        contentType: res.headers.get("content-type"),
        acao: res.headers.get("access-control-allow-origin"),
        csp: res.headers.get("content-security-policy")?.slice(0, 80) ?? null,
        bodyHead: text.slice(0, 80),
      };
    } catch (e) { probe = { error: String(e) }; }
    // syntax-theme 资产探针:light.json 必须 200 且是合法 shiki 主题。
    let syntaxProbe = null;
    try {
      const res = await fetch("app://localhost/plugins/qaqh-syntax-warmpaper/light.json");
      const json = await res.json();
      syntaxProbe = { status: res.status, tokenColors: Array.isArray(json.tokenColors) ? json.tokenColors.length : -1, type: json.type };
    } catch (e) { syntaxProbe = { error: String(e) }; }
    return {
      href: link?.getAttribute("href") ?? null,
      rules,
      ruleError,
      probe,
      syntaxProbe,
      chatBg: getComputedStyle(document.documentElement).getPropertyValue("--chat-bg").trim(),
      chatText: getComputedStyle(document.documentElement).getPropertyValue("--chat-text").trim(),
      snakeContainer: !!document.querySelector('[data-qaqh-plugin="qaqh-snake"]'),
      snakeLaunch: !!document.querySelector(".qaqh-snake-launch"),
      origin: location.origin,
    };
  });
  console.log("诊断:", JSON.stringify(info, null, 2));

  // git 插件:容器/徽标证明 import+mount+facade 取数链路通;显式 path 探针证明
  // main 侧只读 git 真实返回仓库状态(新 user-data-dir 无活动会话时徽标是"无工作区"态)。
  const gitInfo = await page.evaluate(async (repoPath) => {
    let probe = null;
    try { probe = await window.qaqhHost.invoke("git_status", { path: repoPath }); }
    catch (e) { probe = { error: String(e) }; }
    return {
      container: !!document.querySelector('[data-qaqh-plugin="qaqh-git"]'),
      badge: document.querySelector(".qaqh-git-badge")?.textContent ?? null,
      kind: probe?.kind ?? null,
      branch: probe?.branch ?? null,
      ahead: probe?.ahead ?? null,
      unstaged: probe?.unstaged ?? null,
      detail: probe?.error ?? probe?.message ?? null,
    };
  }, root);
  console.log("git 插件诊断:", JSON.stringify(gitInfo));
  check("overlay 插件(qaqh-git)容器挂载", gitInfo.container);
  check("git 徽标已渲染(import+mount+facade 取数成功)", typeof gitInfo.badge === "string" && gitInfo.badge.startsWith("⎇"), gitInfo.badge ?? "null");
  check("git_status IPC 返回真实仓库状态", gitInfo.kind === "repo" && typeof gitInfo.branch === "string" && gitInfo.branch !== "", JSON.stringify(gitInfo));

  console.log("=== 页面 console(截取插件/安全相关) ===");
  for (const line of consoleLines) {
    if (/plugin|CSP|Content-Security|Refused|SecurityError|CORS|MIME|snake|import|Failed/i.test(line)) console.log(line);
  }

  check("link href 指向 app:// 插件资产且带 rev", /^app:\/\/localhost\/plugins\/qaqh-theme-warmpaper\/theme\.css\?rev=.+/.test(info.href ?? ""), info.href ?? "null");
  check("CSS 真实加载并可读(同源,非 404/非 CORS 拦截)", info.rules > 0, `cssRules=${info.rules} ${info.ruleError}`);
  check("--chat-bg 被插件覆写为暖纸色(未分层压过 @layer tokens)", info.chatBg.toUpperCase() === "#F7F5EE", info.chatBg);
  check("--chat-text 同族生效", info.chatText.toUpperCase() === "#21201C", info.chatText);
  check("overlay 插件(snake)容器挂载", info.snakeContainer);
  check("snake 唤起按钮存在(JS import+mount 成功)", info.snakeLaunch);
  check("syntax-theme 资产可达且为合法 shiki 主题", info.syntaxProbe?.status === 200 && info.syntaxProbe?.tokenColors > 0 && info.syntaxProbe?.type === "light", JSON.stringify(info.syntaxProbe));
} catch (error) {
  failures.push("launch/evaluate");
  console.error("E2E 异常:", error);
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\n插件主题链路 E2E 全部通过");
