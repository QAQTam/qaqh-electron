/**
 * updater 桥:把 crates/qaqh-update 的 `qaqh-update` CLI 接进壳进程。
 *
 * 链路(与双根架构对齐,overlay = ~/.local/share/QAQ-Harness):
 *   检查  plan --json          ← 只读,不动文件
 *   暂存  stage --json         ← 校验+落 .update-staging,写 staged-operation.json
 *   应用  apply-staged
 *     - electron 策略:renderer 确认退出后,这里 spawn detached 的
 *       `apply-staged --wait-pid <shell-pid> --relaunch <electron> <app-path>`,
 *       壳退出后 updater 换文件并重启;renderer 随后走既有 request-quit 流程。
 *     - daemon 策略:停 daemon → 同步应用(壳还活着,只有 backend/ 被换)→
 *       走 ipc-handlers 的 restartDaemon 重连。壳不用重启。
 *
 * 路径解析顺序(均可被环境变量覆盖,测试/开发用):
 *   CLI       QAQH_UPDATE_BIN → resources/bin/qaqh-update → cargo 产物(release/debug)
 *   组件根    QAQH_COMPONENT_ROOT → ~/.local/share/QAQ-Harness
 *   更新源    QAQH_UPDATE_SOURCE → <组件根>/update-source
 *   暂存区    QAQH_UPDATE_STAGING → <组件根>/.update-staging
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userComponentRoot } from "./component-paths.js";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);

export interface UpdatePlanView {
  operationId: string;
  releaseId: string;
  mode: string;
  artifacts: string[];
  actions: string[];
}

export interface UpdateCheckResult {
  upToDate: boolean;
  plan: UpdatePlanView;
}

export interface StagedArtifactView {
  id: string;
  kind: string;
  path: string;
  size: number;
  sha256: string;
}

export interface StagedStatus {
  staged: true;
  operationId: string;
  releaseId: string;
  mode: string;
  artifacts: StagedArtifactView[];
  /** 纯 backend = daemon(免重启壳);混入其他组件 = electron(退出换文件重启)。 */
  restartPolicy: "daemon" | "electron";
}

export interface UpdaterPaths {
  componentRoot: string;
  sourceDir: string;
  stagingDir: string;
}

export function updaterPaths(): UpdaterPaths {
  const componentRoot = userComponentRoot();
  return {
    componentRoot,
    sourceDir: process.env.QAQH_UPDATE_SOURCE?.trim() || join(componentRoot, "update-source"),
    stagingDir: join(componentRoot, "staging"),
  };
}

export function resolveEngineCli(binary: "qaqh-update" | "qaqh-maint"): string {
  const override = (binary === "qaqh-maint" ? process.env.QAQH_MAINT_BIN : process.env.QAQH_UPDATE_BIN)?.trim();
  if (override) return override;
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "bin", binary) : "",
    join(app.getAppPath(), "crates", "qaqh-update", "target", "release", binary),
    join(app.getAppPath(), "crates", "qaqh-update", "target", "debug", binary),
  ].filter((candidate) => candidate.length > 0 && existsSync(candidate));
  const found = candidates[0];
  if (!found) {
    throw new Error(`${binary} CLI 不存在(设 QAQH_UPDATE_BIN/QAQH_MAINT_BIN,或 cargo build -p qaqh-update)`);
  }
  return found;
}

function resolveUpdateCli(): string {
  return resolveEngineCli("qaqh-update");
}

async function runCli(arguments_: string[]): Promise<string> {
  const cli = resolveUpdateCli();
  try {
    const { stdout } = await execFileAsync(cli, arguments_, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`qaqh-update ${arguments_[0]} 失败: ${detail}`);
  }
}

export async function checkForUpdates(sourceDir?: string): Promise<UpdateCheckResult> {
  const paths = updaterPaths();
  const stdout = await runCli([
    "plan", "--json",
    "--source", sourceDir?.trim() || paths.sourceDir,
    "--install-root", paths.componentRoot,
  ]);
  const plan = JSON.parse(stdout) as UpdatePlanView;
  return { upToDate: plan.artifacts.length === 0, plan };
}

export async function stageUpdate(sourceDir?: string): Promise<StagedStatus> {
  const paths = updaterPaths();
  const stdout = await runCli([
    "stage", "--json",
    "--source", sourceDir?.trim() || paths.sourceDir,
    "--install-root", paths.componentRoot,
    "--staging", paths.stagingDir,
  ]);
  const summary = JSON.parse(stdout) as {
    upToDate: boolean;
    operationId: string;
    releaseId: string;
    mode: string;
    artifacts: StagedArtifactView[];
  };
  if (summary.upToDate) {
    throw new Error("已经是最新版本,没有可暂存的更新");
  }
  return {
    staged: true,
    operationId: summary.operationId,
    releaseId: summary.releaseId,
    mode: summary.mode,
    artifacts: summary.artifacts,
    restartPolicy: deriveRestartPolicy(summary.artifacts),
  };
}

/** 直接读暂存区的 staged-operation.json(不需要 CLI 在场)。 */
export function stagedStatus(): StagedStatus | null {
  const paths = updaterPaths();
  const operationPath = join(paths.stagingDir, "staged-operation.json");
  if (!existsSync(operationPath)) return null;
  let operation: {
    operationId: string;
    releaseId: string;
    plan: { mode: string; artifacts: string[] };
    artifacts: StagedArtifactView[];
  };
  try {
    operation = JSON.parse(readFileSync(operationPath, "utf8"));
  } catch (error) {
    throw new Error(`暂存操作损坏(${operationPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    staged: true,
    operationId: operation.operationId,
    releaseId: operation.releaseId,
    mode: operation.plan.mode,
    artifacts: operation.artifacts,
    restartPolicy: deriveRestartPolicy(operation.artifacts),
  };
}

function deriveRestartPolicy(artifacts: StagedArtifactView[]): "daemon" | "electron" {
  return artifacts.length > 0 && artifacts.every((artifact) => artifact.kind === "backend")
    ? "daemon"
    : "electron";
}

/** daemon 策略:壳保持运行,同步应用暂存(调用方需先停 daemon)。 */
export async function applyForDaemon(): Promise<void> {
  const paths = updaterPaths();
  await runCli(["apply-staged", "--staging", paths.stagingDir, "--install-root", paths.componentRoot]);
}

/** electron 策略:挂 detached updater 等 shell 退出后换文件并重启。 */
export function spawnApplyOnQuit(): void {
  const paths = updaterPaths();
  const relaunch = [process.execPath, app.getAppPath()];
  const child = spawn(resolveUpdateCli(), [
    "apply-staged",
    "--staging", paths.stagingDir,
    "--install-root", paths.componentRoot,
    "--wait-pid", String(process.pid),
    "--wait-timeout", "600",
    "--relaunch", ...relaunch,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`[updater] apply-staged armed (wait-pid ${process.pid}), cli=${resolve(process.execPath)}`);
}
