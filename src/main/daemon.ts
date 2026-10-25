import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { isAlive, resolveCredentials, DiscoveryError } from "@qaqh/sdk/node";
import { RINGING_V2_VERSION } from "@qaqh/sdk/protocol";
import type { DaemonDiscovery } from "./types.js";

export function getDataDir(): string {
  if (process.env.QAQH_DATA_DIR && process.env.QAQH_DATA_DIR.trim() !== "") {
    return process.env.QAQH_DATA_DIR;
  }
  if (process.platform === "win32") {
    return join(homedir(), ".qaqh");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") {
    return join(xdg, "qaqh");
  }
  return join(homedir(), ".config", "qaqh");
}

export function getDiscoveryCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.QAQH_DATA_DIR && process.env.QAQH_DATA_DIR.trim() !== "") {
    candidates.push(join(process.env.QAQH_DATA_DIR, "daemon.json"));
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") {
    candidates.push(join(xdg, "qaqh", "daemon.json"));
  }
  candidates.push(join(homedir(), ".config", "qaqh", "daemon.json"));
  candidates.push(join(homedir(), ".qaqh", "daemon.json"));
  return candidates;
}

/**
 * 严格校验优先：SDK resolveCredentials 逐候选校验形状/协议版本/pid 存活。
 * 仅当候选文档存在但缺少必需字段（旧版 daemon 遗留）时走宽松回退，避免
 * 老文档让 shell 无法启动；wrong_protocol/dead_pid 等明确拒绝则继续下一候选。
 */
export async function readDiscovery(): Promise<DaemonDiscovery | null> {
  for (const p of getDiscoveryCandidates()) {
    try {
      return await resolveCredentials({ kind: "local-discovery", path: p });
    } catch (err) {
      if (err instanceof DiscoveryError && err.code === "not_found") continue;
      if (err instanceof DiscoveryError && err.code === "invalid_shape") {
        const lenient = readLenientDiscovery(p);
        if (lenient) {
          console.warn(`[daemon] ${p} 缺少必需字段（旧版 discovery 文档?），宽松接受: ${err.message}`);
          return lenient;
        }
        continue;
      }
      console.warn(`[daemon] Discovery candidate ${p} rejected: ${(err as Error).message}`);
    }
  }
  return null;
}

function readLenientDiscovery(path: string): DaemonDiscovery | null {
  try {
    const json = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
    if (json.endpoint && json.token && json.pid) {
      return {
        ...json,
        server_epoch: json.server_epoch ?? "",
        protocol_version: json.protocol_version ?? RINGING_V2_VERSION,
        daemon_version: json.daemon_version ?? "",
        build_id: json.build_id ?? "",
        channel: json.channel ?? "",
        executable: json.executable ?? "",
        lan_endpoint: json.lan_endpoint ?? null,
        tls_fingerprint: json.tls_fingerprint ?? null,
      } as DaemonDiscovery;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function isEndpointReachable(discovery: DaemonDiscovery): Promise<boolean> {
  try {
    let urlStr = discovery.endpoint;
    if (urlStr.startsWith("ws://")) urlStr = urlStr.replace("ws://", "http://");
    if (urlStr.startsWith("wss://")) urlStr = urlStr.replace("wss://", "https://");
    const u = new URL(urlStr);
    const healthUrl = `${u.protocol}//${u.host}/health`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600);
    const resp = await fetch(healthUrl, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);

    if (resp && resp.ok) {
      const text = await resp.text();
      return text.includes("ok");
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveDaemonExecutable(): string | null {
  if (process.env.QAQH_DAEMON_PATH && existsSync(process.env.QAQH_DAEMON_PATH)) {
    return process.env.QAQH_DAEMON_PATH;
  }

  // 生产环境打包路径 (resources/bin/qaqh-daemon)
  if ((process as any).resourcesPath) {
    const binName = process.platform === "win32" ? "qaqh-daemon.exe" : "qaqh-daemon";
    const prodPath = join((process as any).resourcesPath, "bin", binName);
    if (existsSync(prodPath)) return prodPath;
  }

  // 本地开发路径（同级项目 qaqh-backend）
  const candidates = [
    resolve(process.cwd(), "../qaqh-backend/target/release/qaqh-daemon"),
    resolve(process.cwd(), "../qaqh-backend/target/debug/qaqh-daemon"),
    resolve(process.cwd(), "resources/bin/qaqh-daemon"),
    resolve(process.cwd(), "../qaqh-backend/target/release/qaqh-daemon.exe"),
    resolve(process.cwd(), "../qaqh-backend/target/debug/qaqh-daemon.exe"),
    resolve(process.cwd(), "resources/bin/qaqh-daemon.exe"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export class DaemonManager {
  private spawnedPid: number | null = null;

  async ensureDaemonRunning(timeoutMs = 15000): Promise<DaemonDiscovery> {
    const existing = await readDiscovery();
    if (existing && isAlive(existing.pid) && (await isEndpointReachable(existing))) {
      console.log(`[daemon] Reusing live daemon (pid: ${existing.pid}, endpoint: ${existing.endpoint})`);
      return existing;
    }

    const exe = resolveDaemonExecutable();
    if (!exe) {
      throw new Error(
        "Could not find qaqh-daemon executable. Please set QAQH_DAEMON_PATH or build qaqh-backend."
      );
    }

    console.log(`[daemon] Spawning daemon: ${exe} run`);
    const child = spawn(exe, ["run"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || "info",
      },
    });

    child.unref();
    this.spawnedPid = child.pid ?? null;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const disc = await readDiscovery();
      if (disc && isAlive(disc.pid) && (await isEndpointReachable(disc))) {
        console.log(`[daemon] Daemon ready at ${disc.endpoint} (pid: ${disc.pid})`);
        return disc;
      }
    }

    throw new Error(`Timed out waiting for daemon to publish discovery after ${timeoutMs}ms`);
  }

  getSpawnedPid(): number | null {
    return this.spawnedPid;
  }
}
