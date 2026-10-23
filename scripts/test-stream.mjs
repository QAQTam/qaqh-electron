import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function getDiscovery() {
  const p = join(homedir(), ".config", "qaqh", "daemon.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

async function main() {
  const disc = getDiscovery();
  console.log("Connecting to daemon at", disc.endpoint);

  // 1. Open
  const openResp = await fetch(`${disc.endpoint}/ringing/v2/clients/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${disc.token}` },
    body: JSON.stringify({ schema: "qaqh.Ringing", version: 2, client_instance_id: "probe-stream" }),
  });
  const openData = await openResp.json();
  const clientSessionId = openData.client_session_id;

  // 2. 取会话列表
  const listResp = await fetch(`${disc.endpoint}/ringing/v2/service/session.list`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${disc.token}`,
      "X-QAQH-Client-Session-Id": clientSessionId,
    },
    body: JSON.stringify({}),
  });
  const list = await listResp.json();
  const seed = list[0].session_id;
  console.log("Using seed:", seed, "title:", list[0].title);

  // 3. Attach
  await fetch(`${disc.endpoint}/ringing/v2/commands/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${disc.token}`,
      "X-QAQH-Client-Session-Id": clientSessionId,
    },
    body: JSON.stringify({
      schema: "qaqh.Ringing",
      version: 2,
      channel: "control",
      command_id: "probe-attach-" + Date.now(),
      client_instance_id: "probe-stream",
      client_session_id: clientSessionId,
      session_id: seed,
      command: { channel: "control", type: "session_resume", session_id: seed },
    }),
  });

  // 4. 连接 timeline/events
  console.log("Connecting timeline SSE...");
  const timelineResp = await fetch(`${disc.endpoint}/ringing/v2/sessions/${encodeURIComponent(seed)}/timeline/events`, {
    headers: {
      Authorization: `Bearer ${disc.token}`,
      "X-QAQH-Client-Session-Id": clientSessionId,
      Accept: "text/event-stream",
    },
  });

  const reader = timelineResp.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  while (received < 3) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    console.log("--- Timeline SSE chunk ---");
    console.log(text);
    received++;
  }
}

main().catch(console.error);
