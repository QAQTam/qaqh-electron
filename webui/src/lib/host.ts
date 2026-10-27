/** Shared Electron host bridge entry points (invoke/listen/runtime checks). */
export { invoke, listen } from "./transport/electron-core";
export type { Event, UnlistenFn } from "./transport/electron-core";
export { desktopHost, isDesktopRuntime, requireDesktopHost } from "./desktop-host";
