/**
 * 内存探测的**夹具**替身:给 stress.html / settings-check.html 这两个 dev-only 入口
 * 造一份会自走的快照,让调试台的表格与图能在没有 daemon 的浏览器里验收。
 *
 * 不进产品构建:两个入口各自 `render()` 时才会 import 到它,`index.html` 那条路径
 * 完全不涉及。数字是编的,但形状严格照 `lib/memwatch.ts` 的 DTO——字段写错的话,
 * 夹具这里先渲染成「—」而不是静默兜底。
 */
import type { MemorySnapshot, PhaseSample } from "./memwatch";

let ticks = 0;

const PHASE_LABELS = [
  "session.resume",
  "context.build",
  "context.estimate",
  "gate.provider_request",
  "compact.apply",
  "request_log.write",
];

/** 每次采样把 resident 抬高一点、并按 `after_sequence` 只回新阶段——和真 daemon 的增量语义一致。 */
export function simMemorySnapshot(afterSequence: number | null = null): MemorySnapshot {
  ticks += 1;
  const now = Date.now();
  const resident = 180_000_000 + ticks * 640_000;
  const phases: PhaseSample[] = [];
  for (let sequence = 1; sequence <= ticks && sequence > ticks - 240; sequence += 1) {
    if (afterSequence != null && sequence <= afterSequence) continue;
    const label = PHASE_LABELS[sequence % PHASE_LABELS.length] ?? "other";
    phases.push({
      sequence,
      at_ms: now - (ticks - sequence) * 1000,
      phase: label,
      kind: label.startsWith("gate") ? "provider_request" : label.startsWith("compact") ? "compact" : label.startsWith("context.estimate") ? "token_preflight" : label.startsWith("context") ? "context_build" : label.startsWith("session") ? "session_resume" : "other",
      session_id: sequence % 3 === 0 ? "seed_visual_preview_alpha" : null,
      process: {
        resident_bytes: resident - (ticks - sequence) * 640_000,
        private_bytes: resident - (ticks - sequence) * 640_000 - 12_000_000,
        virtual_bytes: 2_400_000_000,
        peak_resident_bytes: resident,
        source: "fixture",
        error: null,
      },
      store_heap_estimate_bytes: 24_000_000 + sequence * 180_000,
      context_payload_bytes: 8_000_000 + sequence * 90_000,
      estimate_json_bytes: 1_200_000 + sequence * 12_000,
    });
  }
  return {
    schema_version: 1,
    enabled: true,
    started_at_ms: now - ticks * 1000,
    sampled_at_ms: now,
    process: {
      resident_bytes: resident,
      private_bytes: resident - 12_000_000,
      virtual_bytes: 2_400_000_000,
      peak_resident_bytes: resident + 4_000_000,
      source: "fixture",
      error: null,
    },
    peak_sampled_private_bytes: resident - 11_000_000,
    peak_sampled_resident_bytes: resident + 4_000_000,
    tracked_session_count: 3,
    resident_session_count: 2,
    dropped_session_gauges: 0,
    dropped_phase_samples: 0,
    oldest_phase_sequence: 1,
    latest_phase_sequence: ticks,
    phase_gap: false,
    components: [
      { name: "ringing.timeline", group: "ringing", item_count: 128 + ticks, payload_bytes: 6_400_000, heap_estimate_bytes: 18_400_000, updated_at_ms: now },
      { name: "agent_registry.sessions", group: "agent_registry", item_count: 3, payload_bytes: null, heap_estimate_bytes: 42_000_000, updated_at_ms: now },
      { name: "service.context", group: "service", item_count: 96, payload_bytes: 2_100_000, heap_estimate_bytes: 12_800_000, updated_at_ms: now },
      { name: "mcp.servers", group: "transport", item_count: 4, payload_bytes: 512_000, heap_estimate_bytes: 3_200_000, updated_at_ms: now },
      { name: "lsp.servers", group: "transport", item_count: 0, payload_bytes: 0, heap_estimate_bytes: 0, updated_at_ms: now },
      { name: "workspace.registry", group: "workspace", item_count: 7, payload_bytes: null, heap_estimate_bytes: 960_000, updated_at_ms: now },
      { name: "misc.images", group: "other", item_count: 12, payload_bytes: 88_000_000, heap_estimate_bytes: 96_000_000, updated_at_ms: now },
    ],
    sessions: [
      {
        session_id: "seed_visual_preview_alpha",
        resident: true,
        message_count: 42,
        turn_count: 21,
        content_block_count: 96,
        text_bytes: 1_800_000,
        image_bytes: 24_000_000,
        store_heap_estimate_bytes: 34_000_000,
        agent_aux_heap_estimate_bytes: 2_400_000,
        pending_persist_ops: 0,
        context_message_count: 30,
        context_payload_bytes: 12_000_000,
        estimate_json_bytes: 1_400_000,
        last_phase: "gate.provider_request",
        last_phase_kind: "provider_request",
        updated_at_ms: now,
      },
      {
        session_id: "seed_visual_preview_beta_with_a_longer_id",
        resident: true,
        message_count: 6,
        turn_count: 3,
        content_block_count: 11,
        text_bytes: 220_000,
        image_bytes: 0,
        store_heap_estimate_bytes: 4_800_000,
        agent_aux_heap_estimate_bytes: 600_000,
        pending_persist_ops: 1,
        context_message_count: 6,
        context_payload_bytes: 1_100_000,
        estimate_json_bytes: 180_000,
        last_phase: "context.build",
        last_phase_kind: "context_build",
        updated_at_ms: now,
      },
      {
        session_id: "seed_visual_preview_gamma",
        resident: false,
        message_count: 2,
        turn_count: 1,
        content_block_count: 4,
        text_bytes: 40_000,
        image_bytes: 0,
        store_heap_estimate_bytes: 900_000,
        agent_aux_heap_estimate_bytes: 120_000,
        pending_persist_ops: 0,
        context_message_count: 0,
        context_payload_bytes: 0,
        estimate_json_bytes: 0,
        last_phase: "session.resume",
        last_phase_kind: "session_resume",
        updated_at_ms: now,
      },
    ],
    phases,
  };
}

export const resetMemorySim = (): void => {
  ticks = 0;
};
