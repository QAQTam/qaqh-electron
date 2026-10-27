/**
 * 开发者模式:连点「关于」页的版本串 5 次(相邻间隔 ≤600ms)解锁调试控制台。
 *
 * 刻意**不落盘**(与 `theme.ts`/`visual.ts` 的 localStorage 粘性相反):这是会话级的
 * 调试态而不是偏好,重启就该回到关着——省掉「上次调试开着,这轮复现到底有没有
 * 控制台的影响」这类问题。连点规则保持纯函数,便于把 600ms 窗口这条唯一容易写错
 * 的地方交给单测。
 */
import { createSignal } from "solid-js";

export const UNLOCK_CLICKS = 5;
export const UNLOCK_MAX_GAP_MS = 600;

export interface UnlockStreak {
  stamps: number[];
  unlocked: boolean;
}

/**
 * 相邻间隔超窗、或时钟回拨(系统时间被改/NTP 校正)都从头计数。
 *
 * 只看「上一次点击」而不是「第一次点击」:否则慢速连点会因为总时长超窗而永远
 * 解不开,而 600ms 的本意就是「手别停」。
 */
export function pushUnlockClick(stamps: readonly number[], now: number): UnlockStreak {
  const last = stamps.length > 0 ? stamps[stamps.length - 1] : null;
  const continuing = last != null && now >= last && now - last <= UNLOCK_MAX_GAP_MS;
  const next = continuing ? [...stamps, now] : [now];
  return { stamps: next, unlocked: next.length >= UNLOCK_CLICKS };
}

const [devMode, setDevMode] = createSignal(false);
const [devConsoleOpen, setDevConsoleOpen] = createSignal(false);

export { devMode, devConsoleOpen };

export const openDevConsole = (): void => {
  setDevMode(true);
  setDevConsoleOpen(true);
};

export const closeDevConsole = (): void => {
  setDevConsoleOpen(false);
};

/** 收回开发者模式:控制台一并关,再点版本串要重新连点 5 次。 */
export const disableDevMode = (): void => {
  setDevConsoleOpen(false);
  setDevMode(false);
};
