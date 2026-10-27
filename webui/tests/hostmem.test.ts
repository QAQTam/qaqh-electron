/** 「本机」内存的纯逻辑:降级要显式缺,合计要交代口径。 */
import { describe, expect, it } from "vitest";
import { groupRowsByKind, readRendererMemory, summarizeMachineMemory, type ProcessGroup } from "../src/lib/hostmem";
import type { ProcessMemory } from "../src/lib/memwatch";

const process = (overrides: Partial<ProcessMemory> = {}): ProcessMemory => ({
  resident_bytes: 200_000_000,
  private_bytes: 180_000_000,
  virtual_bytes: 2_000_000_000,
  peak_resident_bytes: 240_000_000,
  source: "windows.psapi",
  error: null,
  ...overrides,
});

describe("readRendererMemory", () => {
  it("没有 performance.memory 时全部给 null(WKWebView 那一档)", () => {
    expect(readRendererMemory({}, 120, 2)).toEqual({
      usedJsHeapBytes: null,
      totalJsHeapBytes: null,
      jsHeapLimitBytes: null,
      domNodes: 120,
      childFrames: 2,
    });
  });

  it("上限被报成 0 时按「没给」处理,而不是「上限 0」", () => {
    const read = readRendererMemory({ memory: { usedJSHeapSize: 4000, totalJSHeapSize: 9000, jsHeapSizeLimit: 0 } }, 1, 0);
    expect(read.usedJsHeapBytes).toBe(4000);
    expect(read.jsHeapLimitBytes).toBeNull();
  });

  it("非有限值与负数都不进结果", () => {
    const read = readRendererMemory({ memory: { usedJSHeapSize: Number.NaN, totalJSHeapSize: -1 } }, 0, 0);
    expect(read.usedJsHeapBytes).toBeNull();
    expect(read.totalJsHeapBytes).toBeNull();
  });
});

const group = (members: ProcessGroup["members"]): ProcessGroup => ({ source: "webview2.pids+psapi", error: null, members });
const member = (pid: number, kind: string, resident: number | null): ProcessGroup["members"][number] => ({
  pid,
  kind,
  resident_bytes: resident,
  private_bytes: resident == null ? null : resident - 1_000,
  error: resident == null ? "OpenProcess failed" : null,
});

describe("groupRowsByKind", () => {
  it("同角色合并计数,顺序按首次出现", () => {
    const rows = groupRowsByKind(group([member(1, "browser", 100), member(2, "renderer", 200), member(3, "renderer", 50)]));
    expect(rows.map((row) => [row.kind, row.count, row.resident])).toEqual([
      ["browser", 1, 100],
      ["renderer", 2, 250],
    ]);
  });

  it("读不到的成员进 failed 计数,不冒充 0", () => {
    const [row] = groupRowsByKind(group([member(1, "utility", null), member(2, "utility", 40)]));
    expect(row?.failed).toBe(1);
    expect(row?.resident).toBe(40);
  });

  it("全读不到时 resident 是 null 而不是 0", () => {
    const [row] = groupRowsByKind(group([member(1, "utility", null)]));
    expect(row?.resident).toBeNull();
  });

  it("mac 档没有 private 口径,不能因此判定成员读不到", () => {
    const rows = groupRowsByKind(group([
      { pid: 11, kind: "renderer", resident_bytes: 300_000_000, private_bytes: null, error: null },
      { pid: 12, kind: "network", resident_bytes: 40_000_000, private_bytes: null, error: null },
    ]));
    expect(rows.map((row) => [row.kind, row.failed, row.private])).toEqual([
      ["renderer", 0, null],
      ["network", 0, null],
    ]);
  });

  it("null 组直接空", () => {
    expect(groupRowsByKind(null)).toEqual([]);
  });
});

describe("summarizeMachineMemory", () => {
  it("合计 = 壳 + daemon + 界面进程组 + 页面已用堆", () => {
    const view = summarizeMachineMemory(
      process({ resident_bytes: 100 }),
      process({ resident_bytes: 50, source: "linux.procfs" }),
      { usedJsHeapBytes: 10, totalJsHeapBytes: 20, jsHeapLimitBytes: null, domNodes: 5, childFrames: 0 },
      group([member(1, "browser", 30), member(2, "renderer", 20)]),
    );
    expect(view.totalBytes).toBe(100 + 50 + 50 + 10);
    expect(view.group.map((row) => [row.kind, row.resident])).toEqual([["browser", 30], ["renderer", 20]]);
    expect(view.rows.map((row) => row.id)).toEqual(["shell", "daemon"]);
  });

  it("一个角色里有进程读不到,合计照算但口径要写明", () => {
    const view = summarizeMachineMemory(
      process({ resident_bytes: 100 }),
      null,
      null,
      group([member(1, "gpu", 40), member(2, "utility", null)]),
    );
    expect(view.totalBytes).toBe(140);
    expect(view.excluded).toContain("utility 有 1 个进程读不到");
    expect(view.excluded).toContain("daemon 进程(未读到)");
    expect(view.excluded).toContain("页面 JS 堆");
  });

  it("非 Windows 的 unsupported 组说清原因,而不是静默少一块", () => {
    const view = summarizeMachineMemory(
      process({ resident_bytes: 100 }),
      null,
      null,
      { source: "unsupported", error: "process group counters are not implemented for this target", members: [] },
    );
    expect(view.group).toEqual([]);
    expect(view.excluded.some((line) => line.startsWith("界面进程组("))).toBe(true);
    expect(view.excluded.some((line) => line.includes("not implemented"))).toBe(true);
  });

  it("枚举成功但一条子进程都没有,也要写进口径", () => {
    // 和「不支持」区分开:mac 上 WKWebView 的 helper 若不是直接子进程,枚举会成功
    // 但返回空——那时合计看着像「界面组就是 0」,得让人看出来是没数到。
    const view = summarizeMachineMemory(process({ resident_bytes: 100 }), null, null, group([]));
    expect(view.totalBytes).toBe(100);
    expect(view.excluded).toContain("界面进程组(枚举到 0 个子进程)");
  });

  it("读不到的来源也进 excluded,不悄悄少加", () => {
    const view = summarizeMachineMemory(null, process({ resident_bytes: 50 }), null, null);
    expect(view.rows).toHaveLength(1);
    expect(view.totalBytes).toBe(50);
    expect(view.excluded).toContain("壳进程(未读到)");
    expect(view.excluded).toContain("界面进程组(壳未提供)");
    expect(view.excluded).toContain("页面 JS 堆");
  });

  it("一个数都没有时合计是 null 而不是 0 B", () => {
    const view = summarizeMachineMemory(null, null, null, null);
    expect(view.totalBytes).toBeNull();
    expect(view.rows).toEqual([]);
  });

  it("平台缺 resident 计数时按缺测处理( mac 的 unsupported 分支 )", () => {
    const view = summarizeMachineMemory(
      process({ resident_bytes: null, private_bytes: null, peak_resident_bytes: null, source: "unsupported" }),
      null,
      { usedJsHeapBytes: 7, totalJsHeapBytes: null, jsHeapLimitBytes: null, domNodes: 1, childFrames: 0 },
      null,
    );
    expect(view.totalBytes).toBe(7);
    expect(view.excluded.some((line) => line.includes("resident 缺测"))).toBe(true);
  });
});
