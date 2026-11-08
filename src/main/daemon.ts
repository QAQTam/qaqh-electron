import { existsSync, readFileSync, statSync } from "node:fs";
import { app } from "electron";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { CONTROL_PROTOCOL_VERSION } from "./types.js";
import type { DaemonDiscovery } from "./types.js";

/** pid 判活（signal 0 探测；EPERM 表示存在但无权限，也算活着）。 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** discovery 文档校验失败的分类拒绝（等价旧 @qaqh/sdk DiscoveryError）。 */
export class DiscoveryError extends Error {
  constructor(readonly code: "not_found" | "invalid_shape" | "wrong_protocol" | "dead_pid", message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * 严格校验一个 discovery 候选：形状（DaemonDiscovery 全字段）、wire 协议
 * 版本、pid 存活。与 Rust 侧 `qaqh_client::discovery` 同一磁盘契约。
 */
export function resolveCredentials(reference: { kind: "local-discovery"; path: string }): DaemonDiscovery {
  let raw: string;
  try {
    raw = readFileSync(reference.path, "utf-8");
  } catch {
    throw new DiscoveryError("not_found", `discovery document not found: ${reference.path}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new DiscoveryError("invalid_shape", `discovery document is not JSON: ${reference.path}`);
  }
  const required = ["endpoint", "token", "daemon_version", "build_id", "channel", "executable"] as const;
  for (const field of required) {
    const value = json[field];
    if (typeof value !== "string" || value === "") {
      throw new DiscoveryError("invalid_shape", `discovery document missing ${field}`);
    }
  }
  if (typeof json.pid !== "number") throw new DiscoveryError("invalid_shape", "discovery document missing pid");
  if (json.protocol_version !== CONTROL_PROTOCOL_VERSION) {
    throw new DiscoveryError("wrong_protocol", `unexpected control protocol ${String(json.protocol_version)}`);
  }
  const discovery = json as unknown as DaemonDiscovery;
  if (!isAlive(discovery.pid)) {
    throw new DiscoveryError("dead_pid", `daemon pid ${discovery.pid} is not running`);
  }
  return discovery;
}

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
        protocol_version: json.protocol_version ?? CONTROL_PROTOCOL_VERSION,
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
  const binName = process.platform === "win32" ? "qaqh-daemon.exe" : "qaqh-daemon";
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "bin", binName);
    return existsSync(packaged) ? packaged : null;
  }
  if (process.env.QAQH_DAEMON_PATH && existsSync(process.env.QAQH_DAEMON_PATH)) {
    return process.env.QAQH_DAEMON_PATH;
  }

  // 生产环境打包路径 (resources/bin/qaqh-daemon) —— 单体包/旧布局兼容。
  if ((process as any).resourcesPath) {
    const prodPath = join((process as any).resourcesPath, "bin", binName);
    if (existsSync(prodPath)) return prodPath;
  }

  // 系统安装路径(shell 包 / 独立 daemon 包)。
  const systemCandidates = process.platform === "win32"
    ? []
    : [join("/usr/local/bin", binName), join("/usr/bin", binName)];

  // 本地开发路径（同级项目 qaqh-backend）
  const candidates = [
    ...systemCandidates,
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

/** dpkg can replace an executable without changing its path or version. */
export function daemonMatchesExecutable(pid: number, executable: string): boolean {
  try {
    const running = statSync(`/proc/${pid}/exe`);
    const installed = statSync(executable);
    return running.dev === installed.dev && running.ino === installed.ino;
  } catch {
    return false;
  }
}

export class DaemonManager {
  private spawnedPid: number | null = null;

  async ensureDaemonRunning(timeoutMs = 15000): Promise<DaemonDiscovery> {
    const exe = resolveDaemonExecutable();
    const existing = await readDiscovery();
    if (existing && isAlive(existing.pid) && (await isEndpointReachable(existing))) {
      if (!app.isPackaged || process.platform !== "linux" || (exe && daemonMatchesExecutable(existing.pid, exe))) {
        console.log(`[daemon] Reusing live daemon (pid: ${existing.pid}, endpoint: ${existing.endpoint})`);
        return existing;
      }
      if (!exe) throw new Error("The installed package is missing resources/bin/qaqh-daemon.");
      const response = await fetch(new URL("/control/v1/stop-if-idle", existing.endpoint), {
        method: "POST",
        headers: { Authorization: `Bearer ${existing.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 409) {
        throw new Error("旧版 daemon 正在工作；任务结束后重新启动应用，以加载当前 deb 中的后端。");
      }
      if (!response.ok) throw new Error(`Stopping obsolete daemon failed (${response.status}).`);
      const stopDeadline = Date.now() + timeoutMs;
      while (isAlive(existing.pid) && Date.now() < stopDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isAlive(existing.pid)) throw new Error("旧版 daemon 未退出，无法启动当前安装包中的后端。");
    }

    if (!exe) {
      throw new Error(
        "Could not find qaqh-daemon executable. "
        + "Expected the app's resources/bin/qaqh-daemon; development builds may use QAQH_DAEMON_PATH. "
        + "Reinstall the application package or build qaqh-backend."
      );
    }

    console.log(`[daemon] Spawning daemon: ${exe} run`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RUST_LOG: process.env.RUST_LOG || "info",
    };
    // The ordinary loopback `run` mode must never inherit a LAN-only server token.
    delete env.QAQH_SERVER_TOKEN;
    const child = spawn(exe, ["run"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });

    const startup = { exit: null as string | null, failure: null as Error | null, stderr: "" };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      startup.stderr = (startup.stderr + chunk).slice(-16_384);
    });
    child.once("error", (error) => { startup.failure = error; });
    child.once("exit", (code, signal) => {
      startup.exit = `code=${String(code)}, signal=${String(signal)}`;
    });

    child.unref();
    this.spawnedPid = child.pid ?? null;

    const diagnostic = (): string => {
      const tail = startup.stderr.trim().split(/\r?\n/).slice(-12).join("\n").slice(-4_000);
      return tail === "" ? "" : `\n${tail}`;
    };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (startup.failure) {
        throw new Error(`Failed to start qaqh-daemon: ${startup.failure.message}${diagnostic()}`, { cause: startup.failure });
      }
      if (startup.exit != null) {
        throw new Error(`qaqh-daemon exited before publishing discovery (${startup.exit}).${diagnostic()}`);
      }
      const disc = await readDiscovery();
      if (disc && isAlive(disc.pid) && (await isEndpointReachable(disc))) {
        console.log(`[daemon] Daemon ready at ${disc.endpoint} (pid: ${disc.pid})`);
        return disc;
      }
    }

    throw new Error(`Timed out waiting for daemon to publish discovery after ${timeoutMs}ms.${diagnostic()}`);
  }

  getSpawnedPid(): number | null {
    return this.spawnedPid;
  }

  noteSpawned(pid: number): void {
    this.spawnedPid = pid;
  }

  startDaemon(args: string[], token?: string): number | null {
    const exe = resolveDaemonExecutable();
    if (!exe) throw new Error("Could not find qaqh-daemon executable.");
    const env: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: process.env.RUST_LOG || "info" };
    if (token) env.QAQH_SERVER_TOKEN = token;
    else delete env.QAQH_SERVER_TOKEN;
    delete env.QAQH_ADMIN_TOKEN;
    const child = spawn(exe, args, { detached: true, stdio: "ignore", env });
    child.unref();
    this.spawnedPid = child.pid ?? null;
    return this.spawnedPid;
  }
}
