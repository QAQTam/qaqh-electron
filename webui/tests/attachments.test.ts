import { afterEach, expect, test, vi } from "vitest";
import { transport } from "../src/lib/transport";
import { SessionStore } from "../src/session/store";

afterEach(() => vi.restoreAllMocks());

test("renderer attachment submission sends hash references without local paths or trusted identity fields", async () => {
  const command = vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted" });
  const store = new SessionStore("attachment-session");
  const reference = `sha256:${"a".repeat(64)}`;

  await store.sendMessageWithAttachments("inspect this", [reference]);

  expect(command).toHaveBeenCalledWith({
    type: "conversation.send_message",
    text: "inspect this",
    attachments: [reference],
    input_purpose: "trigger_turn",
  }, { kind: "session", session_id: "attachment-session" });
  const sent = command.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(sent).not.toHaveProperty("as_system");
  expect(sent).not.toHaveProperty("inter_agent");
  expect(sent).not.toHaveProperty("subagent_terminal");
  expect(JSON.stringify(sent)).not.toContain("/home/");
  store.dispose();
});
