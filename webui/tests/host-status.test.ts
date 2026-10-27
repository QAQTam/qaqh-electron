import { describe, expect, it } from "vitest";
import { formatLiveness } from "../src/lib/host-status";

describe("host liveness label", () => {
  it("没有收到宿主事件时不冒充在线", () => {
    expect(formatLiveness(null, 1_000)).toBe("尚未收到宿主事件");
  });

  it("按秒/分钟/小时收敛，不把 liveness 说成心跳", () => {
    const now = 100_000;
    expect(formatLiveness(now - 1_000, now)).toBe("刚刚");
    expect(formatLiveness(now - 12_000, now)).toBe("12 秒前");
    expect(formatLiveness(now - 3 * 60_000, now)).toBe("3 分钟前");
    expect(formatLiveness(now - 2 * 3_600_000, now)).toBe("2 小时前");
  });
});
