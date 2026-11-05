// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));
const terminal = vi.hoisted(() => ({ writes: [] as string[], resets: 0 }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = {};
  buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0, getLine: () => undefined } };
  loadAddon() {} open() {} onScroll() {} scrollToBottom() {} dispose() {}
  reset() { terminal.resets++; }
  write(text: string, done: () => void) { terminal.writes.push(text); done(); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import { createComponent, createStore, flush } from "solid-js";
import { render } from "@solidjs/web";
import { TurnView } from "../src/turn/TurnView";
import { applySessionEvent, emptySession, resolveContentRef } from "../src/session/reducer";
import type { ExecSessionView, SessionEventFrame } from "@qaqh/sdk/protocol";

test("exec session output reaches xterm before tool return, continues after yield, and resolves final transcript", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const [state, mutate] = createStore(emptySession());
  const feed = async (event: SessionEventFrame) => {
    mutate((draft) => { applySessionEvent(draft, event); });
    await flush();
  };
  const session: ExecSessionView = {
    id: "exec-1", owner_session_id: "s", origin_turn_id: "t", origin_call_id: "c",
    state: { kind: "running" }, tty: true, command: "echo", started_at_ms: 1,
    next_offset: 0, output_preview: "", preview_start_offset: 0,
    output_complete: false, capture_omitted_bytes: 0, stream_dropped_bytes: 0,
  };
  await feed({ seq: 1, type: "turn_started", turn_id: "t", input_id: null, mode: null });
  await feed({ seq: 2, type: "tool_declared", turn_id: "t", call_id: "c", tool_name: "exec_command", args: {} });
  await feed({ seq: 3, type: "tool_state_changed", turn_id: "t", call_id: "c", state: { kind: "running" } });
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(TurnView, {
    get turn() { return state.turns.t!; }, waits: [], isLatestTurn: true,
    store: { seed: "s", state: [state], composerProfile: [() => ({ providerKind: "account" })], composerModel: [() => null] } as never,
  }), root);
  try {
    await feed({ seq: 4, type: "exec_session_started", session });
    await feed({ seq: 5, type: "exec_session_output_delta", exec_session_id: session.id,
      start_offset: 0, end_offset: 3, source: "terminal", text: "中" });
    // Allow the production dynamic import of ReadOnlyTerminal to mount.
    await vi.waitFor(async () => { await flush(); expect(terminal.writes).toEqual(["中"]); });
    expect(root.querySelector(".tool-progress .tool-xterm")).not.toBeNull();
    await feed({ seq: 6, type: "tool_finished", call_id: "c", outcome: { kind: "yielded", exec_session_id: session.id },
      exec_session_id: session.id, output: { kind: "inline", data: { text: '{"output":"中"}' } }, output_truncated: false, metrics: null });
    await feed({ seq: 7, type: "exec_session_output_delta", exec_session_id: session.id,
      start_offset: 3, end_offset: 7, source: "terminal", text: "😀" });
    expect(terminal.writes).toEqual(["中", "😀"]);
    expect(root.querySelector(".tool-progress")).not.toBeNull();
    // Duplicate frames must not replay terminal data.
    await feed({ seq: 8, type: "exec_session_output_delta", exec_session_id: session.id,
      start_offset: 3, end_offset: 7, source: "terminal", text: "😀" });
    expect(terminal.writes).toEqual(["中", "😀"]);
    // Roll the retained window while producing identical text on every chunk.
    await feed({ seq: 9, type: "exec_session_output_delta", exec_session_id: session.id,
      start_offset: 7, end_offset: 16391, source: "terminal", text: "a".repeat(16384) });
    await feed({ seq: 10, type: "exec_session_output_delta", exec_session_id: session.id,
      start_offset: 16391, end_offset: 16392, source: "terminal", text: "a" });
    expect(terminal.writes.slice(-2)).toEqual(["a".repeat(16384), "a"]);
    await feed({ seq: 11, type: "exec_session_finished", session: {
      ...state.execSessions[session.id]!, state: { kind: "finished", outcome: { kind: "exited", exit_code: 0 } },
      output_complete: true, output: { kind: "ref", data: { content_ref: "final" } },
    } });
    expect(root.querySelector(".tool-progress")).toBeNull();
    mutate((draft) => resolveContentRef(draft, "final", "中😀final transcript"));
    await flush();
    expect(terminal.writes.at(-1)).toBe("中😀final transcript");
    expect(terminal.resets).toBeGreaterThan(0);
  } finally {
    dispose(); root.remove(); vi.unstubAllGlobals();
  }
});
