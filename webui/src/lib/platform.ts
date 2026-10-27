/**
 * 平台标记：让浏览器预览、visual-capture 夹具与 Tauri 壳共用同一套 CSS 分支。
 * 只在 DOM 就绪前跑一次；不依赖 Tauri 运行时。
 */
export function markPlatform(): void {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platformStr = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  const root = document.documentElement;
  if (/mac/i.test(platformStr)) {
    root.classList.add("platform-macos");
    root.dataset.platform = "macos";
  } else if (/win/i.test(platformStr)) {
    root.classList.add("platform-windows");
    root.dataset.platform = "windows";
  } else {
    root.classList.add("platform-linux");
    root.dataset.platform = "linux";
  }
  if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null) {
    root.classList.add("tauri");
  }
}
