// DaemonManager（spec §4.1）：发现 → adopt / spawn 状态机；退出链 stop-if-idle；
// discovery 轮询死亡检测 + configChanged 推送。
import { app } from "electron";
import { readDiscovery, isPidAlive, ensureDaemon, stopDaemonIfIdle, type DaemonDiscovery } from "qaqh-js-sdk/node";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DaemonPhase = "idle" | "adopting" | "spawning" | "ready" | "exited" | "missing";

export interface DaemonStatus {
  phase: DaemonPhase;
  running: boolean;
  pid?: number;
  spawnedByUs: boolean;
  missing?: boolean;
}

const POLL_MS = 10_000;

export class DaemonManager {
  private discovery: DaemonDiscovery | null = null;
  private phase: DaemonPhase = "idle";
  private spawnedByUs = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMtime = 0;
  private lastEpoch = "";
  private lastEndpoint = "";
  private binPath: string | null = null;

  /** binPath 解析顺序：env → 打包资源/仓库 target → PATH（spec §4.1）。 */
  private resolveBinPath(): string | null {
    if (process.env.QAQH_DAEMON_BIN) return process.env.QAQH_DAEMON_BIN;
    const candidate = app.isPackaged
      ? path.join(process.resourcesPath, "bin", "qaqh-daemon")
      : "/home/qaqtamsy/Projects/QAQ-Harness/target/release/qaqh-daemon";
    if (fs.existsSync(candidate)) return candidate;
    const which = spawnSync("which", ["qaqh-daemon"], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    return null;
  }

  /** 启动序列（app ready 后、窗口加载前一次）。 */
  async ensure(): Promise<DaemonDiscovery> {
    this.phase = "adopting";
    const found = await readDiscovery();
    if (found && isPidAlive(found.pid)) {
      this.discovery = found;
      this.spawnedByUs = false;
      this.phase = "ready";
      this.snapshotMeta();
      this.startPolling();
      return found;
    }
    this.binPath ??= this.resolveBinPath();
    if (!this.binPath) {
      this.phase = "missing";
      throw new Error("daemon binary not found");
    }
    this.phase = "spawning";
    this.discovery = await ensureDaemon({ binPath: this.binPath, timeoutMs: 20_000 });
    this.spawnedByUs = true;
    this.phase = "ready";
    this.snapshotMeta();
    this.startPolling();
    return this.discovery;
  }

  private snapshotMeta(): void {
    if (!this.discovery) return;
    try {
      this.lastMtime = fs.statSync(discoveryPathOf()).mtimeMs;
    } catch {
      this.lastMtime = 0;
    }
    this.lastEpoch = this.discovery.server_epoch;
    this.lastEndpoint = this.discovery.endpoint;
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      const d = this.discovery;
      if (!d) return;
      // daemon 进程死亡检测
      if (!isPidAlive(d.pid)) {
        this.phase = "exited";
        this.stopPolling();
        push("qaqh:daemonDied", {});
        return;
      }
      // discovery mtime → epoch/endpoint 变化检测
      try {
        const st = fs.statSync(discoveryPathOf());
        if (st.mtimeMs !== this.lastMtime) {
          this.lastMtime = st.mtimeMs;
          void readDiscovery().then((fresh) => {
            if (!fresh) return;
            if (fresh.server_epoch !== this.lastEpoch || fresh.endpoint !== this.lastEndpoint) {
              this.lastEpoch = fresh.server_epoch;
              this.lastEndpoint = fresh.endpoint;
              this.discovery = fresh;
              push("qaqh:configChanged", {});
            }
          });
        }
      } catch {
        /* discovery 文件暂时不可读 → 忽略 */
      }
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  status(): DaemonStatus {
    return {
      phase: this.phase,
      running: this.phase === "ready" && Boolean(this.discovery && isPidAlive(this.discovery.pid)),
      pid: this.discovery?.pid,
      spawnedByUs: this.spawnedByUs,
      missing: this.phase === "missing",
    };
  }

  /** 退出链（before-quit）：仅自己拉起的 daemon 才 stop-if-idle；busy 放行。 */
  async shutdown(): Promise<void> {
    this.stopPolling();
    if (!this.spawnedByUs || !this.discovery) return;
    try {
      await stopDaemonIfIdle(this.discovery, 5000);
    } catch {
      /* 放行退出 */
    }
  }
}

import { discoveryPath } from "qaqh-js-sdk/node";
function discoveryPathOf(): string {
  return discoveryPath();
}

import { webContents } from "electron";
function push(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    void wc.send(channel, payload);
  }
}
