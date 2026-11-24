/**
 * 原生桌面宠物（qaqh-pet）进程管理：
 * - 桌宠是独立 Rust RingingV2 客户端（不经过 Electron 转发业务流，主窗关闭/隐藏后照常存活）；
 * - Electron 设置页只负责启停与状态查询，并在启动时传入 `--shell-exe`（开发态附带 `--shell-arg`），
 *   让用户在桌宠上双击或点击待审批提示时，通过单实例锁（second-instance）把主窗拉回前台。
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_PET_PORT = 47832;

export interface PetStatusView {
  running: boolean;
  pid: number | null;
  exePath: string | null;
  exeExists: boolean;
  port: number;
  daemonConnected: boolean;
  pose: string | null;
  activityLabel: string | null;
  balanceDisplay: string | null;
}

let ownedChild: ChildProcess | null = null;

function readConfiguredPort(): number {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".qaqh", "pet-config.json"), "utf8")) as { mcp_port?: unknown };
    const p = Number(raw.mcp_port);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) return p;
  } catch {
    // 尚未生成配置时用默认端口
  }
  return DEFAULT_PET_PORT;
}

/** 解析 qaqh-pet 可执行文件候选顺序：显式环境变量 > 打包 resources > 兄弟仓 release/debug 产物。 */
export function resolvePetExecutable(): string | null {
  const exeName = process.platform === "win32" ? "qaqh-pet.exe" : "qaqh-pet";
  const candidates: string[] = [];
  const envExe = process.env.QAQH_PET_EXE?.trim();
  if (envExe) candidates.push(envExe);
  if (app.isPackaged) {
    // 唯一规范打包路径（electron-builder.yml win.extraResources -> resources/pet/，
    // 同级自带 packs/default/，与 qaqh-pet 的 <exe_dir>/packs 查找序直接对齐）。
    candidates.push(join(process.resourcesPath, "pet", exeName));
  } else {
    candidates.push(resolve(process.cwd(), "..", "qaqh-pets", "target", "release", exeName));
    candidates.push(resolve(process.cwd(), "..", "qaqh-pets", "target", "debug", exeName));
  }
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return candidates[0] ?? null;
}

interface PetRemoteState {
  pose?: unknown;
  daemon_connected?: unknown;
  activity_label?: unknown;
  balance?: { total_display?: unknown };
}

async function probePetState(port: number): Promise<PetRemoteState | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return null;
    return (await res.json()) as PetRemoteState;
  } catch {
    return null;
  }
}

function ownedAlive(): boolean {
  return ownedChild != null && ownedChild.exitCode === null && !ownedChild.killed;
}

export async function petStatus(): Promise<PetStatusView> {
  const port = readConfiguredPort();
  const exePath = resolvePetExecutable();
  const exeExists = exePath != null && existsSync(exePath);
  const remote = await probePetState(port);
  const running = remote != null || ownedAlive();
  return {
    running,
    pid: ownedAlive() ? (ownedChild!.pid ?? null) : null,
    exePath,
    exeExists,
    port,
    daemonConnected: remote?.daemon_connected === true,
    pose: typeof remote?.pose === "string" ? remote.pose : null,
    activityLabel: typeof remote?.activity_label === "string" ? remote.activity_label : null,
    balanceDisplay: typeof remote?.balance?.total_display === "string" && remote.balance.total_display !== ""
      ? remote.balance.total_display
      : null,
  };
}

export async function petStart(): Promise<PetStatusView> {
  const current = await petStatus();
  if (current.running) return current;
  const exePath = current.exePath;
  if (exePath == null || !existsSync(exePath)) {
    throw new Error(`未找到桌宠可执行文件（期望：${exePath ?? "qaqh-pet.exe"}），请先在 qaqh-pets 仓编译`);
  }
  const args: string[] = ["--shell-exe", process.execPath];
  if (!app.isPackaged) {
    // 开发态 electron.exe 必须带 app 路径才能命中本应用单实例锁，避免拉起裸 Electron 欢迎页。
    args.push("--shell-arg", app.getAppPath());
  }
  const child = spawn(exePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  child.once("exit", () => {
    if (ownedChild === child) ownedChild = null;
  });
  ownedChild = child;

  // 等 1.2s 内状态口就绪，让设置页立即拿到真实运行态
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    if (await probePetState(current.port)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return petStatus();
}

export async function petStop(): Promise<PetStatusView> {
  const port = readConfiguredPort();
  // 优先走软退出（无论是本壳拉起还是用户手动双击启动的桌宠都能干净收窗）
  try {
    await fetch(`http://127.0.0.1:${port}/dev/event?kind=quit`, {
      signal: AbortSignal.timeout(500),
    });
  } catch {
    // 端口未响应则回退到 kill 自有子进程
  }
  const deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    if (!ownedAlive() && (await probePetState(port)) == null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ownedAlive() && ownedChild?.pid != null) {
    try { process.kill(ownedChild.pid); } catch { /* 已退出 */ }
    ownedChild = null;
  }
  return petStatus();
}
