/** 事件流日志:关着开发者模式时一个字都不记,开着时才进环形缓冲。 */
import { afterEach, describe, expect, it } from "vitest";
import { clearDevLog, devLogEntries, noteEvent, noteRpc } from "../src/lib/devlog";
import { disableDevMode, openDevConsole } from "../src/lib/devmode";

afterEach(() => {
  disableDevMode();
  clearDevLog();
});

describe("devlog", () => {
  it("未解锁开发者模式时不记录", () => {
    noteRpc("config.load", Date.now() - 5, null);
    noteEvent("timeline://entry", { session_id: "s", entry: { index: 3 } });
    expect(devLogEntries()).toHaveLength(0);
  });

  it("解锁后记录 RPC 与事件,conn://error 归到故障类", () => {
    openDevConsole();
    noteRpc("config.save", Date.now() - 12, null);
    noteEvent("projection://event", { type: "turn_started", session_id: "seed_a" });
    noteEvent("conn://error", { message: "daemon died" });
    const rows = devLogEntries();
    expect(rows.map((row) => row.kind)).toEqual(["rpc", "event", "error"]);
    expect(rows[0]?.failed).toBe(false);
    expect(rows[2]?.failed).toBe(true);
    expect(rows[1]?.detail).toContain("turn_started");
    expect(rows[1]?.ms).toBeNull();
  });

  it("RPC 失败也记,且标记为失败", () => {
    openDevConsole();
    noteRpc("diagnostics.memory.snapshot", Date.now(), new Error("server error 403 (insufficient_scope)"));
    const [row] = devLogEntries();
    expect(row?.failed).toBe(true);
    expect(row?.detail).toContain("insufficient_scope");
  });

  it("payload 太大时只留摘要文本,不整包进缓冲", () => {
    openDevConsole();
    noteEvent("timeline://entry", { type: "message", blob: "x".repeat(50_000) });
    const [row] = devLogEntries();
    expect((row?.detail ?? "").length).toBeLessThan(200);
  });

  it("缓冲有界,超出上限丢最旧", () => {
    openDevConsole();
    for (let index = 0; index < 420; index += 1) noteEvent("projection://event", { index });
    const rows = devLogEntries();
    expect(rows).toHaveLength(400);
    expect(rows[0]?.detail).toContain("index=20");
  });
});
