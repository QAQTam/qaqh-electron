/**
 * 宿主级状态:连接诊断、窗口/托盘状态与模型选择器的变更广播。
 *
 * 这些信号独立于任何会话标签;App 在装配期订阅一次,设置页的「桌面壳」面板
 * 直接读同一份状态,避免每个页面各自订阅造成事件顺序不一致。
 */
import { createSignal } from "solid-js";
import type { WindowState } from "./desktop-host";
import { listen } from "./host";
import { listenHostDiagnostics, type ReconnectStatusWire } from "./transport";

export type ModelPickerChange = {
  sessionId: string | null;
  selection: unknown;
  alsoDefault: boolean;
};

/** D1 兼容性失败详情;null = 正常。 */
export const [hostIncompatible, setHostIncompatible] = createSignal<Record<string, unknown> | null>(null);
export const [hostActionNote, setHostActionNote] = createSignal<string | null>(null);
/** 最近的宿主/daemon 通信错误。 */
export const [hostError, setHostError] = createSignal<string | null>(null);
/** 最近一次宿主 liveness 事件的时间戳(不是心跳;静默会话可能很久没有事件)。 */
export const [lastLivenessAt, setLastLivenessAt] = createSignal<number | null>(null);
/** 最近一次宿主安排的 SSE 重连。 */
export const [lastReconnect, setLastReconnect] = createSignal<ReconnectStatusWire | null>(null);
/** Electron 窗口/托盘状态。 */
export const [hostWindowState, setHostWindowState] = createSignal<WindowState | null>(null);
/** 原生模型选择器保存后递增,App 用它刷新配置与会话 profile。 */
export const [modelPickerRevision, setModelPickerRevision] = createSignal(0);

export async function initHostStatus(): Promise<() => void> {
  const unlisteners: Array<() => void> = [];
  unlisteners.push(
    await listenHostDiagnostics({
      onIncompatible: (details) => {
        setHostActionNote(null);
        setHostIncompatible(details);
      },
      onHostError: (message) => {
        setHostError(message);
      },
      onLiveness: (at) => {
        setLastLivenessAt(at);
        // A live host recovered the channel; do not keep a stale error banner
        // pinned forever after a transient drop.
        setHostError(null);
      },
      onReconnect: (info) => setLastReconnect(info),
    }),
  );
  unlisteners.push(
    await listen<ModelPickerChange>("model-picker:changed", () => {
      setModelPickerRevision((value) => value + 1);
    }),
  );
  unlisteners.push(
    await listen<WindowState>("app://window-state", (event) => {
      setHostWindowState(event.payload);
    }),
  );
  return () => {
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}

/** 给「最后事件」一个稳定的人类可读值;不把 liveness 说成心跳。 */
export function formatLiveness(at: number | null, now = Date.now()): string {
  if (at == null) return "尚未收到宿主事件";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}
