/**
 * widget-directive §2/§3：marker 挂载点的水合宿主。
 *
 * 链路：directive 渲染出 `<div class="qqh-widget-mount" data-qqh-*>` →
 * 本模块把挂载点替换成 sandbox iframe。fragment 文本经 daemon `fs.read`
 * 读取（scope 到本会话工作区），与桥脚本、状态占位、主题 token 一起组装
 * 成 srcdoc 注入——opaque-origin 沙箱，禁 allow-same-origin，通道走
 * MessageChannel（Codex 加固的移植见 bridge.ts）。
 *
 * 状态（§3/§4）：`setWidgetState` 快照乐观写入本地存储（Electron userData，
 * dev 浏览器退回 localStorage——check 页所在层），按 fragment 绝对路径键
 * （path 唯一编码 workspace+session）；followUp 确认时携带**当下最新**
 * modelContent 交给 ctx.sendFollowUp 走 RingingV2 user-send。
 */
import { BRIDGE_SOURCE } from "./bridge";
import { transport, openExternalUrl } from "../lib/transport";
import { desktopHost } from "../lib/desktop-host";

export interface WidgetRefWire {
  path: string;
  title?: string;
}

export interface WidgetHostContext {
  sessionId: string;
  /** 用户确认后的 follow-up：带最新 modelContent 快照进 user-send（§4）。 */
  sendFollowUp(prompt: string, widget: WidgetRefWire, modelContent: unknown): Promise<void>;
  /**
   * fragment 读取注入点（widget-check 无 daemon 层的用例）。默认走
   * daemon `fs.read`（工作区白名单内），生产路径不传。
   */
  readFragment?: (path: string) => Promise<string | null>;
}

interface WidgetSnapshot {
  modelContent: unknown;
  privateContent: unknown;
}

const INITIAL_HEIGHT_PX = 240;
const MAX_HEIGHT_PX = 10000;
const FRAGMENT_MAX_BYTES = 1024 * 1024; // spec §2：单文件 ≤1MB

const storage = (): Pick<Storage, "getItem" | "setItem"> | null => {
  const host = desktopHost();
  if (host) {
    // Electron：userData 文件存储走主进程命令（pointer docs §状态存储）。
    return {
      getItem: (key: string) =>
        // 同步面不存在：hydrate 前 await warmSnapshot，见 readSnapshot。
        hostSnapshotCache.get(key) ?? null,
      setItem: (key: string, value: string) => {
        hostSnapshotCache.set(key, value);
        void host.invoke("widget_state_put", { key, value }).catch(() => {
          /* best-effort：userData 写失败不阻塞 UI，下轮快照仍会重试 */
        });
      },
    };
  }
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
};

const hostSnapshotCache = new Map<string, string>();
let hostSnapshotHydrated = false;

async function ensureHostSnapshotCache(): Promise<void> {
  const host = desktopHost();
  if (!host || hostSnapshotHydrated) return;
  hostSnapshotHydrated = true;
  // 启动期一次批量拉取；挂载时只读内存。
  const values = await host
    .invoke<Record<string, string>>("widget_state_get_all")
    .catch(() => ({}));
  for (const [key, value] of Object.entries(values ?? {})) {
    hostSnapshotCache.set(key, value);
  }
}

// 存储键即 fragment 绝对路径：path 在磁盘上全局唯一，天然编码了
// workspace 与 session（pointer docs 的 `workspace|session|path` 三段键
// 等价收缩——2026-11-12 实施裁定，避免把易变的 workspace 句柄传进渲染层）。
function snapshotKey(_ctx: WidgetHostContext, path: string): string {
  return path;
}

function readSnapshot(ctx: WidgetHostContext, path: string): WidgetSnapshot | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(snapshotKey(ctx, path));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WidgetSnapshot;
    return parsed;
  } catch {
    return null;
  }
}

function writeSnapshot(ctx: WidgetHostContext, path: string, snapshot: WidgetSnapshot): void {
  storage()?.setItem(snapshotKey(ctx, path), JSON.stringify(snapshot));
}

/** srcdoc 组装：`<` 转义防 `</script>` 逃逸（§3）。 */
function embedJson(json: string): string {
  return json.replace(/</g, "\\u003c");
}

function themeTokens(): string {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value !== "" ? value : fallback;
  };
  return [
    `--qqh-fg:${read("--text", "#1c1f24")};`,
    `--qqh-bg:${read("--surface", "#ffffff")};`,
    `--qqh-muted:${read("--muted", "#5a616e")};`,
    `--qqh-accent:${read("--accent", "#1e5adb")};`,
    `--qqh-border:${read("--border", "#d2d6df")};`,
    `--qqh-font:system-ui,-apple-system,'Segoe UI',sans-serif;`,
  ].join("");
}

const FRAGMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com " +
  "https://esm.sh https://cdn.jsdelivr.net https://unpkg.com; " +
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net " +
  "https://unpkg.com https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com https://fonts.bunny.net; " +
  "img-src data: blob: https:; connect-src 'none'";

export function buildWidgetDocument(fragment: string, snapshot: WidgetSnapshot | null): string {
  const stateJson = snapshot === null ? "null" : JSON.stringify(snapshot);
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv=\"Content-Security-Policy\" content=\"${FRAGMENT_CSP}\">` +
    `<style>:root{color-scheme:light dark;${themeTokens()}}` +
    "html,body{margin:0;padding:0;background:transparent;color:var(--qqh-fg);" +
    "font:14px/1.5 var(--qqh-font)}</style>" +
    `<script type=\"application/json\" id=\"qqh-widget-state\">${embedJson(stateJson)}</script>` +
    `<script>${BRIDGE_SOURCE}</script></head><body>${fragment}</body></html>`
  );
}

/** JSON 失败/读取失败的行内降级占位（spec §1 降级规则的呈现面）。 */
function fallbackLine(mount: HTMLElement, reason: string): void {
  mount.className = "qqh-widget-fallback";
  const title = mount.dataset["qqhTitle"] ?? "widget";
  mount.textContent = `widget: ${title}（${reason}）`;
  mount.removeAttribute("data-qqh-path");
}

/**
 * fs.read 读 fragment。daemon 白名单已放行工作区内 `.qaqh/widgets/**`
 * （scope_session 锁会话工作区，越界 fail-closed）。
 */
async function readFragment(ctx: WidgetHostContext, path: string): Promise<string | null> {
  try {
    const result = await transport.query("fs.read", {
      path,
      max_bytes: FRAGMENT_MAX_BYTES,
      scope_session_id: ctx.sessionId,
    });
    const record = result as { content?: unknown; truncated?: boolean } | null;
    if (typeof record?.content !== "string") return null;
    // 超限（>1MB）的 fragment 不符合契约，拒绝渲染半截源码。
    if (record.truncated) return null;
    return record.content;
  } catch {
    return null;
  }
}

function mountWidget(mount: HTMLElement, ctx: WidgetHostContext): void {
  const path = mount.dataset["qqhPath"];
  if (!path) return;
  mount.dataset["qqhMounted"] = "1";
  void (async () => {
    await ensureHostSnapshotCache();
    const snapshot = readSnapshot(ctx, path);
    const fragment = await (ctx.readFragment
      ? ctx.readFragment(path)
      : readFragment(ctx, path));
    if (fragment === null) {
      fallbackLine(mount, "不可用");
      return;
    }
    const frame = document.createElement("iframe");
    frame.className = "qqh-widget-frame";
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-modals allow-popups",
    );
    frame.style.height = `${INITIAL_HEIGHT_PX}px`;
    frame.dataset["qqhTitle"] = mount.dataset["qqhTitle"] ?? "";
    frame.srcdoc = buildWidgetDocument(fragment, snapshot);

    const channel = new MessageChannel();
    const port = channel.port1;
    const onReady = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { t?: string } | null;
      if (data?.t !== "ready") return;
      // ready 只接一次握手，随即移交 port2 并撤销本监听。
      window.removeEventListener("message", onReady);
      frame.contentWindow?.postMessage({ t: "port-handshake" }, "*", [channel.port2]);
    };
    window.addEventListener("message", onReady);
    let latest: WidgetSnapshot = snapshot ?? { modelContent: null, privateContent: null };
    port.onmessage = (event) => {
      const data = event.data as
        | { t: string; h?: number; modelContent?: unknown; privateContent?: unknown; prompt?: string; title?: string; href?: string }
        | null;
      if (!data) return;
      switch (data.t) {
        case "height": {
          if (typeof data.h === "number") {
            frame.style.height = `${Math.min(MAX_HEIGHT_PX, Math.max(INITIAL_HEIGHT_PX, Math.ceil(data.h)))}px`;
          }
          return;
        }
        case "state": {
          latest = { modelContent: data.modelContent ?? null, privateContent: data.privateContent ?? null };
          writeSnapshot(ctx, path, latest);
          return;
        }
        case "followUp": {
          const prompt = typeof data.prompt === "string" ? data.prompt : "";
          if (!prompt) return;
          const title = typeof data.title === "string" && data.title !== "" ? data.title : "发送到对话";
          void confirmFollowUp(title, prompt, async () => {
            try {
              await ctx.sendFollowUp(prompt, { path, title: mount.dataset["qqhTitle"] }, latest.modelContent);
            } catch (error) {
              console.warn("[widget] follow-up rejected:", error);
            }
          });
          return;
        }
        case "openExternal": {
          if (typeof data.href === "string") void openExternalUrl(data.href);
          return;
        }
        default:
          return;
      }
    };
    mount.replaceChildren(frame);
  })();
}

// ── 确认浮层（§3：title 是确认弹窗标题；拒绝即 no-op）──────────────────
let activeDialog: HTMLElement | null = null;

function confirmFollowUp(title: string, prompt: string, onConfirm: () => void): void {
  activeDialog?.remove();
  const overlay = document.createElement("div");
  overlay.className = "qqh-widget-dialog-overlay";
  const box = document.createElement("div");
  box.className = "qqh-widget-dialog";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const heading = document.createElement("div");
  heading.className = "qqh-widget-dialog-title";
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = "qqh-widget-dialog-body";
  body.textContent = prompt;
  const actions = document.createElement("div");
  actions.className = "qqh-widget-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "qqh-widget-dialog-cancel";
  cancel.textContent = "取消";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "qqh-widget-dialog-send";
  send.textContent = "发送";
  const close = (): void => {
    overlay.remove();
    if (activeDialog === overlay) activeDialog = null;
  };
  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  send.addEventListener("click", () => {
    close();
    onConfirm();
  });
  actions.append(cancel, send);
  box.append(heading, body, actions);
  overlay.append(box);
  document.body.append(overlay);
  activeDialog = overlay;
  send.focus();
}

/**
 * 扫描挂载点并水合（Markdown 的 sealInto / 封口尾块后调用）。
 * 已水合节点靠 dataset 标记跳过——patchMarkdown 重建 DOM 即重挂载，
 * 读取路径以磁盘为真相（更新=重写同路径）。
 */
export function hydrateWidgetMounts(root: ParentNode, ctx: WidgetHostContext): void {
  if (ctx.sessionId === "") return;
  for (const mount of Array.from(root.querySelectorAll<HTMLElement>("div.qqh-widget-mount[data-qqh-path]"))) {
    if (mount.dataset["qqhMounted"] === "1") continue;
    mountWidget(mount, ctx);
  }
}
