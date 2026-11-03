import { app, BrowserWindow, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readDiscovery, DaemonManager } from "./daemon.js";
import { globalTarget } from "@qaqh/sdk";
import { isAlive } from "@qaqh/sdk/node";
import type { RingingCommand, UnifiedCommand, UnifiedTarget } from "@qaqh/sdk/protocol";
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
import { scanUserSkills } from "./skills-scanner.js";
import { processGroup } from "./process-metrics.js";
import { readGpuStatus } from "./gpu-info.js";
import {
  applyForDaemon, checkForUpdates, spawnApplyOnQuit, stageUpdate, stagedStatus,
} from "./updater.js";

const DEFAULT_LAN_PORT = 64413;
const RESTART_TIMEOUT_MS = 20_000;
const restartLock = { held: false };

/** 统一目录操作（§8.1）走统一信封；其余 command IPC 一律转 service 面。 */
const UNIFIED_COMMAND_TYPES = new Set([
  "session.create",
  "session.settings.patch",
  "provider.list",
  "provider.upsert",
  "provider.delete",
  "provider.model.upsert",
  "provider.model.delete",
  "provider.models.discover",
  "model.selection.set_default",
]);

/** webui 旧名 → conversation 频道 wire 名（ConversationCommand snake_case）。 */
const CONVERSATION_WIRE_TYPES: Record<string, string> = {
  "conversation.send": "conversation_send_message",
  "conversation.cancel": "conversation_cancel",
  "conversation.compact": "conversation_compact",
};
const approvedAttachmentPaths = new Set<string>();
const contentReadControllers = new Map<string, AbortController>();

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
  challenges: ChallengeManager
): void {
  const getClient = () => typeof clientOrConnect === "function" ? clientOrConnect() : Promise.resolve(clientOrConnect);
  // Compatibility command name is intentionally closed to a fixed allowlist.
  ipcMain.handle("qaqh:invoke", async (event, cmd: string, args: Record<string, any> = {}) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("IPC sender is not the application renderer");
    return handleCommand(cmd, args, await getClient(), daemonMgr, challenges);
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

async function handleCommand(
  cmd: string,
  args: Record<string, any>,
  client: RingingClient,
  daemonMgr: DaemonManager,
  challenges: ChallengeManager
): Promise<any> {
  switch (cmd) {
    case "session_list": {
      const raw = await client.serviceCall<any[]>("session.list");
      const list = Array.isArray(raw) ? raw : [];
      return list.map((entry: any) => {
        const meta = entry.meta || {};
        const sessionId = entry.session_id || meta.session_id || "";
        const title = entry.title !== undefined ? entry.title : (meta.title !== undefined ? meta.title : null);
        const cwd = entry.cwd !== undefined ? entry.cwd : (meta.cwd !== undefined ? meta.cwd : null);
        const updatedAt = entry.updated_at || meta.updated_at || Date.now();
        const turnCount = entry.turn_count || meta.turn_count || 0;
        const status = entry.status || "idle";
        const archived = Boolean(entry.archived !== undefined ? entry.archived : meta.archived);
        const workspaceId = entry.workspace_id !== undefined ? entry.workspace_id : (meta.workspace_id || null);
        const toolMode = entry.tool_mode !== undefined ? entry.tool_mode : (meta.tool_mode || null);

        return {
          session_id: sessionId,
          title,
          cwd,
          updated_at: updatedAt,
          turn_count: turnCount,
          status,
          busy: sessionIsBusy(status),
          archived,
          workspace_id: workspaceId,
          tool_mode: toolMode,
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
      try {
        const view = await client.approvals(seed);
        if (view.kind !== "admin") throw new Error("Electron host requires admin approvals, not device challenges");
        const bootstrap = await client.approvalsSnapshot(seed);
        const controlState = (bootstrap as any)?.control?.state;
        const controlRevision = Number(controlState?.revision);
        const pending = flattenAdminApprovals(view.pending);
        const pendingInteractions = Array.isArray(controlState?.interactions) ? controlState.interactions : [];
        const activeInteractions = pendingInteractions.filter((item: any) => item?.resolution == null && item?.expired_reason == null);
        for (const approval of pending) {
          if (approval.kind !== "tool_permission") continue;
          const interaction = activeInteractions.find((item: any) => item?.kind === "permission" && item?.call_id === approval.internalId);
          if (typeof interaction?.interaction_id === "string") approval.snapshotId = interaction.interaction_id;
        }
        const matchesSnapshot = pending.length === activeInteractions.length && pending.every((approval) => {
          const kind = approval.kind === "tool_permission" ? "permission" : approval.kind === "plan" ? "plan_review" : "ask";
          return activeInteractions.some((item: any) => item?.kind === kind
            && item.interaction_id === approval.snapshotId);
        });
        const views = challenges.issueViews(seed, pending);
        if (!matchesSnapshot || !Number.isFinite(controlRevision)) {
          for (const approval of views) challenges.markChallengeUnverified(seed, approval.challenge_id);
        }
        return views.map((approval, index) => {
          const source = pending[index];
          const matches = source != null && pendingInteractions.some((item: any) => item?.resolution == null && item?.expired_reason == null
            && item?.kind === (source.kind === "tool_permission" ? "permission" : source.kind === "plan" ? "plan_review" : "ask")
            && item?.interaction_id === source.snapshotId);
          if (matches && matchesSnapshot && Number.isFinite(controlRevision)) {
            challenges.confirmChallenge(seed, approval.challenge_id);
            approval.verified = true;
          } else {
            challenges.markChallengeUnverified(seed, approval.challenge_id);
            approval.verified = false;
          }
          return { ...approval, verified: matches && matchesSnapshot && Number.isFinite(controlRevision) };
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
        requireAccepted(await client.submitChannel(command, stored.sessionId));
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

    case "command": {
      const command = args.command;
      if (command == null || typeof command !== "object" || Array.isArray(command)
        || typeof (command as { type?: unknown }).type !== "string") {
        throw new Error("invalid_command");
      }
      const { type, ...params } = command as { type: string } & Record<string, unknown>;
      if (UNIFIED_COMMAND_TYPES.has(type)) {
        return client.command(command as UnifiedCommand, (args.target ?? globalTarget()) as UnifiedTarget);
      }
      // 会话输入命令走 conversation 频道（必须携带 session target）。
      const conversationType = CONVERSATION_WIRE_TYPES[type];
      if (conversationType) {
        const target = (args.target ?? globalTarget()) as UnifiedTarget;
        if (target.kind !== "session") throw new Error("session_target_required");
        return client.submitChannel({ channel: "conversation", type: conversationType, ...params } as RingingCommand, target.session_id);
      }
      // 旧 set_group 语义 = workspace 归属：显式 workspace_id → move，null → detach。
      if (type === "session.set_group") {
        const target = (args.target ?? globalTarget()) as UnifiedTarget;
        const sessionId = target.kind === "session" ? target.session_id : String(params.session_id ?? "");
        if (!sessionId) throw new Error("session_target_required");
        const workspaceId = params.workspace_id;
        if (workspaceId == null || workspaceId === "") {
          return client.serviceCall("workspace.detach", { session_id: sessionId });
        }
        return client.serviceCall("workspace.move_session", { session_id: sessionId, workspace_id: workspaceId });
      }
      // 其余都是 service 查询/配置面方法（config.load、workspace.*、siwc.*…）：
      // 回包包成 accepted ack 形状，渲染层 query() 继续从 result 取值。
      const result = await client.serviceCall(type, params);
      return { status: "accepted" as const, result };
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

    case "updater_check": {
      return checkForUpdates(typeof args.source === "string" && args.source ? args.source : undefined);
    }

    case "updater_stage": {
      return stageUpdate(typeof args.source === "string" && args.source ? args.source : undefined);
    }

    case "updater_status": {
      return stagedStatus();
    }

    case "updater_apply": {
      const staged = stagedStatus();
      if (!staged) throw new Error("没有已暂存的更新(先执行 updater_stage)");
      if (staged.restartPolicy === "daemon") {
        // 纯 backend:停 daemon → 同步应用(只换 backend/)→ 走既有重连链路,壳不重启。
        const stopped = await client.stopDaemon(true);
        if (stopped === "busy") throw new Error("daemon_busy");
        if (stopped === "unsupported") throw new Error("当前 daemon 不支持安全停止");
        await applyForDaemon();
        return restartDaemon(client, daemonMgr, { args: ["run"], wantLan: false, force: true });
      }
      // electron 策略:挂 detached updater 等 shell 退出,renderer 随后走 request-quit。
      spawnApplyOnQuit();
      return { policy: "electron", quit: true };
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
      const adminToken = discovery.token;
      const scopeGrant = String(args.scopeGrant ?? "interact");
      if (!["view", "interact", "admin"].includes(scopeGrant)) throw new Error("invalid pairing scope");
      const deviceName = String(args.deviceName ?? "").trim().slice(0, 80);
      if (!deviceName) throw new Error("device name is required");
      const platform = String(args.platform ?? "mobile").slice(0, 40);
      const ticket = await client.adminRequest<{ pairing_token: string; expires_in_ms: number; tls_fp?: string }>(
        { endpoint: discovery.endpoint, token: adminToken },
        "/ringing/v2/pairing/tokens",
        { method: "POST", body: JSON.stringify({ scope_grant: scopeGrant, device_name: deviceName, platform }) },
      );
      const payload = {
        v: 1, kind: "qaqh-pair", base_url: discovery.lan_endpoint.replace(/\/$/, ""),
        pairing_token: ticket.pairing_token,
        tls_fp: ticket.tls_fp || discovery.tls_fingerprint || "",
        host_name: hostname() || "qaqh-desktop",
      };
      return { qr_payload: JSON.stringify(payload), expires_in_ms: ticket.expires_in_ms, base_url: discovery.lan_endpoint };
    }

    case "devices_list": {
      const discovery = await readDiscovery();
      if (!discovery) throw new Error("daemon discovery unavailable");
      return client.adminRequest({ endpoint: discovery.endpoint, token: discovery.token }, "/ringing/v2/devices", { method: "GET" });
    }

    case "device_revoke": {
      const deviceId = String(args.deviceId ?? "");
      if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new Error("invalid device_id");
      const discovery = await readDiscovery();
      if (!discovery) throw new Error("daemon discovery unavailable");
      await client.adminRequest({ endpoint: discovery.endpoint, token: discovery.token }, `/ringing/v2/devices/${deviceId}/revoke`, { method: "POST" });
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

    case "skills_user_scan": {
      return scanUserSkills();
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
      // Electron currently uses the CSS theme surface, with no native material effect.
      return false;
    }

    default:
      console.warn(`[ipc] Unhandled command: ${cmd}`, args);
      throw new Error(`Command ${cmd} not implemented in Electron shell`);
  }
}
