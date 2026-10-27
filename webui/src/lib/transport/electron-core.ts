/** Host invoke/listen shim backed by the Electron preload bridge. */
import { desktopHost, type HostCommand, type HostEvent } from "../desktop-host";

export type Event<T> = { payload: T };
export type UnlistenFn = () => void;

export async function invoke<T>(command: HostCommand, args: Record<string, unknown> = {}): Promise<T> {
  const host = desktopHost();
  if (host == null) throw new Error("Electron desktop host is unavailable");
  return host.invoke<T>(command, args);
}

export async function listen<T>(event: HostEvent, callback: (event: Event<T>) => void): Promise<UnlistenFn> {
  const host = desktopHost();
  if (host == null) return () => {};
  return host.listen(event, (payload) => callback({ payload: payload as T }));
}
