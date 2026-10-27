/** 内存快照的展示层逻辑:字节缺测必须显式「—」,phase 增量合并不能装作连续。 */
import { describe, expect, it } from "vitest";
import {
  PHASE_KEEP,
  formatBytes,
  formatClock,
  isScopeError,
  mergePhaseSamples,
  sessionEstimateBytes,
  type PhaseSample,
  type SessionMemory,
} from "../src/lib/memwatch";

const phase = (sequence: number, resident: number | null = 1_000): PhaseSample => ({
  sequence,
  at_ms: 1_700_000_000_000 + sequence * 1000,
  phase: "context.build",
  kind: "context_build",
  session_id: null,
  process: { resident_bytes: resident, private_bytes: null, virtual_bytes: null, peak_resident_bytes: null, source: "test", error: null },
  store_heap_estimate_bytes: 10,
  context_payload_bytes: 1,
  estimate_json_bytes: 1,
});

const session = (store: number, aux: number, context: number): SessionMemory => ({
  session_id: "s",
  resident: true,
  message_count: 0,
  turn_count: 0,
  content_block_count: 0,
  text_bytes: 0,
  image_bytes: 0,
  store_heap_estimate_bytes: store,
  agent_aux_heap_estimate_bytes: aux,
  pending_persist_ops: 0,
  context_message_count: 0,
  context_payload_bytes: context,
  estimate_json_bytes: 0,
  last_phase: "",
  last_phase_kind: "other",
  updated_at_ms: 0,
});

describe("formatBytes", () => {
  it("把缺测摊成显式的「—」而不是 0", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("按二进制单位进位", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    // 三位数起不收小数,免得 999.6MB 显示成「999.6 MB」这种半位精度。
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(Math.round(999.6 * 1024 * 1024))).toBe("1000 MB");
  });
});

describe("formatClock", () => {
  it("无值与 0 都给「—」", () => {
    expect(formatClock(null)).toBe("—");
    expect(formatClock(0)).toBe("—");
  });
});

describe("mergePhaseSamples", () => {
  it("按序号去重并升序保留", () => {
    const merged = mergePhaseSamples([phase(2), phase(1)], [phase(3), phase(2)]);
    expect(merged.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  it("没有新行时原样保留(增量快照的常态)", () => {
    const existing = [phase(1), phase(2)];
    expect(mergePhaseSamples(existing, [])).toEqual(existing);
  });

  it("超上限时截尾,保留最近的", () => {
    const many = Array.from({ length: PHASE_KEEP + 5 }, (_, index) => phase(index + 1));
    const merged = mergePhaseSamples(many, [phase(PHASE_KEEP + 6)]);
    expect(merged).toHaveLength(PHASE_KEEP);
    expect(merged[merged.length - 1]?.sequence).toBe(PHASE_KEEP + 6);
    expect(merged[0]?.sequence).toBe(7);
  });
});

describe("isScopeError", () => {
  it("认得 daemon 的 admin scope 拒绝", () => {
    expect(isScopeError(new Error("server error 403 (insufficient_scope): this endpoint requires Admin scope"))).toBe(true);
    expect(isScopeError("command rejected (forbidden): nope")).toBe(false);
  });
});

it("会话估算合计与 daemon 排序口径同组字段", () => {
  expect(sessionEstimateBytes(session(100, 20, 5))).toBe(125);
});
