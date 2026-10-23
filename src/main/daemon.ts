import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import * as net from "node:net";
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

export function getDiscoveryPath(): string {
  return join(getDataDir(), "daemon.json");
}

export function readDiscovery(): DaemonDiscovery | null {
  const p = getDiscoveryPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const json = JSON.parse(raw) as DaemonDiscovery;
    return json;
  } catch (err) {
    console.warn(`[daemon] Failed to read ${p}:`, err);
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // EPERM means process exists but we lack permission
  }
}

export async function isEndpointReachable(discovery: DaemonDiscovery): Promise<boolean> {
  try {
    let urlStr = discovery.endpoint;
    if (urlStr.startsWith("ws://")) urlStr = urlStr.replace("ws://", "http://");
    if (urlStr.startsWith("wss://")) urlStr = urlStr.replace("wss://", "https://");
    const u = new URL(urlStr);
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const host = u.hostname || "127.0.0.1";

    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 300 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
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
    const existing = readDiscovery();
    if (existing && isProcessAlive(existing.pid) && (await isEndpointReachable(existing))) {
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
      const disc = readDiscovery();
      if (disc && isProcessAlive(disc.pid) && (await isEndpointReachable(disc))) {
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
