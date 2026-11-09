/**
 * 本地热更新(前端组件)壳侧封装。
 *
 * 流程(release 端 → 壳):
 *   1. `just frontend-update` 产出 update-source(catalog.json + bundle.zip)发布到
 *      本地源目录(默认 %LOCALAPPDATA%\QAQ-Harness\update-source,QAQH_UPDATE_SOURCE 可覆盖);
 *   2. 壳通过 qaqh-update CLI `plan --json` 只读检查(release 端 vs 当前安装组件);
 *   3. 用户确认 → `stage --json` 校验 sha256 并把载荷写入 <安装根>/staging/;
 *   4. 「重启并应用」→ 壳 spawn 分离的 `apply-staged --wait-pid <本进程> --relaunch <exe>`,
 *      然后 app.quit()。更新器等壳退出后原子换 resources/app.asar,再拉起新壳。
 *      daemon 是 detached 子进程,不受壳重启影响,新壳重连即可(会话无感)。
 *
 * 失败面:stage 失败不清旧暂存;apply 失败可用 `qaqh-update rollback-staged` 回退;
 * install-root 标记缺失时首启动用 `init --adopt` 收编 NSIS 平根(见 crates/qaqh-update)。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { CONTROL_PROTOCOL_VERSION } from "./types.js";

const INSTALL_ROOT_MARKER = ".deepx-install-root.json";
const STAGED_OPERATION_FILE = "staged-operation.json";
const UPDATER_BIN = process.platform === "win32" ? "qaqh-update.exe" : "qaqh-update";

/** 渲染层可见的检查/暂存结果(与 qaqh-update --json 输出对齐,字段收敛到壳需要的部分)。 */
export interface UpdatePlanView {
  upToDate: boolean;
  releaseId: string;
  mode: string;
  artifacts: string[];
}

export interface UpdateStatus {
  /** 壳是否具备热更新能力(packaged + updater CLI 随包)。 */
  available: boolean;
  /** 不可用原因(dev/unpackaged、缺二进制)。available=true 时缺省。 */
  reason?: string;
  sourceDir: string;
  installRoot: string;
  version: string;
  plan: UpdatePlanView | null;
  /** <安装根>/staging/staged-operation.json 是否就绪(等待重启应用)。 */
  staged: boolean;
  error?: string;
}

function installRoot(): string {
  return dirname(app.getPath("exe"));
}

function updaterPath(): string {
  return join(process.resourcesPath, "bin", UPDATER_BIN);
}

function stagingRoot(): string {
  return join(installRoot(), "staging");
}

function stagedOperationPath(): string {
  return join(stagingRoot(), STAGED_OPERATION_FILE);
}

export function updateSourceDir(): string {
  return process.env.QAQH_UPDATE_SOURCE?.trim()
    || join(process.env.LOCALAPPDATA ?? app.getPath("appData"), "QAQ-Harness", "update-source");
}

/** 壳侧热更新能力:仅 packaged 运行(有安装根与随包 CLI);dev 下状态栏给原因。 */
export function updaterAvailable(): boolean {
  return app.isPackaged && existsSync(updaterPath());
}

/**
 * 首启动收编:NSIS 装出来的平根没有 install-root 标记,stage/apply 会拒绝执行。
 * `init --adopt` 幂等(已有标记直接 verify),失败只影响本次热更新能力,不阻塞壳启动。
 */
export function ensureInstallRootAdopted(): void {
  if (!updaterAvailable()) return;
  if (existsSync(join(installRoot(), INSTALL_ROOT_MARKER))) return;
  const result = spawnSync(updaterPath(), ["init", "--install-root", installRoot(), "--adopt"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.warn("[updater] install root adopt failed:", (result.stderr || result.stdout || "").trim());
    return;
  }
  console.log("[updater] install root adopted:", (result.stdout || "").trim());
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(updaterPath(), args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error != null) throw result.error;
  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 与 crates/qaqh-update/src/state.rs::installation_id_for_path 同口径(FNV-1a 64)。 */
function installationIdFor(root: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(root.toLowerCase(), "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return `install-${hash.toString(16).padStart(16, "0")}`;
}

/**
 * 首次热更新前种子化 install-state.json:planner 需要 frontend/backend 组件做
 * 协议对照,NSIS 初始安装没有这份文件,缺失会让 frontend-only catalog 永远走
 * full fallback 而报错。种子值来源:前端 commit(esbuild 注入)+ daemon.json 的
 * build_id/protocol_version(读不到时按「捆绑即匹配」假设回退 CONTROL_PROTOCOL_VERSION)。
 */
function ensureInstallStateSeeded(): void {
  const statePath = join(installRoot(), "install-state.json");
  if (existsSync(statePath)) return;
  let daemonBuildId = "bundled";
  let daemonProtocol: number = CONTROL_PROTOCOL_VERSION;
  try {
    const dataDir = process.env.QAQH_DATA_DIR?.trim() || app.getPath("userData");
    const discovery = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")) as {
      build_id?: unknown;
      protocol_version?: unknown;
    };
    if (typeof discovery.build_id === "string" && discovery.build_id !== "") {
      daemonBuildId = discovery.build_id;
    }
    if (typeof discovery.protocol_version === "number") {
      daemonProtocol = discovery.protocol_version;
    }
  } catch { /* daemon.json 缺失时按捆绑假设 */ }
  const frontendBuild = process.env.QAQH_GIT_COMMIT?.trim() || "unknown-frontend";
  const state = {
    formatVersion: 2,
    installationId: installationIdFor(installRoot()),
    releaseId: app.getVersion(),
    channel: "local",
    components: {
      frontend: {
        current: frontendBuild,
        version: process.env.QAQH_BUILD_VERSION?.trim() || app.getVersion(),
        protocol: CONTROL_PROTOCOL_VERSION,
        health: "healthy",
      },
      backend: {
        current: daemonBuildId,
        version: "bundled",
        protocol: daemonProtocol,
        health: "healthy",
      },
    },
    lastCommittedOperation: null,
  };
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log("[updater] install state seeded:", statePath);
  } catch (error) {
    console.warn("[updater] install state seed failed:", error);
  }
}

/** `plan --json` 只读检查;CLI 非零/解析失败都以 error 字段返回,不抛异常打断 UI。 */
export function checkForUpdate(): UpdateStatus {
  const base: UpdateStatus = {
    available: updaterAvailable(),
    sourceDir: updateSourceDir(),
    installRoot: installRoot(),
    version: app.getVersion(),
    plan: null,
    staged: existsSync(stagedOperationPath()),
  };
  if (!base.available) {
    return { ...base, reason: app.isPackaged ? "随包更新器缺失(resources/bin)" : "开发环境(未打包)" };
  }
  ensureInstallStateSeeded();
  try {
    const result = runCli(["plan", "--source", base.sourceDir, "--install-root", base.installRoot, "--json"]);
    if (result.status !== 0) {
      return { ...base, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    }
    const parsed = JSON.parse(result.stdout) as Partial<UpdatePlanView> & { artifacts?: string[] };
    base.plan = {
      upToDate: parsed.artifacts?.length === 0,
      releaseId: parsed.releaseId ?? "",
      mode: parsed.mode ?? "",
      artifacts: parsed.artifacts ?? [],
    };
    return base;
  } catch (error) {
    return { ...base, error: String(error instanceof Error ? error.message : error) };
  }
}

/** 校验并暂存;成功后 staged=true,等待「重启并应用」。 */
export function stageUpdate(): UpdateStatus {
  const status = checkForUpdate();
  if (!status.available) return status;
  if (status.plan == null || status.plan.upToDate) return status;
  try {
    const result = runCli([
      "stage", "--source", status.sourceDir, "--install-root", status.installRoot,
      "--staging", stagingRoot(), "--json",
    ]);
    if (result.status !== 0) {
      return { ...status, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    }
    status.staged = existsSync(stagedOperationPath());
    return status;
  } catch (error) {
    return { ...status, error: String(error instanceof Error ? error.message : error) };
  }
}

/**
 * 启动 apply-staged handoff 并退出壳。返回前确认暂存存在;spawn 失败抛错由 IPC 层
 * 转成 toast,壳保持运行(不丢半程)。成功路径:更新器等本进程退出 → 换 asar → 拉新壳。
 */
export function applyStagedAndQuit(): void {
  if (!updaterAvailable()) throw new Error("更新器不可用(未打包或随包 CLI 缺失)");
  if (!existsSync(stagedOperationPath())) throw new Error("没有已暂存的更新,请先检查并下载");
  const child = spawn(updaterPath(), [
    "apply-staged", "--staging", stagingRoot(), "--install-root", installRoot(),
    "--wait-pid", String(process.pid), "--relaunch", process.execPath,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
