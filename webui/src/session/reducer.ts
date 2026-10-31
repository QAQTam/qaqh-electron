/**
 * Ringing v2 conversation reducer (SPEC-2026-10-29-PURGE):
 *
 * 纯 Canonical 事实模型：
 * - applyConversationSnapshot: 全量快照初始化
 * - applyConversationDelta: 单流增量驱动
 *
 * 单源原则：结构与顺序事实只来自后端 ConversationSnapshot / ConversationDelta。
 */
import {
  emptySession,
  type SessionState,
  type Slot,
  type Step,
  type ToolDisplay,
  type ToolOutput,
  type ToolStatus,
  type Turn,
  type TurnStatus,
} from "./types";
import type { ConversationSnapshot } from "../api/qaqh/ConversationSnapshot";
import type { ConversationDelta } from "../api/qaqh/ConversationDelta";
import type { ContentValue } from "../api/qaqh/ContentValue";
import { now } from "../lib/time";

export { emptySession };

export function contentValueToText(value: ContentValue | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.kind === "inline") return value.data.text;
  if (value.kind === "ref") return "正文加载中…";
  if (value.kind === "unavailable") return "正文不可用";
  return "";
}

function contentRefOf(value: ContentValue | null | undefined): string | undefined {
  return value?.kind === "ref" ? value.data.content_ref : undefined;
}

/** 只枚举仍待解析的引用；同一回合的 id/key 别名不会导致重复处理。 */
export function pendingContentRefs(draft: SessionState): Set<string> {
  const refs = new Set<string>();
  for (const slot of draft.slots) {
    if (slot.kind !== "turn") continue;
    const turn = draft.turns[slot.key];
    if (!turn) continue;
    if (turn.user.contentRef) refs.add(turn.user.contentRef);
    for (const step of turn.steps) {
      if (step.kind === "tool") {
        if (step.argsRef) refs.add(step.argsRef);
        if (step.outputRef) refs.add(step.outputRef);
      } else if (step.contentRef) refs.add(step.contentRef);
    }
  }
  return refs;
}

/** 按当前引用回填，已替换/已卸载的块不会被旧下载覆盖。 */
export function resolveContentRef(draft: SessionState, ref: string, text: string, resolved = true): void {
  for (const slot of draft.slots) {
    if (slot.kind !== "turn") continue;
    const turn = draft.turns[slot.key];
    if (!turn) continue;
    let changed = false;
    if (turn.user.contentRef === ref) {
      turn.user.text = text;
      if (resolved) delete turn.user.contentRef;
      changed = true;
    }
    for (const step of turn.steps) {
      if (step.kind === "tool") {
        if (step.argsRef === ref) {
          step.argsJson = text;
          if (resolved) delete step.argsRef;
          changed = true;
        }
        if (step.outputRef === ref) {
          step.output = parseToolOutput(text);
          if (resolved) delete step.outputRef;
          changed = true;
        }
      } else if (step.contentRef === ref) {
        step.text = text;
        if (resolved) delete step.contentRef;
        if (step.id === turn.answerStepId && turn.answer) turn.answer.text = text;
        changed = true;
      }
    }
    if (changed) turn.renderVersion = (turn.renderVersion ?? 0) + 1;
  }
}

export function parseJsonish(value: string | undefined): Record<string, any> | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    return null;
  }
}

export function parseToolOutput(outputContent: string): ToolOutput {
  let text = outputContent;
  let stderr: string | undefined;
  let exitCode: number | undefined;
  let diffText: string | undefined;

  const parsed = parseJsonish(outputContent);
  if (parsed) {
    if (typeof parsed.output === "string") text = parsed.output;
    if (typeof parsed.stderr === "string" && parsed.stderr) stderr = parsed.stderr;
    if (typeof parsed.exit_code === "number") exitCode = parsed.exit_code;
    if (typeof parsed.diff === "string") diffText = parsed.diff;
  }
  if (!diffText && (text.startsWith("--- ") || text.includes("\n--- ") || text.startsWith("diff --git"))) {
    diffText = text;
  }
  return { text, stderr, exitCode, diffText };
}

export function normalizeToolStatus(state: unknown): ToolStatus {
  switch (state) {
    case "succeeded":
    case "success":
      return "success";
    case "running":
      return "running";
    case "failed":
    case "error":
    case "timed_out":
    case "indeterminate":
      return "error";
    case "cancelled":
    case "aborted":
      return "aborted";
    case "denied":
      return "denied";
    case "backgrounded":
      return "backgrounded";
    case "partial":
      return "running";
    case "prepared":
    case "pending":
    default:
      return "pending";
  }
}

export function outputFromDisplay(display: ToolDisplay | undefined, legacy: ToolOutput | undefined): ToolOutput | undefined {
  const body = display?.body;
  if (!body) return legacy;
  switch (body.kind) {
    case "none":
      return display?.diff ? { diffText: display.diff } : undefined;
    case "text":
      return { text: String(body.text ?? ""), truncated: body.truncated === true, diffText: display?.diff ?? legacy?.diffText };
    case "diff":
      return { diffText: String(body.unified ?? "") };
    case "shell":
      return { text: String(body.output ?? ""), exitCode: typeof body.exit_code === "number" ? body.exit_code : undefined, truncated: body.truncated === true };
    case "streams":
      return {
        text: String(body.stdout ?? ""),
        stderr: body.stderr ? String(body.stderr) : undefined,
        exitCode: typeof body.exit_code === "number" ? body.exit_code : undefined,
        truncated: body.truncated === true,
      };
    case "subagent":
      return { text: `subagent:${body.name} ${body.session_id}` };
    default:
      return legacy;
  }
}

export function getActiveTurn(draft: SessionState): Turn | undefined {
  if (draft.activeTurnKey && draft.turns[draft.activeTurnKey]) {
    return draft.turns[draft.activeTurnKey];
  }
  for (let i = draft.slots.length - 1; i >= 0; i--) {
    const slot = draft.slots[i]!;
    if (slot.kind === "turn") {
      const t = draft.turns[slot.key];
      if (t && t.status === "running") return t;
    }
  }
  if (draft.slots.length > 0) {
    const last = draft.slots[draft.slots.length - 1]!;
    if (last.kind === "turn") return draft.turns[last.key];
  }
  return undefined;
}

function demoteAnswerIfStale(turn: Turn): void {
  if (turn.answerStepId == null) return;
  turn.answer = null;
  turn.answerStepId = null;
}

function findOpenReasoning(draft: SessionState): { id: string; turnKey: string } | null {
  for (let i = draft.slots.length - 1; i >= 0; i--) {
    const slot = draft.slots[i]!;
    if (slot.kind !== "turn") continue;
    const turn = draft.turns[slot.key];
    if (!turn || turn.status !== "running") continue;
    for (let j = turn.steps.length - 1; j >= 0; j--) {
      const step = turn.steps[j]!;
      if (step.kind === "thinking" && step.endedAt == null) {
        return { id: step.id, turnKey: slot.key };
      }
    }
  }
  return null;
}

export function recomputeDerived(draft: SessionState): void {
  draft.structureVersion += 1;
  let running = 0;
  let failed = 0;
  let activeTurnKey: string | null = null;
  for (const slot of draft.slots) {
    if (slot.kind !== "turn") continue;
    const turn = draft.turns[slot.key];
    if (turn == null) continue;
    if (turn.status === "running") {
      running += 1;
      activeTurnKey = slot.key;
    } else if (turn.status === "failed") {
      failed += 1;
    }
  }
  draft.runningTurns = running;
  draft.failedTurns = failed;
  draft.activeTurnKey = activeTurnKey;
  const open = findOpenReasoning(draft);
  draft.activeReasoningId = open?.id ?? null;
  draft.activeReasoningTurnKey = open?.turnKey ?? null;
}

/**
 * 全量快照初始装载：打开会话或重连时，直接将 ConversationSnapshot 物化为 Solid Store。
 */
export function applyConversationSnapshot(
  draft: SessionState,
  snapshot: ConversationSnapshot,
  ts: number = now(),
): SessionState {
  draft.turns = {};
  draft.slots = [];

  // 1. 初始化所有已存在的回合容器
  for (let i = 0; i < snapshot.turns.length; i++) {
    const turnState = snapshot.turns[i]!;
    const turnId = turnState.turn_id;
    const outcome = turnState.outcome;
    let status: TurnStatus = "running";
    let error: { message: string } | undefined;
    if (outcome) {
      if (outcome.kind === "finished") {
        const terminal = outcome.data.terminal;
        status = terminal === "completed" ? "done" : terminal === "cancelled" ? "aborted" : "failed";
        if (outcome.data.error) {
          error = { message: outcome.data.error.message || outcome.data.error.code || "回合失败" };
        }
      } else if (outcome.kind === "interrupted") {
        status = "aborted";
      }
    }

    const key = `#${i}`;
    const turn: Turn = {
      id: turnId,
      key,
      turnIndex: i,
      user: { text: "" },
      steps: [],
      answer: null,
      answerStepId: null,
      status,
      workStartedAt: ts,
      error,
      expanded: false,
    };
    if (turnState.input_id) {
      (turn as any).inputId = turnState.input_id;
    }
    draft.turns[turn.key] = turn;
    if (turn.id !== turn.key) {
      draft.turns[turn.id] = turn;
    }
    draft.slots.push({ kind: "turn", key: turn.key });
  }

  // 2. 遍历 context 事实，原位装配到对应的 turn
  for (const entry of snapshot.context) {
    const item = entry.kind;
    switch (item.kind) {
      case "input": {
        const inputData = item.data;
        const turn = Object.values(draft.turns).find(t => {
          const turnState = snapshot.turns.find(ts => ts.turn_id === t.id);
          return turnState?.input_id === inputData.input_id || (t as any).inputId === inputData.input_id;
        }) || (draft.slots.length > 0 ? draft.turns[draft.slots[draft.slots.length - 1]!.key] : undefined);
        if (turn) {
          turn.user.text = contentValueToText(inputData.content);
          turn.user.contentRef = contentRefOf(inputData.content);
        }
        break;
      }
      case "assistant_block": {
        const blockData = item.data;
        const turn = draft.turns[blockData.turn_id];
        if (!turn) break;
        const text = contentValueToText(blockData.content);
        if (blockData.block_kind === "reasoning") {
          turn.steps.push({
            kind: "thinking",
            id: blockData.block_id,
            seq: 0,
            text,
            contentRef: contentRefOf(blockData.content),
            endedAt: ts,
          });
        } else if (blockData.block_kind === "answer") {
          turn.steps.push({
            kind: "text",
            id: blockData.block_id,
            seq: 0,
            text,
            contentRef: contentRefOf(blockData.content),
            endedAt: ts,
          });
          turn.answer = { text, startedAt: turn.workStartedAt };
          turn.answerStepId = blockData.block_id;
        }
        break;
      }
      case "tool_call": {
        const toolData = item.data;
        const turnId = toolData.turn_id;
        const turn = turnId ? draft.turns[turnId] : (draft.slots.length > 0 ? draft.turns[draft.slots[draft.slots.length - 1]!.key] : undefined);
        if (!turn) break;
        const res = toolData.result;
        const status = res ? normalizeToolStatus(res.terminal_status) : "running";
        const argsText = toolData.args ? contentValueToText(toolData.args) : undefined;
        const outText = res?.output ? contentValueToText(res.output) : undefined;
        const step: Extract<Step, { kind: "tool" }> = {
          kind: "tool",
          id: toolData.call_id,
          seq: 0,
          name: toolData.tool_name ?? "",
          argsJson: argsText,
          argsRef: contentRefOf(toolData.args),
          status,
          startedAt: res?.metrics?.started_at_ms ?? ts,
          endedAt: res?.metrics?.finished_at_ms,
          elapsedMs: res?.metrics ? (res.metrics.finished_at_ms >= res.metrics.started_at_ms ? res.metrics.finished_at_ms - res.metrics.started_at_ms : undefined) : undefined,
          output: outText ? parseToolOutput(outText) : undefined,
          outputRef: contentRefOf(res?.output),
          error: res?.error?.message || res?.error?.code,
        };
        turn.steps.push(step);
        break;
      }
      case "compaction": {
        break;
      }
    }
  }

  draft.totalTurns = draft.slots.length;
  recomputeDerived(draft);
  return draft;
}

/**
 * 增量事件原子驱动：根据单一流推送的 ConversationDelta 更新状态。
 */
export function applyConversationDelta(draft: SessionState, delta: ConversationDelta): SessionState {
  const ts = now();
  switch (delta.kind) {
    case "input_accepted": {
      const text = contentValueToText(delta.data.content);
      const inputId = delta.data.input_id;
      const turnId = `input_${inputId}`;
      const turn: Turn = {
        id: turnId,
        key: turnId,
        turnIndex: null,
        user: { text, contentRef: contentRefOf(delta.data.content) },
        steps: [],
        answer: null,
        answerStepId: null,
        status: "running",
        workStartedAt: ts,
        expanded: false,
      };
      (turn as any).inputId = inputId;
      draft.turns[turn.id] = turn;
      draft.slots.push({ kind: "turn", key: turn.key });
      break;
    }
    case "turn_started": {
      const inputId = delta.data.input_id;
      const turnId = delta.data.turn_id;
      const existing = Object.values(draft.turns).find(t => (t as any).inputId === inputId);
      if (existing) {
        const oldKey = existing.key;
        delete draft.turns[existing.id];
        existing.id = turnId;
        existing.key = turnId;
        existing.status = "running";
        existing.workStartedAt = ts;
        draft.turns[existing.id] = existing;
        const slotIdx = draft.slots.findIndex(s => s.kind === "turn" && s.key === oldKey);
        if (slotIdx !== -1) {
          draft.slots[slotIdx] = { kind: "turn", key: existing.key };
        }
      } else {
        let turn = draft.turns[turnId];
        if (!turn) {
          turn = {
            id: turnId,
            key: turnId,
            turnIndex: null,
            user: { text: "" },
            steps: [],
            answer: null,
            answerStepId: null,
            status: "running",
            workStartedAt: ts,
            expanded: false,
          };
          (turn as any).inputId = inputId;
          draft.turns[turn.id] = turn;
          draft.slots.push({ kind: "turn", key: turn.key });
        } else {
          turn.status = "running";
          turn.workStartedAt = ts;
        }
      }
      break;
    }
    case "tool_call_declared": {
      const turn = draft.turns[delta.data.turn_id] || getActiveTurn(draft);
      if (turn) {
        demoteAnswerIfStale(turn);
        const existing = turn.steps.find(s => s.id === delta.data.call_id);
        if (!existing) {
          const step: Extract<Step, { kind: "tool" }> = {
            kind: "tool",
            id: delta.data.call_id,
            seq: 0,
            name: delta.data.tool_name,
            argsJson: contentValueToText(delta.data.args),
            argsRef: contentRefOf(delta.data.args),
            status: "running",
            startedAt: ts,
          };
          turn.steps.push(step);
        }
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "tool_finished": {
      const callId = delta.data.call_id;
      for (const turn of Object.values(draft.turns)) {
        const step = turn.steps.find(s => s.id === callId);
        if (step && step.kind === "tool") {
          step.status = normalizeToolStatus(delta.data.terminal_status);
          step.endedAt = delta.data.metrics?.finished_at_ms ?? ts;
          if (delta.data.metrics) {
            step.elapsedMs = delta.data.metrics.finished_at_ms >= delta.data.metrics.started_at_ms
              ? delta.data.metrics.finished_at_ms - delta.data.metrics.started_at_ms
              : undefined;
          }
          const outText = delta.data.output ? contentValueToText(delta.data.output) : undefined;
          step.output = outText != null ? parseToolOutput(outText) : undefined;
          step.outputRef = contentRefOf(delta.data.output);
          if (delta.data.error) {
            step.error = delta.data.error.message || delta.data.error.code;
          }
          turn.renderVersion = (turn.renderVersion ?? 0) + 1;
          break;
        }
      }
      break;
    }
    case "assistant_block_sealed": {
      const turn = draft.turns[delta.data.turn_id] || getActiveTurn(draft);
      if (turn) {
        const text = contentValueToText(delta.data.content);
        if (delta.data.block_kind === "reasoning") {
          const existing = turn.steps.find(s => s.id === delta.data.block_id);
          if (existing && existing.kind === "thinking") {
            existing.text = text;
            existing.contentRef = contentRefOf(delta.data.content);
            existing.endedAt = ts;
          } else {
            turn.steps.push({
              kind: "thinking",
              id: delta.data.block_id,
              seq: 0,
              text,
              contentRef: contentRefOf(delta.data.content),
              endedAt: ts,
            });
          }
          demoteAnswerIfStale(turn);
        } else if (delta.data.block_kind === "answer") {
          const existing = turn.steps.find(s => s.id === delta.data.block_id);
          if (existing && existing.kind === "text") {
            existing.text = text;
            existing.contentRef = contentRefOf(delta.data.content);
            existing.endedAt = ts;
          } else {
            const step: Extract<Step, { kind: "text" }> = {
              kind: "text",
              id: delta.data.block_id,
              seq: 0,
              text,
              contentRef: contentRefOf(delta.data.content),
              endedAt: ts,
            };
            turn.steps.push(step);
          }
          turn.answer = { text, startedAt: turn.workStartedAt ?? ts };
          turn.answerStepId = delta.data.block_id;
        }
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "turn_finished": {
      const turn = draft.turns[delta.data.turn_id] || getActiveTurn(draft);
      if (turn) {
        turn.status = delta.data.terminal === "completed" ? "done" : delta.data.terminal === "cancelled" ? "aborted" : "failed";
        if (delta.data.error) {
          turn.error = { message: delta.data.error.message || delta.data.error.code || "回合失败" };
        }
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "turn_interrupted": {
      const turn = draft.turns[delta.data.turn_id] || getActiveTurn(draft);
      if (turn) {
        turn.status = "aborted";
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "assistant_block_progress": {
      // 生成中的累计快照：同一个 block_id 被后续帧持续替换，
      // 封口的 assistant_block_sealed 复用同一 id，因此不会出现"流一份、封口再追加一份"。
      const turn = draft.turns[delta.data.turn_id] || getActiveTurn(draft);
      if (turn) {
        const text = delta.data.text;
        const existing = turn.steps.find(s => s.id === delta.data.block_id);
        if (delta.data.block_kind === "reasoning") {
          if (existing && existing.kind === "thinking") {
            existing.text = text;
          } else {
            turn.steps.push({
              kind: "thinking",
              id: delta.data.block_id,
              seq: 0,
              startedAt: ts,
              text,
            });
          }
          if (!existing) {
            draft.activeReasoningId = delta.data.block_id;
            draft.activeReasoningTurnKey = turn.key;
          }
          demoteAnswerIfStale(turn);
        } else {
          if (existing && existing.kind === "text") {
            existing.text = text;
          } else {
            turn.steps.push({
              kind: "text",
              id: delta.data.block_id,
              seq: 0,
              startedAt: ts,
              text,
            });
          }
          turn.answer = { text, startedAt: turn.workStartedAt ?? ts };
          turn.answerStepId = delta.data.block_id;
        }
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "tool_input_progress": {
      // 参数未校验完成，只更新展示：不建可执行状态，也不提前触发任何命令。
      const turn = draft.turns[delta.data.turn_id] || getActiveTurn(draft);
      if (turn) {
        const existing = turn.steps.find(s => s.id === delta.data.call_id);
        if (existing && existing.kind === "tool") {
          existing.argsJson = delta.data.args;
        } else {
          turn.steps.push({
            kind: "tool",
            id: delta.data.call_id,
            seq: 0,
            name: delta.data.tool_name,
            argsJson: delta.data.args,
            status: "pending",
            startedAt: ts,
          });
        }
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "compaction_applied":
    case "compact_started":
    case "compact_progress":
    case "compact_finished":
      break;
  }
  const streaming = delta.kind === "assistant_block_progress" || delta.kind === "tool_input_progress";
  if (!streaming) recomputeDerived(draft);
  // 流式帧只更新对应块本身：不提升结构版本，避免每帧重建整棵消息树。
  return draft;
}

/** 防御性收口 helper。 */
export function forceSealTurn(
  draft: SessionState,
  turnId?: string | null,
  terminal?: string,
  error?: { message?: string } | null,
): boolean {
  let target: Turn | undefined;
  if (turnId) {
    target = draft.turns[turnId];
  }
  if (!target && draft.activeTurnKey) {
    target = draft.turns[draft.activeTurnKey];
  }
  if (!target) {
    for (let i = draft.slots.length - 1; i >= 0; i--) {
      const slot = draft.slots[i]!;
      if (slot.kind === "turn") {
        const t = draft.turns[slot.key];
        if (t && t.status === "running") {
          target = t;
          break;
        }
      }
    }
  }
  if (!target) return false;
  target.status = terminal === "completed" ? "done" : terminal === "cancelled" ? "aborted" : "failed";
  if (target.answer == null) {
    for (let i = target.steps.length - 1; i >= 0; i--) {
      const step = target.steps[i]!;
      if (step.kind === "text") {
        target.answer = { text: step.text, startedAt: target.workStartedAt };
        target.answerStepId = step.id;
        break;
      }
    }
  }
  if (error?.message) {
    target.error = { message: error.message };
  }
  recomputeDerived(draft);
  return true;
}

export function mergeSlots(draft: SessionState, next: Slot[]): void {
  for (let index = 0; index < next.length; index += 1) {
    const want = next[index]!;
    const current = draft.slots[index];
    if (current == null) {
      draft.slots.push(want);
    } else if (!sameSlot(current, want)) {
      if (current.kind === want.kind) {
        current.key = want.key;
        if (current.kind === "gap" && want.kind === "gap") {
          for (let i = 0; i < want.spans.length; i += 1) {
            const span = want.spans[i]!;
            const existing = current.spans[i];
            if (existing == null) current.spans.push(span);
            else {
              existing.key = span.key;
              existing.height = span.height;
            }
          }
          if (current.spans.length > want.spans.length) current.spans.splice(want.spans.length);
        }
      } else draft.slots[index] = want;
    }
  }
  if (draft.slots.length > next.length) draft.slots.splice(next.length);
}

function sameSlot(a: Slot, b: Slot): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "gap" && b.kind === "gap") {
    if (a.spans.length !== b.spans.length) return false;
    for (let i = 0; i < a.spans.length; i += 1) {
      if (a.spans[i]!.key !== b.spans[i]!.key || a.spans[i]!.height !== b.spans[i]!.height) return false;
    }
  }
  return true;
}
