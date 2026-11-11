/**
 * 内嵌浏览器面板（docs/browser-control-design.md）。
 *
 * 渲染层只画"镀铬件"（URL 栏/状态徽标/关闭钮）并测量视口矩形；真正的页面
 * 内容是主进程 WebContentsView（原生层，永远盖在 HTML 之上）。两侧契约：
 *  - 主进程 `browser-view://state` 事件推送 {visible,url,title}；
 *  - 渲染层经 browser_view_viewport 上报测量矩形（可见期间持续上报）；
 *  - 用户侧开合走 browser_view_show / browser_view_hide / browser_view_navigate。
 */
import { createEffect, createSignal, onCleanup, onSettled, Show, type Component } from "solid-js";
import { desktopHost, type BrowserPaneState } from "../lib/desktop-host";

const PANE_HIDDEN: BrowserPaneState = { visible: false, url: "", title: "" };

const BrowserPane: Component = () => {
  const [state, setState] = createSignal<BrowserPaneState>(PANE_HIDDEN);
  const [urlDraft, setUrlDraft] = createSignal("");
  const [booted, setBooted] = createSignal(false);
  let viewport: HTMLDivElement | undefined;
  const host = desktopHost();

  onSettled(() => {
    if (host == null) return;
    void (async () => {
      try {
        const initial = await host.invoke<BrowserPaneState>("browser_view_state");
        setState(initial);
        setUrlDraft(initial.url);
      } catch {
        // 引擎未就绪（初始化失败/未完成）时按隐藏态呈现；事件到达即自愈。
        setState(PANE_HIDDEN);
      }
      setBooted(true);
    })();
    const unlisten = host.listen("browser-view://state", (payload: BrowserPaneState) => {
      setState(payload);
      if (payload.url) setUrlDraft(payload.url);
    });
    onCleanup(unlisten);
  });

  /** 视口测量 → 主进程落位。可见期间持续生效（窗口缩放/侧栏拖拽都覆盖）。 */
  createEffect(
    () => state().visible,
    (visible) => {
      if (!visible || viewport == null || host == null) return;
      const el = viewport;
      const report = (): void => {
        const rect = el.getBoundingClientRect();
        void host.invoke("browser_view_viewport", {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }).catch(() => {});
      };
      report();
      const observer = new ResizeObserver(report);
      observer.observe(el);
      return () => observer.disconnect();
    },
  );

  const go = (raw: string): void => {
    if (host == null) return;
    const value = raw.trim();
    if (value === "") return;
    const url = /^https?:\/\//i.test(value) || value.startsWith("file:") ? value : `https://${value}`;
    void host.invoke("browser_view_navigate", { url }).catch(() => {});
  };

  return (
    <Show when={booted()}>
      <Show
        when={state().visible}
        fallback={
          <Show when={state().url !== ""}>
            <button
              type="button"
              class="browser-pane-reopen"
              title="显示浏览器"
              onClick={() => void host?.invoke("browser_view_show").catch(() => {})}
            >
              浏览器
            </button>
          </Show>
        }
      >
        <div class="browser-pane">
          <div class="browser-pane-bar">
            <span class="browser-pane-agent" title="代理进程正在此页面执行操作">agent</span>
            <input
              class="browser-pane-url"
              type="text"
              value={urlDraft()}
              spellcheck={false}
              onChange={(event) => go(event.currentTarget.value)}
            />
            <button
              type="button"
              class="browser-pane-close"
              title="隐藏浏览器面板"
              onClick={() => void host?.invoke("browser_view_hide").catch(() => {})}
            >
              ×
            </button>
          </div>
          <div class="browser-pane-viewport" ref={viewport} />
        </div>
      </Show>
    </Show>
  );
};

export default BrowserPane;
