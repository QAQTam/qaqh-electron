import { describe, expect, test } from "vitest";
import { overlayLocalTitles } from "../src/session/title-override";

type Row = { session_id: string; title?: string | null };

describe("overlayLocalTitles(方案A:后端优先的本地标题覆盖)", () => {
  test("后端缺标题时叠本地覆盖", () => {
    const list: Array<Row> = [
      { session_id: "a" },
      { session_id: "b", title: null },
      { session_id: "c", title: "  " },
    ];
    const { merged } = overlayLocalTitles(list, { a: "本地A", b: "本地B", c: "本地C" });
    expect(merged[0]!.title).toBe("本地A");
    expect(merged[1]!.title).toBe("本地B");
    expect(merged[2]!.title).toBe("本地C");
  });

  test("后端标题恒优先,对应本地条目被记为陈旧", () => {
    const list: Array<Row> = [
      { session_id: "a", title: "后端A" },
      { session_id: "b" },
    ];
    const { merged, staleSeeds } = overlayLocalTitles(list, { a: "本地A", b: "本地B" });
    expect(merged[0]!.title).toBe("后端A");
    expect(merged[1]!.title).toBe("本地B");
    expect(staleSeeds).toEqual(["a"]);
  });

  test("无本地覆盖时原样返回,不产生陈旧条目", () => {
    const list: Array<Row> = [{ session_id: "a", title: "后端A" }];
    const { merged, staleSeeds } = overlayLocalTitles(list, {});
    expect(merged).toEqual(list);
    expect(staleSeeds).toEqual([]);
  });
});
