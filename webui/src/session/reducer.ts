/** Reduce the Ringing v3 bootstrap and flattened session event stream. */
import {
  emptySession,
  type SessionState,
  type Slot,
  type Step,
  type ToolOutput,
  type ToolProgressStream,
  type Turn,
  type TurnStatus,
} from "./types";
import type {

  ContentValue,
  SessionBootstrap as RingingBootstrap,
  SessionEventFrame,
  SessionTurnSnapshot,
  TimelineEntry,
  ToolCallOutcome,
  ToolCallState,
  ToolCallView,
  ExecSessionView,
  TurnOutcome,

} from "../api/contract";
import { now } from "../lib/time";

export { emptySession };

export function contentValueToText(value: ContentValue | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.kind === "inline") return value.data.text;
  // Loading/error presentation belongs to the UI; never turn status copy into
  // canonical message content.
  if (value.kind === "ref") return "";
  if (value.kind === "unavailable") return "正文不可用";
  return "";
}

function contentRefOf(value: ContentValue | null | undefined): string | undefined {
  return value?.kind === "ref" ? value.data.content_ref : undefined;
}

/** 只枚举仍待解析的引用；同一回合的 id/key 别名不会导致重复处理。 */
export function pendingContentRefs(draft: SessionState): Set<string> {
  const refs = new Set<string>();
  for (const session of Object.values(draft.execSessions)) {
    const ref = contentRefOf(session.output);
    if (ref) refs.add(ref);
  }
  for (const snapshot of Object.values(draft.originTurns)) {
    for (const ref of contentRefsInPayload(snapshot)) refs.add(ref);
  }
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

/** Collect immutable content refs directly from a bootstrap/delta payload. */
export function contentRefsInPayload(value: unknown): Set<string> {
  const refs = new Set<string>();
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.kind === "ref" && record.data != null && typeof record.data === "object") {
      const ref = (record.data as Record<string, unknown>).content_ref;
      if (typeof ref === "string" && ref !== "") refs.add(ref);
    }
    if (Array.isArray(node)) for (const item of node) visit(item);
    else for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return refs;
}

function materializeContentRef(node: unknown, ref: string, text: string): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) materializeContentRef(item, ref, text);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.kind === "ref" && record.data != null && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (data.content_ref === ref) {
      record.kind = "inline";
      record.data = { text };
      return;
    }
  }
  for (const child of Object.values(record)) materializeContentRef(child, ref, text);
}

/** 按当前引用回填，已替换/已卸载的块不会被旧下载覆盖。 */
export function resolveContentRef(draft: SessionState, ref: string, text: string, resolved = true): void {
  if (resolved) {
    for (const snapshot of Object.values(draft.originTurns)) materializeContentRef(snapshot, ref, text);
    for (const session of Object.values(draft.execSessions)) {
      if (session.output?.kind === "ref" && session.output.data.content_ref === ref) {
        session.output = { kind: "inline", data: { text } };
        syncExecSession(draft, session);
      }
    }
  }
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

function findTurn(draft: SessionState, turnId: string | null | undefined): Turn | undefined {
  if (!turnId) return undefined;
  return Object.values(draft.turns).find((turn) => turn.id === turnId);
}

function ensureTurn(draft: SessionState, turnId: string | null | undefined, inputId?: string | null): Turn {
  let turn = findTurn(draft, turnId);
  if (!turn && inputId) turn = Object.values(draft.turns).find((item) => item.inputId === inputId);
  if (turn) {
    if (turnId) turn.id = turnId;
    if (inputId) turn.inputId = inputId;
    return turn;
  }
  const id = turnId || (inputId ? `input:${inputId}` : `pending:${crypto.randomUUID()}`);
  const key = id;
  turn = {
    id,
    key,
    inputId: inputId ?? null,
    turnIndex: null,
    user: { text: "" },
    steps: [],
    answer: null,
    answerStepId: null,
    status: "running",
    workStartedAt: now(),
    expanded: false,
  };
  draft.turns[key] = turn;
  draft.slots.push({ kind: "turn", key });
  return turn;
}

function statusFromOutcome(outcome: TurnOutcome | null | undefined): { status: TurnStatus; error?: { message: string }; usage?: Turn["usage"] } {
  if (!outcome) return { status: "running" };
  if (outcome.kind === "interrupted") return { status: "aborted" };
  const { terminal, error, usage } = outcome.data;
  const status: TurnStatus = terminal === "completed" ? "done" : terminal === "cancelled" ? "aborted" : "failed";
  return {
    status,
    ...(error ? { error: { message: error.message || error.code || "回合失败" } } : {}),
    usage,
  };
}

function displayJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function upsertAssistantBlock(
  draft: SessionState,
  turnId: string,
  blockId: string,
  blockKind: "reasoning" | "answer" | "tool_call",
  content: ContentValue,
  sealed: boolean,
): boolean {
  if (blockKind === "tool_call") return false;
  const turn = ensureTurn(draft, turnId);
  const kind = blockKind === "reasoning" ? "thinking" : "text";
  const text = contentValueToText(content);
  const ref = contentRefOf(content);
  // Empty answer blocks are protocol facts, but they are not assistant chat
  // messages and must not split the surrounding work segment.
  if (blockKind === "answer" && text.length === 0 && ref == null) return false;
  const existing = turn.steps.find((step) => step.id === blockId);
  if (existing && existing.kind === kind) {
    existing.text = text;
    existing.contentRef = ref;
    if (sealed) existing.endedAt = now();
  } else {
    const step: Step = kind === "thinking"
      ? { kind, id: blockId, seq: turn.steps.length, text, contentRef: ref, ...(sealed ? { endedAt: now() } : {}) }
      : { kind, id: blockId, seq: turn.steps.length, text, contentRef: ref, ...(sealed ? { endedAt: now() } : {}) };
    turn.steps.push(step);
  }
  if (kind === "text") {
    turn.answer = { text, startedAt: turn.workStartedAt };
    turn.answerStepId = blockId;
  } else {
    demoteAnswerIfStale(turn);
  }
  turn.renderVersion = (turn.renderVersion ?? 0) + 1;
  return existing == null;
}

function upsertToolCall(draft: SessionState, call: ToolCallView, fallbackTurnId?: string | null): void {
  const turn = ensureTurn(draft, call.turn_id ?? fallbackTurnId);
  const args = displayJson(call.args);
  const index = turn.steps.findIndex((step) => step.id === call.call_id);
  const outputText = call.output ? contentValueToText(call.output) : "";
  const next: Extract<Step, { kind: "tool" }> = {
    kind: "tool",
    id: call.call_id,
    seq: index >= 0 ? turn.steps[index]!.seq : turn.steps.length,
    name: call.tool_name ?? "",
    argsJson: args ?? undefined,
    argsRef: undefined,
    status: toolStatusFromState(call.state),
    state: call.state,
    execSessionId: call.exec_session_id ?? undefined,
    execSessionState: call.exec_session_id ? draft.execSessions[call.exec_session_id]?.state : undefined,
    startedAt: call.metrics?.started_at_ms,
    endedAt: call.metrics?.finished_at_ms,
    elapsedMs: call.metrics && call.metrics.finished_at_ms >= call.metrics.started_at_ms
      ? call.metrics.finished_at_ms - call.metrics.started_at_ms : undefined,
    output: outputText
      ? { ...parseToolOutput(outputText), truncated: call.output_truncated }
      : call.output_truncated ? { truncated: true } : undefined,
    outputRef: call.output ? contentRefOf(call.output) : undefined,
    error: toolErrorFromState(call.state),
    codeDelta: call.code_delta,
    effects: call.effects,
  };
  if (index >= 0 && turn.steps[index]?.kind === "tool") turn.steps[index] = { ...turn.steps[index] as Extract<Step, { kind: "tool" }>, ...next };
  else turn.steps.push(next);
  const session = call.exec_session_id ? draft.execSessions[call.exec_session_id]
    : Object.values(draft.execSessions).find((session) => session.origin_call_id === call.call_id);
  if (session) syncExecSession(draft, session);
  demoteAnswerIfStale(turn);
  turn.renderVersion = (turn.renderVersion ?? 0) + 1;
}

function toolErrorFromOutcome(outcome: ToolCallOutcome): string | undefined {
  return outcome.kind === "failed" ? outcome.error.message || outcome.error.code : undefined;
}

function toolErrorFromState(state: ToolCallState): string | undefined {
  return state.kind === "finished" ? toolErrorFromOutcome(state.outcome) : undefined;
}

function toolStatusFromOutcome(outcome: ToolCallOutcome): Extract<Step, { kind: "tool" }>["status"] {
  switch (outcome.kind) {
    case "completed":
    case "yielded": return "finished";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
  }
}

function toolStatusFromState(state: ToolCallState): Extract<Step, { kind: "tool" }>["status"] {
  switch (state.kind) {
    case "declared": return "declared";
    case "awaiting_interaction": return "awaiting_permission";
    case "running": return "running";
    case "cancelling": return "cancelling";
    case "finished": return toolStatusFromOutcome(state.outcome);
  }
}

function applyTimelineEntry(draft: SessionState, entry: TimelineEntry, tools: Map<string, ToolCallView>): void {
  switch (entry.kind) {
    case "input": {
      const data = entry.data;
      const turn = ensureTurn(draft, data.turn_id);
      turn.user.text = contentValueToText(data.content);
      turn.user.contentRef = contentRefOf(data.content);
      turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      break;
    }
    case "assistant_block":
      upsertAssistantBlock(draft, entry.data.turn_id, entry.data.block_id, entry.data.block_kind, entry.data.content, true);
      if (entry.data.block_kind === "answer" && entry.data.usage) {
        const turn = findTurn(draft, entry.data.turn_id);
        if (turn) turn.usage = entry.data.usage;
      }
      break;
    case "tool_call": {
      const call = tools.get(entry.data.call_id);
      if (call) upsertToolCall(draft, call, entry.data.turn_id);
      else {
        const turn = ensureTurn(draft, entry.data.turn_id);
        const old = turn.steps.find((step) => step.id === entry.data.call_id);
        if (!old) turn.steps.push({ kind: "tool", id: entry.data.call_id, seq: turn.steps.length, name: "", status: "declared" });
        demoteAnswerIfStale(turn);
      }
      break;
    }
    case "tool_result": {
      const turn = findTurn(draft, entry.data.turn_id);
      const step = turn?.steps.find((item) => item.kind === "tool" && item.id === entry.data.call_id);
      if (turn && step?.kind === "tool" && step.output == null && step.outputRef == null) {
        const text = contentValueToText(entry.data.content);
        step.output = text ? parseToolOutput(text) : undefined;
        step.outputRef = contentRefOf(entry.data.content);
        turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "compaction": {
      const text = contentValueToText(entry.data.summary);
      if (text && !draft.compactionSummaries.includes(text)) draft.compactionSummaries.push(text);
      break;
    }
  }
}

/** Materialize the canonical bootstrap without routing through the retired ConversationSnapshot shape. */
export function applySessionBootstrap(draft: SessionState, bootstrap: RingingBootstrap): SessionState {
  const expanded = new Map(Object.values(draft.turns).map((turn) => [turn.id, turn.expanded]));
  draft.turns = {};
  draft.execSessions = Object.fromEntries(bootstrap.state.exec_sessions.map((session) => [session.id, session]));
  draft.originTurns = {};
  draft.slots = [];
  draft.interactionIds = bootstrap.state.interactions.filter((item) => item.resolution == null).map((item) => item.interaction_id);
  draft.waits = [];
  draft.compactionSummaries = [];
  draft.serverEpoch = bootstrap.server_epoch;
  draft.watermark = bootstrap.state.seq;

  for (const item of bootstrap.state.turns) {
    const status = statusFromOutcome(item.outcome);
    const turn: Turn = {
      id: item.turn_id,
      key: item.turn_id,
      inputId: item.input_id ?? null,
      turnIndex: null,
      user: { text: "" },
      steps: [],
      answer: null,
      answerStepId: null,
      status: status.status,
      workStartedAt: item.turn_id === bootstrap.state.current_turn_id ? now() : undefined,
      error: status.error,
      usage: status.usage,
      expanded: expanded.get(item.turn_id) ?? false,
    };
    draft.turns[turn.key] = turn;
    draft.slots.push({ kind: "turn", key: turn.key });
  }
  draft.waits = bootstrap.state.interactions.filter((item) => item.resolution == null).map((item) => ({
    interactionId: item.interaction_id,
    turnKey: findTurn(draft, item.turn_id)?.key ?? null,
    kind: item.kind === "ask" ? "ask" : "approval",
    from: now(),
  }));

  const tools = new Map(bootstrap.state.tools.map((tool) => [tool.call_id, tool]));
  for (const entry of bootstrap.state.timeline) applyTimelineEntry(draft, entry, tools);
  for (const tool of bootstrap.state.tools) {
    if (!Object.values(draft.turns).some((turn) => turn.steps.some((step) => step.kind === "tool" && step.id === tool.call_id))) {
      upsertToolCall(draft, tool);
    }
  }
  draft.totalTurns = bootstrap.state.turns.length;
  draft.hasMore = false;
  draft.truncatedBefore = false;
  draft.oldestIndex = null;
  recomputeDerived(draft);
  return draft;
}

/** Build one rendered turn from the targeted Ringing snapshot used by execution cards. */
export function sessionTurnFromSnapshot(snapshot: SessionTurnSnapshot): Turn {
  const outcome = statusFromOutcome(snapshot.turn.outcome);
  const turn: Turn = {
    id: snapshot.turn.turn_id,
    key: snapshot.turn.turn_id,
    inputId: snapshot.turn.input_id ?? null,
    turnIndex: null,
    user: { text: "" },
    steps: [],
    answer: null,
    answerStepId: null,
    status: outcome.status,
    phase: snapshot.turn.phase ?? undefined,
    error: outcome.error,
    usage: outcome.usage,
    expanded: true,
  };
  const draft = emptySession();
  draft.turns[turn.key] = turn;
  draft.slots = [{ kind: "turn", key: turn.key }];
  const tools = new Map(snapshot.tools.map((tool) => [tool.call_id, tool]));
  for (const entry of snapshot.timeline) applyTimelineEntry(draft, entry, tools);
  for (const tool of snapshot.tools) {
    if (!turn.steps.some((step) => step.kind === "tool" && step.id === tool.call_id)) {
      upsertToolCall(draft, tool, snapshot.turn.turn_id);
    }
  }
  recomputeDerived(draft);
  return turn;
}

function appendBounded(current: string | undefined, addition: string): { value: string; truncated: boolean } {
  const combined = (current ?? "") + addition;
  const limit = 16 * 1024;
  return combined.length > limit ? { value: combined.slice(-limit), truncated: true } : { value: combined, truncated: false };
}

function appendProgressStream(
  current: ToolProgressStream | undefined,
  addition: string,
  initialTail: string | undefined,
  data: string,
): ToolProgressStream {
  const endOffset = (current?.endOffset ?? initialTail?.length ?? 0) + addition.length;
  return { startOffset: endOffset - data.length, endOffset, data };
}

function appendUtf8Tail(current: string, addition: string, maxBytes: number): string {
  const combined = current + addition;
  if (new TextEncoder().encode(combined).length <= maxBytes) return combined;
  const chars = Array.from(combined);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const codePoint = chars[start - 1]!.codePointAt(0)!;
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    start -= 1;
  }
  return chars.slice(start).join("");
}

/** Pair by protocol identity, including the period before tool_finished supplies an id. */
function syncExecSession(draft: SessionState, session: ExecSessionView): void {
  for (const turn of Object.values(draft.turns)) {
    for (const step of turn.steps) {
      if (step.kind !== "tool" || (step.id !== session.origin_call_id && step.execSessionId !== session.id)) continue;
      step.execSessionId = session.id;
      step.execSessionState = session.state;
      step.execSession = { ...session };
      turn.renderVersion = (turn.renderVersion ?? 0) + 1;
    }
  }
}

function turnForEvent(draft: SessionState, turnId: string): Turn {
  return findTurn(draft, turnId) ?? ensureTurn(draft, turnId);
}

/** Reduce one flattened v3 event directly into the UI view model. */
export function applySessionEvent(draft: SessionState, event: SessionEventFrame): SessionState {
  const streaming = event.type === "message_delta" || event.type === "tool_arguments_delta" || event.type === "tool_output_delta" || event.type === "exec_session_output_delta";
  let structureChanged = false;
  switch (event.type) {
    case "activity_changed":
      if (event.current_turn_id && event.activity === "running") turnForEvent(draft, event.current_turn_id).status = "running";
      break;
    case "turn_started": {
      const turn = ensureTurn(draft, event.turn_id, event.input_id);
      turn.status = "running";
      turn.phase = "running";
      turn.workStartedAt ??= now();
      break;
    }
    case "turn_phase_changed": {
      const turn = turnForEvent(draft, event.turn_id);
      turn.phase = event.phase;
      turn.status = "running";
      break;
    }
    case "turn_ended": {
      const turn = turnForEvent(draft, event.turn_id);
      const status = statusFromOutcome(event.outcome);
      turn.status = status.status;
      delete turn.phase;
      turn.error = status.error;
      turn.usage = status.usage;
      if (turn.answer == null) {
        const answer = [...turn.steps].reverse().find((step) => step.kind === "text");
        if (answer?.kind === "text") { turn.answer = { text: answer.text, startedAt: turn.workStartedAt }; turn.answerStepId = answer.id; }
      }
      turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      break;
    }
    case "tool_arguments_delta": {
      const turn = turnForEvent(draft, event.turn_id);
      const step = turn.steps.find((item) => item.kind === "tool" && item.id === event.call_id);
      if (step?.kind === "tool") { step.name = event.tool_name; step.argsJson = event.text; }
      else {
        turn.steps.push({ kind: "tool", id: event.call_id, seq: turn.steps.length, name: event.tool_name, argsJson: event.text, status: "declared" });
        demoteAnswerIfStale(turn);
        structureChanged = true;
      }
      turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      break;
    }
    case "tool_declared":
      upsertToolCall(draft, {
        call_id: event.call_id, turn_id: event.turn_id, tool_name: event.tool_name,
        args: event.args ?? null, state: { kind: "declared" }, output: null,
        output_truncated: false, metrics: null,
      });
      break;
    case "tool_state_changed": {
      const turn = turnForEvent(draft, event.turn_id);
      let step = turn.steps.find((item) => item.kind === "tool" && item.id === event.call_id);
      if (!step || step.kind !== "tool") {
        step = { kind: "tool", id: event.call_id, seq: turn.steps.length, name: "", status: "declared" };
        turn.steps.push(step);
        structureChanged = true;
      }
      step.status = toolStatusFromState(event.state);
      step.state = event.state;
      step.error = toolErrorFromState(event.state);
      if (event.state.kind === "finished" && event.state.outcome.kind === "yielded") {
        step.execSessionId = event.state.outcome.exec_session_id;
        step.execSessionState = draft.execSessions[step.execSessionId]?.state;
      }
      if (step.status === "running") step.startedAt ??= now();
      turn.renderVersion = (turn.renderVersion ?? 0) + 1;
      break;
    }
    case "tool_output_delta": {
      for (const turn of Object.values(draft.turns)) {
        const step = turn.steps.find((item) => item.kind === "tool" && item.id === event.call_id);
        if (step?.kind === "tool") {
          const isStderr = event.stream === "stderr";
          const currentTail = isStderr ? step.progressStderrTail : step.progressTail;
          const next = appendBounded(currentTail, event.text);
          const progressStream = appendProgressStream(
            isStderr ? step.progressStderrStream : step.progressStream,
            event.text,
            currentTail,
            next.value,
          );
          if (isStderr) {
            step.progressStderrTail = next.value;
            step.progressStderrStream = progressStream;
          } else {
            step.progressTail = next.value;
            step.progressStream = progressStream;
          }
          step.progressTruncated = step.progressTruncated === true || next.truncated;
          turn.renderVersion = (turn.renderVersion ?? 0) + 1;
          break;
        }
      }
      break;
    }
    case "tool_finished": {
      const target = Object.values(draft.turns).find((turn) =>
        turn.steps.some((item) => item.kind === "tool" && item.id === event.call_id),
      );
      const step = target?.steps.find((item) => item.kind === "tool" && item.id === event.call_id);
      if (!target || step?.kind !== "tool") break;
      {
        step.status = toolStatusFromOutcome(event.outcome);
        step.state = { kind: "finished", outcome: event.outcome };
        step.execSessionId = event.exec_session_id ?? (event.outcome.kind === "yielded" ? event.outcome.exec_session_id : step.execSessionId);
        step.execSessionState = step.execSessionId ? draft.execSessions[step.execSessionId]?.state : undefined;
        step.endedAt = event.metrics?.finished_at_ms ?? now();
        step.elapsedMs = event.metrics && event.metrics.finished_at_ms >= event.metrics.started_at_ms
          ? event.metrics.finished_at_ms - event.metrics.started_at_ms : undefined;
        const text = event.output ? contentValueToText(event.output) : "";
        step.output = text
          ? { ...parseToolOutput(text), truncated: event.output_truncated }
          : event.output_truncated ? { truncated: true } : undefined;
        step.outputRef = event.output ? contentRefOf(event.output) : undefined;
        step.error = toolErrorFromOutcome(event.outcome);
        step.codeDelta = event.code_delta;
        step.effects = event.effects;
        step.progressTail = undefined;
        step.progressStderrTail = undefined;
        step.progressStream = undefined;
        step.progressStderrStream = undefined;
        target.renderVersion = (target.renderVersion ?? 0) + 1;
      }
      break;
    }
    case "exec_session_started":
    case "exec_session_state_changed":
    case "exec_session_finished": {
      draft.execSessions[event.session.id] = event.session;
      syncExecSession(draft, event.session);
      break;
    }
    case "exec_session_output_delta": {
      const session = draft.execSessions[event.exec_session_id];
      if (session && event.start_offset >= session.next_offset) {
        const gap = event.start_offset - session.next_offset;
        session.output_preview = appendUtf8Tail(session.output_preview, event.text, 16 * 1024);
        session.next_offset = Math.max(session.next_offset, event.end_offset);
        session.preview_start_offset = session.next_offset - new TextEncoder().encode(session.output_preview).length;
        session.stream_dropped_bytes += gap;
        syncExecSession(draft, session);
      }
      break;
    }
    case "timeline_appended":
      applyTimelineEntry(draft, event.entry, new Map(bootstrapTools(draft)));
      break;
    case "message_delta": {
      structureChanged = upsertAssistantBlock(draft, event.turn_id, event.block_id, event.block_kind, { kind: "inline", data: { text: event.text } }, false);
      break;
    }
    case "interaction_requested": {
      const interaction = event.interaction;
      if (!draft.interactionIds.includes(interaction.interaction_id)) draft.interactionIds.push(interaction.interaction_id);
      draft.waits.push({ interactionId: interaction.interaction_id, turnKey: findTurn(draft, interaction.turn_id)?.key ?? null, kind: interaction.kind === "ask" ? "ask" : "approval", from: now() });
      break;
    }
    case "interaction_resolved":
      draft.interactionIds = draft.interactionIds.filter((id) => id !== event.interaction_id);
      draft.waits = draft.waits.map((wait) => wait.interactionId === event.interaction_id && wait.to == null ? { ...wait, to: now() } : wait);
      break;
    case "subagent_updated":
    case "session_meta_changed":
    case "driver_changed":
      break;
  }
  if (!streaming || structureChanged) recomputeDerived(draft);
  return draft;
}

function bootstrapTools(draft: SessionState): [string, ToolCallView][] {
  const result: [string, ToolCallView][] = [];
  for (const turn of Object.values(draft.turns)) {
    for (const step of turn.steps) {
      if (step.kind !== "tool") continue;
      const args = step.argsJson ? (parseJsonish(step.argsJson) ?? step.argsJson) : null;
      const output = step.outputRef
        ? { kind: "ref" as const, data: { content_ref: step.outputRef } }
        : step.output?.text ? { kind: "inline" as const, data: { text: step.output.text } } : null;
      result.push([step.id, {
        call_id: step.id,
        turn_id: turn.id,
        tool_name: step.name,
        args,
        state: step.state ?? { kind: "declared" },
        exec_session_id: step.execSessionId ?? null,
        output,
        output_truncated: step.output?.truncated === true,
        metrics: null,
      }]);
    }
  }
  return result;
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
    target = findTurn(draft, turnId);
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
