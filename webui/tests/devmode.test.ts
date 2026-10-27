/** 开发者模式连点规则:600ms 相邻窗口是唯一容易写错的边界(spec:5 次,最大间隔 600ms)。 */
import { describe, expect, it } from "vitest";
import { UNLOCK_CLICKS, UNLOCK_MAX_GAP_MS, pushUnlockClick } from "../src/lib/devmode";

const base = 1_700_000_000_000;

describe("pushUnlockClick", () => {
  it("要求点满 5 次才解锁", () => {
    expect(UNLOCK_CLICKS).toBe(5);
    let stamps: number[] = [];
    for (let index = 1; index < UNLOCK_CLICKS; index += 1) {
      const streak = pushUnlockClick(stamps, base + index * 100);
      stamps = streak.stamps;
      expect(streak.unlocked, `第 ${index} 次不该解锁`).toBe(false);
    }
    const fifth = pushUnlockClick(stamps, base + UNLOCK_CLICKS * 100);
    expect(fifth.unlocked).toBe(true);
    expect(fifth.stamps).toHaveLength(UNLOCK_CLICKS);
  });

  it("相邻间隔正好 600ms 仍算连点,再多 1ms 就重开", () => {
    const inside = pushUnlockClick([base], base + UNLOCK_MAX_GAP_MS);
    expect(inside.stamps).toHaveLength(2);

    const outside = pushUnlockClick([base], base + UNLOCK_MAX_GAP_MS + 1);
    expect(outside.stamps, "超窗后只留本次点击").toEqual([base + UNLOCK_MAX_GAP_MS + 1]);
    expect(outside.unlocked).toBe(false);
  });

  it("窗口只看相邻一次点击,慢速但持续的连点不该永远解不开", () => {
    // 每 500ms 一下:总时长 2s 早已超窗,但相邻间隔始终合规。
    let stamps: number[] = [];
    for (let index = 1; index <= UNLOCK_CLICKS; index += 1) {
      const streak = pushUnlockClick(stamps, base + index * 500);
      stamps = streak.stamps;
      if (index === UNLOCK_CLICKS) expect(streak.unlocked).toBe(true);
    }
    expect(stamps).toHaveLength(UNLOCK_CLICKS);
  });

  it("时钟回拨不累加(NTP 校正不能让等待变成解锁)", () => {
    const back = pushUnlockClick([base], base - 50);
    expect(back.stamps).toEqual([base - 50]);
    expect(back.unlocked).toBe(false);
  });

  it("解锁后继续点仍然算解锁态", () => {
    const stamps = Array.from({ length: UNLOCK_CLICKS - 1 }, (_, index) => base + index * 50);
    expect(pushUnlockClick(stamps, base + (UNLOCK_CLICKS - 1) * 50).unlocked).toBe(true);
  });
});
