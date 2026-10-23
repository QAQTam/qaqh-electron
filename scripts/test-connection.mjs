import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function getDiscoveryCandidates() {
  const candidates = [];
  if (process.env.QAQH_DATA_DIR) {
    candidates.push(join(process.env.QAQH_DATA_DIR, "daemon.json"));
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    candidates.push(join(xdg, "qaqh", "daemon.json"));
  }
  candidates.push(join(homedir(), ".config", "qaqh", "daemon.json"));
  candidates.push(join(homedir(), ".qaqh", "daemon.json"));
  return candidates;
}

function readDiscovery() {
  for (const p of getDiscoveryCandidates()) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const json = JSON.parse(raw);
        if (json.endpoint && json.token && json.pid) {
          return json;
        }
      } catch {}
    }
  }
  return null;
}

async function main() {
  console.log("=== Testing Connection to Live Daemon ===");
  const disc = readDiscovery();
  console.log("Discovery read:", disc ? `Found (PID: ${disc.pid}, Endpoint: ${disc.endpoint})` : "Not found");
  if (!disc) {
    console.error("No discovery found!");
    process.exit(1);
  }

  // 1. 测试 Health 探针
  const healthResp = await fetch(`${disc.endpoint}/health`);
  console.log("Health check status:", healthResp.status, await healthResp.text());

  // 2. 测试 Open 握手
  const openResp = await fetch(`${disc.endpoint}/ringing/v2/clients/open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${disc.token}`,
    },
    body: JSON.stringify({
      schema: "qaqh.Ringing",
      version: 2,
      client_instance_id: "probe-" + Date.now(),
    }),
  });
  console.log("Open client status:", openResp.status);
  const openData = await openResp.json();
  console.log("Client session ID:", openData.client_session_id);

  // 3. 测试 Session List
  const listResp = await fetch(`${disc.endpoint}/ringing/v2/service/session.list`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${disc.token}`,
      "X-QAQH-Client-Session-Id": openData.client_session_id,
    },
    body: JSON.stringify({}),
  });
  console.log("Session list status:", listResp.status);
  const sessions = await listResp.json();
  console.log("Sessions count:", sessions.length);

  // 4. 测试 Attach (所有权绑定)
  if (sessions.length > 0) {
    const testSeed = sessions[0].session_id;
    console.log("Testing attach/ownership claim for seed:", testSeed);
    const resumeResp = await fetch(`${disc.endpoint}/ringing/v2/commands/control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${disc.token}`,
        "X-QAQH-Client-Session-Id": openData.client_session_id,
      },
      body: JSON.stringify({
        schema: "qaqh.Ringing",
        version: 2,
        channel: "control",
        command_id: "probe-cmd-" + Date.now(),
        client_instance_id: "probe-instance",
        client_session_id: openData.client_session_id,
        session_id: testSeed,
        command: {
          channel: "control",
          type: "session_resume",
          session_id: testSeed,
        },
      }),
    });
    console.log("Resume status:", resumeResp.status, await resumeResp.json());

    // 5. 测试 Timeline Snapshot
    const snapResp = await fetch(`${disc.endpoint}/ringing/v2/sessions/${encodeURIComponent(testSeed)}/timeline?limit=5`, {
      headers: {
        Authorization: `Bearer ${disc.token}`,
        "X-QAQH-Client-Session-Id": openData.client_session_id,
      },
    });
    console.log("Timeline snapshot status:", snapResp.status);
    const snapData = await snapResp.json();
    console.log("Snapshot total turns:", snapData.total_turns);
  }

  console.log("\n=== All connection probes passed successfully! ===");
}

main().catch(console.error);
