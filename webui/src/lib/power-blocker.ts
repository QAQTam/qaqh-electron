/**
 * 休眠限制(用户需求,Linux+Windows)的 renderer 侧封装。
 *
 * 主进程用 Electron 原生 `powerSaveBlocker`(Linux 走 D-Bus inhibit,Windows 走
 * SetThreadExecutionState),这里只做三件事:模式归一化、双开关↔模式互转、
 * localStorage 偏好记忆(启动时由设置页重新 set,主进程不持久化)。
 * 本文件刻意不 import solid —— 纯逻辑进 node 环境单测(tests/power-blocker.test.ts)。
 */
import { desktopHost, type PowerBlockerMode, type PowerBlockerState } from "./desktop-host";

// 消费方(设置页)从这里取类型:模式枚举的"单一入口"在壳能力层面。
export type { PowerBlockerMode, PowerBlockerState };

const STORAGE_KEY = "qaqh.power-blocker";

export const POWER_MODES: readonly PowerBlockerMode[] = ["off", "keep-awake", "keep-awake-bright"];

/** 非法/未知值一律退到 off:localStorage 可能被手改或来自旧版本。 */
export function normalizeMode(value: unknown): PowerBlockerMode {
  return POWER_MODES.includes(value as PowerBlockerMode) ? (value as PowerBlockerMode) : "off";
}

/** 两个开关 → 模式:屏幕常亮蕴含阻止休眠;关掉「阻止休眠」时忽略常亮。 */
export function modeFromToggles(keepAwake: boolean, keepBright: boolean): PowerBlockerMode {
  if (keepBright) return "keep-awake-bright";
  if (keepAwake) return "keep-awake";
  return "off";
}

/** 模式 → 两个开关的回显态。 */
export function togglesFromMode(mode: PowerBlockerMode): { keepAwake: boolean; keepBright: boolean } {
  return {
    keepAwake: mode !== "off",
    keepBright: mode === "keep-awake-bright",
  };
}

/** 面向用户的模式描述;active=false 表示主进程侧 blocker 未生效(异常态)。 */
export function describeMode(mode: PowerBlockerMode, active: boolean): string {
  if (mode === "off" || !active) return "未启用";
  if (mode === "keep-awake-bright") return "阻止休眠 + 屏幕常亮";
  return "阻止休眠（允许熄屏）";
}

export function storedPowerMode(): PowerBlockerMode {
  try {
    return normalizeMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "off";
  }
}

function savePowerMode(mode: PowerBlockerMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存不下不影响本次生效;下次启动回到 off。
  }
}

/**
 * 应用模式。无桌面壳(浏览器 dev)返回 null,由调用方决定提示方式;
 * 成功时把偏好落盘,启动重放由 HostSection 负责。
 */
export async function applyPowerMode(mode: PowerBlockerMode): Promise<PowerBlockerState | null> {
  const bridge = desktopHost()?.powerBlocker;
  if (bridge == null) return null;
  const state = await bridge.set(mode);
  savePowerMode(normalizeMode(state.mode));
  return state;
}

/** 启动重放:把上次会话的偏好重新应用到主进程;off 或无壳时只查状态。 */
export async function restorePowerMode(): Promise<PowerBlockerState | null> {
  const bridge = desktopHost()?.powerBlocker;
  if (bridge == null) return null;
  const mode = storedPowerMode();
  return mode === "off" ? bridge.state() : bridge.set(mode);
}
