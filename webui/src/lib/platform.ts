/**
 * 平台标记：让 visual-capture 夹具与 Electron 壳共用同一套 CSS 分支。
 * 只在 DOM 就绪前跑一次；不依赖 Electron 运行时。
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
  if (typeof window !== "undefined" && window.qaqhHost != null) {
    // `desktop` is the Electron shell layout hook; `electron` is kept for
    // compatibility with older visual fixtures.
    root.classList.add("desktop", "electron");
  }
}
