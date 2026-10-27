import { app, BrowserWindow, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { readDiscovery, DaemonManager } from "./daemon.js";
import { isAlive } from "@qaqh/sdk/node";
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
import { applyConfiguredDefault, clearDefaultModelSelection, loadProviderChoices, normalizeSessionSelection, readDefaultModelSelection, type SessionModelSelection } from "./model-selection.js";
import { isModelPickerWindow, openModelPicker } from "./model-picker.js";
import { processGroup } from "./process-metrics.js";

const SERVICE_METHODS = new Set([
  "daemon.version", "session.list", "session.meta", "session.activity", "session.rename", "session.dashboard", "session.get_activity",
  "workspace.get", "workspace.list", "workspace.create", "workspace.move_session", "workspace.detach",
  "fs.list", "fs.read", "todo.list", "todo.status", "plan.read",
  "git.diff", "git.branch", "git.branches", "git.file_diff",
  "config.load", "config.save", "profile.apply", "profile.save_current", "profile.delete",
  "session.set_profile",
  "diagnostics.memory.start", "diagnostics.memory.stop", "diagnostics.memory.snapshot",
  "siwc.status", "siwc.profiles", "siwc.models", "siwc.sign_in.start", "siwc.sign_in.status", "siwc.sign_in.cancel", "siwc.profile.select", "siwc.sign_out",
  "dsaccount.status", "dsaccount.balance", "dsaccount.bonuses", "dsaccount.sign_in.start", "dsaccount.sign_in.status", "dsaccount.sign_in.cancel", "dsaccount.sign_out", "dsaccount.bonus.ack", "dsaccount.models", "dsaccount.verify",
]);
const SESSION_EXEMPT_METHODS = new Set([
  "daemon.version", "session.list", "session.activity",
  "fs.list", "fs.read",
  "workspace.list", "workspace.create", "workspace.move_session", "workspace.detach",
  "config.load", "config.save", "profile.apply", "profile.save_current", "profile.delete",
  "diagnostics.memory.start", "diagnostics.memory.stop", "diagnostics.memory.snapshot",
  "siwc.status", "siwc.profiles", "siwc.models", "siwc.sign_in.start", "siwc.sign_in.status",
  "siwc.sign_in.cancel", "siwc.profile.select", "siwc.sign_out",
  "dsaccount.status", "dsaccount.balance", "dsaccount.bonuses", "dsaccount.sign_in.start",
  "dsaccount.sign_in.status", "dsaccount.sign_in.cancel", "dsaccount.sign_out",
  "dsaccount.bonus.ack", "dsaccount.models", "dsaccount.verify",
]);

const DEFAULT_LAN_PORT = 64413;
const RESTART_TIMEOUT_MS = 20_000;
const restartLock = { held: false };
const approvedAttachmentPaths = new Set<string>();

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
    protocol_version: discovery.protocol_version,
    app_protocol_version: discovery.protocol_version,
  } : {
    running: false, active: false, endpoint: null, lan_endpoint: null,
    tls_fingerprint: null, pid: null, daemon_version: null,
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
    if (isModelPickerWindow(event.sender.id) || event.senderFrame !== event.sender.mainFrame || !isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("IPC sender is not the application renderer");
    return handleCommand(cmd, args, await getClient(), daemonMgr, challenges);
  });

  // Native Electron picker: keeps provider/model selection in the host UI
  // until the dedicated qaqh-desktop renderer is brought into this repo.
  ipcMain.handle("model-picker:load", async (event, args: { sessionId?: string | null } = {}) => {
    if (!isModelPickerWindow(event.sender.id) || event.senderFrame !== event.sender.mainFrame || !isTrustedPicker(event.senderFrame?.url ?? "")) throw new Error("model picker IPC is restricted to the native picker window");
    const client = await getClient();
    const [choices, fallback] = await Promise.all([
      loadProviderChoices(client),
      readDefaultModelSelection(app.getPath("userData")),
    ]);
    let selection = fallback;
    if (args.sessionId) {
      const meta = await client.serviceRpc<any>("session.meta", { session_id: args.sessionId });
      selection = meta?.model_selection ?? (meta?.profile ? {
        provider_id: meta.profile,
        model_id: meta.model,
        ...(meta.effort ? { reasoning_effort: meta.effort } : {}),
      } : null);
    }
    return { ...choices, selection, activeProfile: (await client.adminService<any>("profile.list", {})).active_profile };
  });

  ipcMain.handle("model-picker:save", async (event, args: {
    sessionId?: string | null;
    selection: SessionModelSelection | null;
    alsoDefault?: boolean;
  }) => {
    if (!isModelPickerWindow(event.sender.id) || event.senderFrame !== event.sender.mainFrame || !isTrustedPicker(event.senderFrame?.url ?? "")) throw new Error("model picker IPC is restricted to the native picker window");
    const client = await getClient();
    if (args.selection != null && (typeof args.selection.provider_id !== "string" || typeof args.selection.model_id !== "string")) {
      throw new Error("invalid provider/model selection");
    }
    if (args.sessionId) {
      const normalized = args.selection == null ? null : await normalizeSessionSelection(client, args.selection);
      await client.adminSessionService("session.set_model_selection", args.sessionId, { selection: normalized });
    }
    if (args.alsoDefault || !args.sessionId) {
      if (!args.selection) {
        await clearDefaultModelSelection(app.getPath("userData"));
        return null;
      }
      await applyConfiguredDefault(client, app.getPath("userData"), args.selection);
    }
    return null;
  });

  ipcMain.handle("model-picker:open", async (event, args: { sessionId?: string | null } = {}) => {
    if (event.senderFrame !== event.sender.mainFrame || !isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("IPC sender is not the application renderer");
    const client = await getClient();
    return openModelPicker(client, args.sessionId ?? null).id;
  });
}

function isTrustedRenderer(rawUrl: string): boolean {
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
      const raw = await client.serviceRpc<any[]>("session.list", {});
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
        return challenges.issueViews(seed, flattenAdminApprovals(view.pending));
      } catch (error) {
        console.warn(`[approvals] Failed to read pending interactions for ${seed}:`, error);
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed() && !isModelPickerWindow(window.webContents.id)) {
            window.webContents.send("qaqh:event:conn://error", { message: `Pending interactions unavailable for ${seed}: ${error instanceof Error ? error.message : String(error)}` });
          }
        });
        throw error;
      }
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

      const command = approvalCommand(stored, decision, payload);
      requireAccepted(await client.command(command.channel, command, stored.sessionId));
      return null;
    }

    case "send_message": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const text = String(args.text || "");
      const attachments = Array.isArray(args.attachments) ? args.attachments : [];

      const ack = await client.command("conversation", {
        type: "conversation_send_message",
        text,
        images: [],
        attachments,
        as_system: false,
        input_purpose: "trigger_turn",
      }, seed);

      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      return ack;
    }

    case "cancel_turn": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const turnId = args.turnId ?? null;
      const ack = await client.command("conversation", {
        type: "conversation_cancel",
        turn_id: turnId,
      }, seed);
      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      return ack;
    }

    case "compact_context": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const ack = await client.command("conversation", {
        type: "conversation_compact",
      }, seed);
      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      return ack;
    }

    case "create_session": {
      const before = new Set((await client.serviceRpc<any[]>("session.list", {})).map((item) => String(item.session_id)));
      const cwd = typeof args.cwd === "string" && args.cwd.trim() !== "" ? args.cwd.trim() : null;
      const ack = await client.command("control", {
        type: "session_create",
        close_current: false,
        cwd,
      }, null);
      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      let defaultSelection = await readDefaultModelSelection(app.getPath("userData"));
      if (defaultSelection) {
        try {
          defaultSelection = await normalizeSessionSelection(client, defaultSelection);
        } catch (error) {
          console.warn("[model-picker] saved default is no longer valid:", error);
          await clearDefaultModelSelection(app.getPath("userData"));
          defaultSelection = null;
        }
      }
      if (defaultSelection) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const sessions = await client.serviceRpc<any[]>("session.list", {});
          const created = sessions.find((item) => !before.has(String(item.session_id)));
          if (created) {
            try {
              await client.adminSessionService("session.set_model_selection", String(created.session_id), {
                selection: defaultSelection,
              });
            } catch (error) {
              console.warn("[model-picker] saved default was not applied to new session:", error);
            }
            break;
          }
        }
      }
      return ack;
    }

    case "service_rpc": {
      const method = String(args.method || "");
      const params = (args.params && typeof args.params === "object") ? { ...args.params } : {};
      if (!SERVICE_METHODS.has(method)) throw new Error(`service method not allowed: ${method}`);
      const targetSeed = client.getActiveSeed();
      if (method.startsWith("fs.") && !("scope_session_id" in params) && targetSeed) {
        params.scope_session_id = targetSeed;
      }
      if (!SESSION_EXEMPT_METHODS.has(method)) {
        if (typeof params.session_id !== "string" || !params.session_id) {
          if (!targetSeed) throw new Error("no_active_seed");
          params.session_id = targetSeed;
        }
      }

      return client.serviceRpc(method, params);
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
      const version = app.getVersion();
      const commit = process.env.QAQH_GIT_COMMIT || "unknown";
      const display = `${version}-${commit.slice(0, 8)}${process.env.QAQH_GIT_DIRTY === "1" ? "-dirty" : ""}`;
      return { display, version, commit };
    }

    case "host_memory": {
      const usage = process.memoryUsage();
      return { resident_bytes: usage.rss, private_bytes: null, virtual_bytes: null, peak_resident_bytes: null, source: "node:process.memoryUsage.rss", error: null };
    }

    case "host_process_group": {
      return processGroup(app.getAppMetrics(), process.pid);
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

    case "timeline_page": {
      const seed = String(args.seed || "");
      const limit = args.limit != null ? Number(args.limit) : null;
      const beforeIndex = args.beforeIndex != null ? Number(args.beforeIndex) : null;
      return client.timelinePage(seed, limit, beforeIndex);
    }

    case "session_bootstrap": {
      const seed = requireId(args.seed, "session_id");
      return client.bootstrap(seed);
    }

    case "timeline_status": {
      const seed = String(args.seed || "");
      return client.getTimelineStatus(seed);
    }

    case "streams_retry": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      if (seed) {
        await client.attach(seed);
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
