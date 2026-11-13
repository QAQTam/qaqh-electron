import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { release as osRelease } from "node:os";
import { readDiscovery, DaemonManager } from "./daemon.js";
import { globalCommandTarget, loadNativeAddon, sessionCommandTarget } from "./native-client.js";
import { isAlive } from "./daemon.js";
import { pluginsRoot, notifyPluginsChanged } from "./plugins.js";
import { importPlugin, listManagedPlugins, removePlugin, setPluginEnabled } from "./frontend-plugins.js";
import { readGitStatus } from "./git-status.js";
import type { RingingCommand } from "../../webui/src/api/qaqh/RingingCommand";
import type { CommandTarget } from "../../webui/src/api/qaqh/CommandTarget";
import type { CommandPrecondition } from "../../webui/src/api/qaqh/CommandPrecondition";
import type { ConversationSendMessage } from "../../webui/src/api/qaqh/ConversationSendMessage";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { resolveDaemonExecutable } from "./daemon.js";
import { hostname } from "node:os";
import type { RingingClient } from "./ringing-client.js";
import type { ChallengeManager } from "./challenges.js";
import { approvalCommand, flattenAdminApprovals, requireAccepted, requireId } from "./approvals.js";
import {
  pickDirectory,
  pickAttachments,
  openExternalUrl,
  uploadAttachment,
} from "./native-dialogs.js";
import { processGroup } from "./process-metrics.js";
import { readGpuStatus } from "./gpu-info.js";
import { putWidgetState, readWidgetStates } from "./widget-states.js";
import { voice } from "./voice/manager.js";
import type { ApprovalView, MainServiceMap, MainServiceMethod } from "./types.js";
import { MAIN_SERVICE_METHODS } from "./types.js";
import type { BrowserPaneControl, PaneRect } from "./browser-host/engine.js";

const DEFAULT_LAN_PORT = 64413;
const RESTART_TIMEOUT_MS = 20_000;
const restartLock = { held: false };

/** createMainWindow 在 win32 上无条件设了透明底色 + mica 请求；不支持材质或
 *  调用失败时必须主动撤掉，否则 DWM 不画 backdrop，窗口会整块透出桌面
 *  （只依赖渲染层 CSS 回退盖不住首帧与未绘制区域）。 */
function restoreOpaqueWindow(win: BrowserWindow, dark: boolean): void {
  try {
    win.setBackgroundMaterial("none");
    win.setBackgroundColor(dark ? "#18181b" : "#f7f7f8");
  } catch (error) {
    console.warn("[ipc] failed to restore opaque window background:", error);
  }
}

/**
 * Win11 22H2+ 原生 Mica(DWMWA_SYSTEMBACKDROP_TYPE,Electron 的
 * `backgroundMaterial: "mica"` / `setBackgroundMaterial("mica")`)。
 * 返回是否真的启用:非 win32、系统版本低于 22H2(build 22621,systembackdrop
 * 从它开始可用)或调用失败都返回 false,渲染层据此撤掉 has-mica 透明层。
 * 深浅变体不在此显式选择——`"mica"` 跟随窗口暗色属性,由 nativeTheme.themeSource
 * 决定:应用内强制主题时同步它,跟随系统时保持 "system"(否则锁死系统跟随)。
 * Mica 是 DWM 侧的壁纸采样材质,由系统合成器绘制,不占应用 GPU 额度。
 */
function applyNativeMica(dark: boolean, followSystem: boolean): boolean {
  if (process.platform !== "win32") return false;
  const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed?.()) ?? null;
  if (win == null) return false;
  const build = Number(osRelease().split(".")[2] ?? 0);
  if (!(build >= 22621)) {
    restoreOpaqueWindow(win, dark);
    return false;
  }
  nativeTheme.themeSource = followSystem ? "system" : dark ? "dark" : "light";
  try {
    win.setBackgroundMaterial("mica");
    return true;
  } catch (error) {
    console.warn("[ipc] setBackgroundMaterial failed:", error);
    restoreOpaqueWindow(win, dark);
    return false;
  }
}

const RINGING_COMMAND_TYPES: ReadonlySet<RingingCommand["type"]> = new Set([
  "session.create", "session.settings.patch", "session.resume", "session.attach", "session.close",
  "session.rename", "session.archive", "session.unarchive", "session.delete", "session.shutdown",
  "agent.reload_config", "conversation.send_message", "conversation.cancel", "conversation.truncate", "interaction.ask.respond",
  "goal.set", "goal.get", "goal.clear",
  "interaction.ask.dismiss", "driver.claim", "driver.release", "tool.permission.respond",
  "provider.list", "provider.presets.list", "provider.upsert", "provider.delete",
  "provider.model.upsert", "provider.model.delete",
  "model.selection.set_default", "config.save", "config.set_permission_level", "workspace.set",
  "workspace.create", "workspace.rename", "workspace.delete", "workspace.move_session", "workspace.detach",
  "subagent.spawn", "todo.set", "todo.cancel", "plan.action", "diagnostics.memory.start", "diagnostics.memory.stop",
  "exec_session.interrupt", "exec_session.terminate",
]);

const SESSION_SERVICE_METHODS = new Set<MainServiceMethod>([
  "session.meta", "session.get_activity", "workspace.get", "todo.status", "todo.list", "plan.read",
]);
const approvedAttachmentPaths = new Set<string>();
const contentReadControllers = new Map<string, AbortController>();

// 方法闸门真源：native addon 的 serviceMethods()（qaqh-client 封闭查询枚举 +
// 账号面白名单）。addon 加载失败时回退到 types.ts 的手写方法表——两者在
// packaging 测试中做双向一致校验，漂移会先红。
let allowedServiceMethods: ReadonlySet<string> | null = null;
function serviceMethodAllowlist(): ReadonlySet<string> {
  if (allowedServiceMethods == null) {
    try {
      allowedServiceMethods = new Set(loadNativeAddon().serviceMethods());
    } catch {
      allowedServiceMethods = new Set<string>(MAIN_SERVICE_METHODS);
    }
  }
  return allowedServiceMethods;
}

function isServiceMethod(method: string): method is MainServiceMethod {
  return serviceMethodAllowlist().has(method);
}

function isRingingCommand(value: unknown): value is RingingCommand {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string"
    && RINGING_COMMAND_TYPES.has((value as { type: RingingCommand["type"] }).type);
}

/** Rebuild renderer messages with trusted-only identity fields fixed by the host. */
function normalizeRendererCommand(command: RingingCommand): RingingCommand {
  if (command.type !== "conversation.send_message") return command;
  const input = command as RingingCommand & Record<string, unknown>;
  if (typeof input.text !== "string") throw new Error("invalid_conversation_message");
  const purposes = new Set(["trigger_turn", "queue_only", "steer", "interject"]);
  if (typeof input.input_purpose !== "string" || !purposes.has(input.input_purpose)) {
    throw new Error("invalid_input_purpose");
  }
  const attachments = input.attachments;
  if (attachments != null && (!Array.isArray(attachments)
    || attachments.some((ref) => typeof ref !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(ref)))) {
    throw new Error("invalid_attachment_ref");
  }
  const images = input.images;
  if (images != null && (!Array.isArray(images) || images.some((image) => image == null || typeof image !== "object"
    || typeof (image as Record<string, unknown>).mime_type !== "string"
    || typeof (image as Record<string, unknown>).data !== "string"))) {
    throw new Error("invalid_image_block");
  }
  const safeMessage: ConversationSendMessage = {
    text: input.text,
    input_purpose: input.input_purpose as ConversationSendMessage["input_purpose"],
    as_system: false,
    ...(attachments == null ? {} : { attachments: attachments as string[] }),
    ...(typeof input.message_id === "string" ? { message_id: input.message_id } : {}),
    ...(images == null ? {} : { images: images as ConversationSendMessage["images"] }),
  };
  return { type: "conversation.send_message", ...safeMessage };
}

function readCommandTarget(value: unknown): CommandTarget {
  if (value == null) return globalCommandTarget();
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_command_target");
  const target = value as Record<string, unknown>;
  if (target.kind === "global") return { kind: "global" };
  if (target.kind === "session") return { kind: "session", session_id: requireId(target.session_id, "session_id") };
  if (target.kind === "workspace") return { kind: "workspace", workspace_id: requireId(target.workspace_id, "workspace_id") };
  if (target.kind === "exec_session") return { kind: "exec_session", id: requireId(target.id, "exec_session_id") };
  throw new Error("invalid_command_target");
}

function readPreconditions(value: unknown): CommandPrecondition[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("invalid_command_preconditions");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_command_precondition");
    const precondition = entry as Record<string, unknown>;
    if (precondition.kind !== "settings_revision" && precondition.kind !== "config_revision") throw new Error("invalid_command_precondition");
    if (!Number.isSafeInteger(precondition.revision) || Number(precondition.revision) < 0 || seen.has(String(precondition.kind))) {
      throw new Error("invalid_command_precondition");
    }
    seen.add(String(precondition.kind));
    return { kind: precondition.kind, revision: Number(precondition.revision) } as CommandPrecondition;
  });
}

export function registerQuitIpcHandler(getClient: () => RingingClient | null): void {
  ipcMain.handle("qaqh:request-quit", async (event, args: { stopDaemon?: boolean; stopActiveWork?: boolean } = {}) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrustedRenderer(event.senderFrame?.url ?? "")) {
      throw new Error("IPC sender is not the application renderer");
    }
    if (args.stopDaemon) {
      const client = getClient();
      if (!client) throw new Error("尚未连接 daemon，无法安全停止");
      const status = await client.stopDaemon(args.stopActiveWork === true ? false : true);
      if (status === "busy") throw new Error("后台任务状态刚刚变化；为保护任务，daemon 未停止");
      if (status === "unsupported") throw new Error("当前 daemon 不支持安全停止");
    }
    app.quit();
  });
}

function lanView(discovery: Awaited<ReturnType<typeof readDiscovery>>) {
  return discovery ? {
    running: true,
    active: discovery.lan_endpoint != null,
    endpoint: discovery.endpoint,
    lan_endpoint: discovery.lan_endpoint,
    tls_fingerprint: discovery.tls_fingerprint,
    pid: discovery.pid,
    daemon_version: discovery.daemon_version,
    build_id: discovery.build_id,
    protocol_version: discovery.protocol_version,
    app_protocol_version: discovery.protocol_version,
  } : {
    running: false, active: false, endpoint: null, lan_endpoint: null,
    tls_fingerprint: null, pid: null, daemon_version: null, build_id: null,
    protocol_version: null, app_protocol_version: null,
  };
}

async function waitForDaemon(previousPid: number | null, wantLan: boolean, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovery = await readDiscovery();
    if (discovery && discovery.pid !== previousPid && isAlive(discovery.pid)
      && (discovery.lan_endpoint != null) === wantLan) return discovery;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${wantLan ? "LAN" : "loopback"} daemon discovery`);
}

async function restartDaemon(
  client: RingingClient,
  daemonMgr: DaemonManager,
  options: { args: string[]; token?: string; wantLan: boolean; force: boolean },
) {
  if (restartLock.held) throw new Error("daemon 正在重启，请稍后重试");
  restartLock.held = true;
  try {
  const old = await readDiscovery();
  const oldPid = old?.pid ?? null;
  const activeSeed = client.getActiveSeed();
  if (old && isAlive(old.pid)) {
  const adminCredential = old ? { endpoint: old.endpoint, token: old.token } : null;
  const stopped = adminCredential
    ? await client.stopDaemon(!options.force)
    : "stopping";
  if (stopped === "busy") throw new Error("daemon_busy");
  if (stopped === "unsupported") throw new Error("当前 daemon 不支持安全重启");
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    while (isAlive(old.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
    if (isAlive(old.pid)) throw new Error(`旧 daemon（pid ${old.pid}）未能安全退出，已放弃重启`);
  }
  client.detachActive();
  const executable = resolveDaemonExecutable();
  if (!executable) throw new Error("Could not find qaqh-daemon executable.");
  const daemonArgs = options.args;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: process.env.RUST_LOG || "info" };
  delete childEnv.QAQH_ADMIN_TOKEN;
  if (options.token) childEnv.QAQH_SERVER_TOKEN = options.token;
  else delete childEnv.QAQH_SERVER_TOKEN;
  const child = spawn(executable, daemonArgs, { detached: true, stdio: "ignore", env: childEnv });
  child.unref();
  if (child.pid == null) throw new Error("Failed to spawn qaqh-daemon");
  daemonMgr.noteSpawned(child.pid);
  const discovery = await waitForDaemon(oldPid, options.wantLan);
  if (!isAlive(discovery.pid)) throw new Error("New daemon exited before publishing a usable discovery document");
  await client.reconnectWithCredentials(discovery);
  if (activeSeed) await client.attach(activeSeed).catch(error => console.warn("[ringing] attach after daemon restart failed:", error));
  return lanView(discovery);
  } finally {
    restartLock.held = false;
  }
}

function sessionIsBusy(status: string): boolean {
  return [
    "working",
    "waiting_permission",
    "waiting_ask",
    "waiting_plan",
    "waitingpermission",
    "waitingask",
    "waitingplan",
  ].includes(String(status).toLowerCase());
}

export async function reconnectAndRestoreSession(client: RingingClient, discovery: Awaited<ReturnType<DaemonManager["ensureDaemonRunning"]>>, activeSeed: string | null): Promise<void> {
  await client.reconnectWithCredentials(discovery);
  if (activeSeed) await client.attach(activeSeed).catch(error => console.warn("[ringing] attach after stale daemon recovery failed:", error));
}

export function registerIpcHandlers(
  clientOrConnect: RingingClient | (() => Promise<RingingClient>),
  daemonMgr: DaemonManager,
  challenges: ChallengeManager,
  browser: BrowserPaneControl | null = null
): void {
  const getClient = () => typeof clientOrConnect === "function" ? clientOrConnect() : Promise.resolve(clientOrConnect);
  // Compatibility command name is intentionally closed to a fixed allowlist.
  ipcMain.handle("qaqh:invoke", async (event, cmd: string, args: Record<string, any> = {}) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("IPC sender is not the application renderer");
    return handleCommand(cmd, args, await getClient(), daemonMgr, challenges, browser);
  });
}

export function isTrustedRenderer(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "app:" && url.hostname === "localhost")
      || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "5173");
  } catch { return false; }
}

function isTrustedPicker(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "app:" && url.hostname === "localhost" && url.pathname === "/model-picker"
      && (url.search === "" || (url.searchParams.size === 1 && /^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get("session") ?? "")));
  } catch { return false; }
}

/**
 * pending_approvals 管线单一实现：admin approvals + bootstrap 快照交叉验证 +
 * challenge 签发/verify。渲染层 IPC case 与主进程 notifier 都走这里——通知按钮
 * 不存在第二条免验证快车道。
 */
export async function collectPendingApprovals(
  client: RingingClient,
  challenges: ChallengeManager,
  rawSeed: unknown,
): Promise<ApprovalView[]> {
  const seed = requireId(rawSeed, "session_id");
  try {
    const view = await client.approvals(seed);
    if (view.kind !== "admin") throw new Error("Electron host requires admin approvals, not device challenges");
    const bootstrap = await client.approvalsSnapshot(seed);
    const state = bootstrap.state;
    const pending = flattenAdminApprovals(view.pending);
    const activeInteractions = state.interactions.filter((item) => item.resolution == null);
    const kindFor = (kind: ApprovalView["kind"]) => kind === "tool_permission" ? "permission" : kind;
    const matchesSnapshot = pending.length === activeInteractions.length && pending.every((approval) => {
      const interaction = activeInteractions.find((item) => item.kind === kindFor(approval.kind)
        && (approval.kind === "tool_permission" ? item.call_id === approval.internalId : item.interaction_id === approval.internalId));
      if (!interaction) return false;
      approval.snapshotId = interaction.interaction_id;
      return true;
    });
    const views = challenges.issueViews(seed, pending);
    if (!matchesSnapshot) {
      for (const approval of views) challenges.markChallengeUnverified(seed, approval.challenge_id);
    }
    return views.map((approval, index) => {
      const source = pending[index];
      const matches = source != null && activeInteractions.some((item) => item.kind === kindFor(source.kind)
        && item.interaction_id === source.snapshotId
        && (source.kind !== "tool_permission" || item.call_id === source.internalId));
      if (matches && matchesSnapshot) {
        challenges.confirmChallenge(seed, approval.challenge_id);
        approval.verified = true;
      } else {
        challenges.markChallengeUnverified(seed, approval.challenge_id);
        approval.verified = false;
      }
      return { ...approval, verified: matches && matchesSnapshot };
    });
  } catch (error) {
    console.warn(`[approvals] Failed to read pending interactions for ${seed}:`, error);
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send("qaqh:event:conn://error", { message: `Pending interactions unavailable for ${seed}: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
    throw error;
  }
}

/**
 * respond_approval 管线单一实现：challenge 一次性消费、approve/trust/submit 的
 * verified/details 闸门、unknown outcome 只轮询原 command id。decision/payload
 * 词表与渲染层完全一致（approvals.ts 的封闭词表），通知按钮不新增词表。
 */
export async function submitApprovalDecision(
  client: RingingClient,
  challenges: ChallengeManager,
  seed: string,
  challengeId: string,
  decision: string,
  payload: unknown = {},
): Promise<null> {
  const stored = challenges.consume(seed, challengeId);
  if (!stored) {
    throw new Error(`Invalid or expired challenge: ${challengeId}`);
  }

  if (stored.detailsUnavailable && (decision === "approve" || decision === "trust" || decision === "submit")) {
    challenges.markChallengeUnverified(seed, challengeId);
    throw new Error("approval_details_unavailable");
  }

  const approvalDecision = decision === "approve" || decision === "trust" || decision === "submit";
  if (approvalDecision && !stored.verified) {
    challenges.markChallengeUnverified(seed, challengeId);
    throw new Error("approval_state_unverified");
  }

  const command = approvalCommand(stored, decision, payload);
  try {
    requireAccepted(await client.command(command, sessionCommandTarget(stored.sessionId)));
  } catch (error) {
    const commandId = error != null && typeof error === "object" && "commandId" in error
      ? String((error as { commandId?: unknown }).commandId ?? "") : "";
    if (!commandId) throw error;
    // Never manufacture a second approval command after an unknown outcome.
    // Poll only the exact id attached to the original submission.
    const deadline = Date.now() + 30_000;
    let lastError: unknown = error;
    while (Date.now() < deadline) {
      let status: Awaited<ReturnType<RingingClient["commandStatus"]>> | null = null;
      try {
        status = await client.commandStatus(commandId);
      } catch (pollError) {
        lastError = pollError;
      }
      if (status?.state === "succeeded") return null;
      if (status?.state === "rejected" || status?.state === "failed") {
        throw new Error(`approval_command_${status.state}:${status.error_code ?? "unknown"}`);
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error(`approval_command_outcome_unknown:${commandId}:${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  return null;
}

async function handleCommand(
  cmd: string,
  args: Record<string, any>,
  client: RingingClient,
  daemonMgr: DaemonManager,
  challenges: ChallengeManager,
  browser: BrowserPaneControl | null
): Promise<any> {
  switch (cmd) {
    case "session_list": {
      const list = await client.serviceCall("session.list", {});
      return list.map((entry) => {
        const status = entry.status;
        return {
          session_id: entry.session_id,
          title: entry.title ?? null,
          cwd: entry.cwd ?? null,
          updated_at: entry.updated_at,
          created_at: entry.created_at,
          turn_count: entry.turn_count,
          status,
          busy: sessionIsBusy(status),
          archived: entry.archived,
          workspace_id: entry.workspace_id,
          tool_mode: entry.tool_mode ?? null,
          handoff_from_session_id: entry.handoff_from_session_id ?? null,
        };
      });
    }

    case "attach": {
      const seed = String(args.seed || "");
      const limit = args.limit != null ? Number(args.limit) : null;
      await client.attach(seed, limit);
      return null;
    }

    case "pending_approvals": {
      const seed = requireId(args.seed, "session_id");
      return collectPendingApprovals(client, challenges, seed);
    }

    case "team_snapshot": {
      const seed = requireId(args.seed, "session_id");
      return client.teamSnapshot(seed);
    }

    case "invalidate_approvals": {
      const seed = requireId(args.seed, "session_id");
      if (typeof args.challengeId === "string" && args.verified === true) challenges.confirmChallenge(seed, args.challengeId);
      else if (typeof args.challengeId === "string" && args.verified === "revoke") challenges.invalidateChallenge(seed, args.challengeId);
      else if (typeof args.challengeId === "string") challenges.markChallengeUnverified(seed, args.challengeId);
      return null;
    }

    case "respond_approval": {
      const seed = requireId(args.seed, "session_id");
      const challengeId = String(args.challengeId || "");
      const decision = String(args.decision || "");
      const payload = args.payload ?? {};
      return submitApprovalDecision(client, challenges, seed, challengeId, decision, payload);
    }

    case "command": {
      if (!isRingingCommand(args.command)) throw new Error("invalid_command");
      return client.command(normalizeRendererCommand(args.command), readCommandTarget(args.target), readPreconditions(args.preconditions));
    }

    case "service_query": {
      const method = typeof args.method === "string" ? args.method : "";
      if (!isServiceMethod(method)) throw new Error("unsupported_service_method");
      const params = args.params ?? {};
      if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("invalid_service_params");
      if (SESSION_SERVICE_METHODS.has(method)) requireId((params as Record<string, unknown>).session_id, "session_id");
      return client.serviceCall(method, params as MainServiceMap[MainServiceMethod]["params"]);
    }

    /* ── 工作区 git 状态(只读,插件 capability "git-status" 的唯一取数面)──────
       不传 path 就解析活动会话的工作区:main 持有 activeSeed,daemon 的
       workspace.get 给出 cwd。插件因此不需要知道会话/工作区注册表。 */
    case "git_status": {
      const explicit = typeof args.path === "string" && args.path !== "" ? args.path : null;
      if (explicit != null) return readGitStatus(explicit);
      const seed = client.getActiveSeed();
      if (seed == null) return { kind: "no-workspace" };
      const cwd = await client.serviceCall("workspace.get", { session_id: seed });
      if (typeof cwd !== "string" || cwd === "") return { kind: "no-workspace" };
      return readGitStatus(cwd);
    }

    case "exit_app": {
      if (args.stopDaemon === true) {
        const status = await client.stopDaemon(args.stopActiveWork === true ? false : true);
        if (status === "busy") throw new Error("后台任务状态刚刚变化；为保护任务，daemon 未停止");
        if (status === "unsupported") throw new Error("当前 daemon 不支持安全停止");
      }
      app.quit();
      return null;
    }

    case "app_version": {
      // `just` injects the pack-date version at bundle time. The source
      // package.json keeps a stable date base, and app.getVersion() is only a
      // fallback for an ad-hoc dev bundle built without just.
      const version = process.env.QAQH_BUILD_VERSION || app.getVersion();
      const commit = process.env.QAQH_GIT_COMMIT || "unknown";
      const shortCommit = commit === "unknown" ? "unknown" : commit.slice(0, 8);
      const display = `${version}+${shortCommit}${process.env.QAQH_GIT_DIRTY === "1" ? "-dirty" : ""}`;
      return { display, version, commit };
    }
    // widget-directive §3/§4：iframe widget 状态快照（userData 单文件 kv）。
    case "widget_state_get_all": {
      return await readWidgetStates();
    }
    case "widget_state_put": {
      return await putWidgetState(String(args.key ?? ""), String(args.value ?? ""));
    }

    case "host_memory": {
      const usage = process.memoryUsage();
      // Linux 的 procfs 自带进程全生命周期峰值(VmHWM,单位 kB),把一直缺测的
      // peak 补上;其他平台没有等价读数,保持 null 缺测,不冒充 0。
      let peak: number | null = null;
      let source = "node:process.memoryUsage.rss";
      if (process.platform === "linux") {
        try {
          const status = await readFile("/proc/self/status", "utf8");
          const hwmKb = Number(/^VmHWM:\s+(\d+)\s+kB$/m.exec(status)?.[1]);
          if (Number.isFinite(hwmKb) && hwmKb > 0) {
            peak = hwmKb * 1024;
            source = "node:process.memoryUsage.rss + linux:procfs VmHWM";
          }
        } catch {}
      }
      return { resident_bytes: usage.rss, private_bytes: null, virtual_bytes: null, peak_resident_bytes: peak, source, error: null };
    }

    case "host_process_group": {
      return processGroup(app.getAppMetrics(), process.pid);
    }

    case "host_gpu_info": {
      // GPU 后端探针:软渲染时 CSS 层面的省电优化收效有限,面板与 auto 性能档
      // 都需要这个事实(src/main/gpu-info.ts)。读不出就如实报错,不猜。
      try {
        return readGpuStatus(await app.getGPUInfo("complete"));
      } catch (cause) {
        return {
          compositing: null, softwareRendering: null, software: null, vendor: null, renderer: null,
          source: "electron.app.getGPUInfo", error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }

    case "pairing_create": {
      const discovery = await readDiscovery();
      if (!discovery?.lan_endpoint) throw new Error("daemon 当前未开启局域网模式；请先开启 LAN 模式");
      const scopeGrant = String(args.scopeGrant ?? "interact");
      if (!["view", "interact", "admin"].includes(scopeGrant)) throw new Error("invalid pairing scope");
      const deviceName = String(args.deviceName ?? "").trim().slice(0, 80);
      if (!deviceName) throw new Error("device name is required");
      const platform = String(args.platform ?? "mobile").slice(0, 40);
      const ticket = await client.issuePairToken({ scope_grant: scopeGrant, device_name: deviceName, platform });
      const payload = {
        v: 1, kind: "qaqh-pair", base_url: discovery.lan_endpoint.replace(/\/$/, ""),
        pairing_token: String(ticket.pairing_token),
        tls_fp: String(ticket.tls_fp || discovery.tls_fingerprint || ""),
        host_name: hostname() || "qaqh-desktop",
      };
      return { qr_payload: JSON.stringify(payload), expires_in_ms: Number(ticket.expires_in_ms), base_url: discovery.lan_endpoint };
    }

    case "devices_list": {
      const discovery = await readDiscovery();
      if (!discovery) throw new Error("daemon discovery unavailable");
      return client.listDevices();
    }

    case "device_revoke": {
      const deviceId = String(args.deviceId ?? "");
      if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new Error("invalid device_id");
      const discovery = await readDiscovery();
      if (!discovery) throw new Error("daemon discovery unavailable");
      await client.revokeDevice(deviceId);
      return null;
    }

    case "daemon_lan_status": {
      return lanView(await readDiscovery());
    }

    case "stop_stale_daemon": {
      const discovery = await readDiscovery();
      if (!discovery || !isAlive(discovery.pid)) return "stopping";
      const activeSeed = client.getActiveSeed();
      const status = await client.stopDaemon(true);
      if (status === "stopping") {
        const deadline = Date.now() + RESTART_TIMEOUT_MS;
        while (isAlive(discovery.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
        if (isAlive(discovery.pid)) throw new Error("daemon 未在安全停机期限内退出");
        const replacement = await daemonMgr.ensureDaemonRunning(45_000);
        await reconnectAndRestoreSession(client, replacement, activeSeed);
      }
      return status;
    }

    case "daemon_lan_enable": {
      const bindIp = typeof args.bindIp === "string" ? args.bindIp.trim() : "";
      if (bindIp && (!isIP(bindIp) || ["127.0.0.1", "::1"].includes(bindIp))) throw new Error("绑定地址必须是有效的非回环 IP");
      if (args.port != null && !Number.isInteger(Number(args.port))) throw new Error("LAN port must be an integer");
      const port = args.port == null ? DEFAULT_LAN_PORT : Number(args.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid LAN port");
      const token = randomBytes(32).toString("hex");
      return restartDaemon(client, daemonMgr, { args: ["server", "--bind", bindIp || "0.0.0.0", "--port", String(port)], token, wantLan: true, force: args.force === true });
    }

    case "daemon_lan_disable": {
      return restartDaemon(client, daemonMgr, { args: ["run"], wantLan: false, force: args.force === true });
    }

    case "voice_status": {
      return voice.status();
    }

    case "voice_prepare": {
      // 进度经 voice://status 事件推送;此处只点火。
      void voice.prepare().catch((error: unknown) => console.warn("[voice] prepare failed:", error));
      return null;
    }

    case "voice_transcribe": {
      const wav = Buffer.from(String(args.wav), "base64");
      return voice.transcribe(wav, typeof args.language === "string" ? args.language : "auto");
    }

    case "voice_synthesize": {
      const wav = await voice.synthesize(String(args.text ?? ""));
      return wav.toString("base64");
    }


    case "session_bootstrap": {
      const seed = requireId(args.seed, "session_id");
      return client.bootstrap(seed);
    }

    case "content_read_text": {
      const contentRef = args.contentRef;
      if (typeof contentRef !== "string" || !/^sha256:[a-f0-9]{64}$/.test(contentRef)) {
        throw new Error("invalid content_ref");
      }
      const requestId = typeof args.requestId === "string" ? args.requestId : randomBytes(16).toString("hex");
      if (!/^[a-f0-9-]{32,36}$/i.test(requestId)) throw new Error("invalid content request id");
      const controller = new AbortController();
      contentReadControllers.set(requestId, controller);
      try { return await client.readContentText(contentRef, controller.signal); }
      finally { contentReadControllers.delete(requestId); }
    }

    case "content_read_cancel": {
      const requestId = typeof args.requestId === "string" ? args.requestId : "";
      contentReadControllers.get(requestId)?.abort();
      return null;
    }

    case "streams_retry": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      if (seed) {
        await client.retryActive(seed);
      }
      return null;
    }

    case "pick_directory": {
      return pickDirectory();
    }

    /* 强制刷新壳页面:重跑渲染进程加载 → did-finish-load 会再次触发插件图强制重发,
       等价于"重启壳"的轻量版(会话在 daemon 侧,无感)。 */
    case "force_refresh": {
      const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      win?.webContents.reloadIgnoringCache();
      return win != null;
    }

    /* ── 前端插件管理(工具页「前端插件」)──────────────────────────────
       全量管理视图走 IPC(含禁用条目),graph 只发启用面;导入=选 zip/文件夹,
       落用户根 ~/.qaqh/frontend-plugin,启停删除即时推 graph,无需重启。 */
    case "frontend_plugins:list": {
      return listManagedPlugins(pluginsRoot());
    }

    case "frontend_plugins:set_enabled": {
      setPluginEnabled(pluginsRoot(), String(args?.id), args?.enabled === true);
      notifyPluginsChanged();
      return listManagedPlugins(pluginsRoot());
    }

    case "frontend_plugins:remove": {
      removePlugin(String(args?.id));
      notifyPluginsChanged();
      return listManagedPlugins(pluginsRoot());
    }

    case "frontend_plugins:import": {
      const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      const pick = await dialog.showOpenDialog(win!, {
        title: "选择插件文件夹或 .zip 包",
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "插件包 (zip)", extensions: ["zip"] }],
      });
      if (pick.canceled || pick.filePaths.length === 0) return null;
      const entry = importPlugin(pick.filePaths[0]);
      notifyPluginsChanged();
      return entry;
    }

    case "frontend_plugins:reveal": {
      const found = listManagedPlugins(pluginsRoot()).find((plugin) => plugin.id === String(args?.id));
      if (found != null) shell.showItemInFolder(join(found.path, "plugin.json"));
      return found != null;
    }

    case "pick_attachments": {
      const paths = await pickAttachments();
      for (const path of paths) approvedAttachmentPaths.add(path);
      return paths;
    }

    case "capture_screenshot": {
      throw new Error("应用内截图暂不可用；请使用系统截图工具后通过‘添加附件’上传");
    }

    case "upload_attachment": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const filePath = String(args.path || "");
      if (!approvedAttachmentPaths.delete(filePath)) throw new Error("附件必须通过 Electron 文件选择器选取后才能上传");
      return uploadAttachment(client, seed, filePath);
    }

    case "open_external": {
      const url = String(args.url || "");
      await openExternalUrl(url);
      return null;
    }

    case "set_window_theme": {
      // Win11 22H2+ 原生 Mica(DWM systembackdrop)。返回是否真的启用:
      // Win10 / 22H2 以下 / 调用失败返回 false,渲染层撤掉 has-mica 透明层,
      // CSS 退回实底(theme.ts 的既有回退路径)。
      const dark = args?.dark === true;
      const followSystem = args?.followSystem === true;
      return applyNativeMica(dark, followSystem);
    }

    // ── 浏览器面板（docs/browser-control-design.md）：renderer 只驱动可见性
    //    与视口；agent 的页面操作走 MCP 工具面，两侧不交叉。 ──
    case "browser_view_show": {
      if (browser == null) throw new Error("浏览器控制本次启动不可用");
      browser.showPane(rectArg(args?.rect));
      return browser.state();
    }

    case "browser_view_hide": {
      if (browser == null) throw new Error("浏览器控制本次启动不可用");
      browser.hidePane();
      return browser.state();
    }

    case "browser_view_viewport": {
      if (browser == null) throw new Error("浏览器控制本次启动不可用");
      const rect = rectArg(args?.rect);
      if (rect == null) throw new Error("browser_view_viewport 需要 rect");
      browser.setViewport(rect);
      return browser.state();
    }

    case "browser_view_navigate": {
      if (browser == null) throw new Error("浏览器控制本次启动不可用");
      const url = String(args?.url ?? "");
      if (!url) throw new Error("browser_view_navigate 需要 url");
      return browser.navigate(url);
    }

    case "browser_view_state": {
      return browser?.state() ?? { visible: false, url: "", title: "", unavailable: true };
    }

    default:
      console.warn(`[ipc] Unhandled command: ${cmd}`, args);
      throw new Error(`Command ${cmd} not implemented in Electron shell`);
  }
}

/** 视口矩形入参校验：非有限正数一律拒绝（渲染层测量错值不该悄悄落位）。 */
function rectArg(raw: unknown): PaneRect | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const rect = raw as Record<string, unknown>;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
    throw new Error("browser_view rect 需要有限的 x/y/width/height 且宽高为正");
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
