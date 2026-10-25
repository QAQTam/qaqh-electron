import { ipcMain } from "electron";
import type { RingingClient } from "./ringing-client.js";
import type { DaemonManager } from "./daemon.js";
import type { ChallengeManager } from "./challenges.js";
import {
  pickDirectory,
  pickAttachments,
  openExternalUrl,
  captureScreenshot,
  uploadAttachment,
} from "./native-dialogs.js";
import { scanUserSkills } from "./skills-scanner.js";
import type { RingingV2PendingApprovals } from "@qaqh/sdk/protocol";
import type { RingingCommandAck } from "./types.js";

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

/**
 * 把 approvals.admin 的两个槽位摊平成 ChallengeManager 期望的条目形状。
 * details 整卡透传：渲染层读取的 tool_name/action_summary/risk/plan_content
 * 等键正是 daemon admin 视图的键。
 */
function flattenAdminApprovals(pending: RingingV2PendingApprovals): Array<Record<string, any>> {
  const items: Array<Record<string, any>> = [];
  if (pending.pending_permission) {
    items.push({
      kind: "tool_permission",
      interaction_id: pending.pending_permission.tool_call_id,
      details: pending.pending_permission,
    });
  }
  if (pending.pending_interaction) {
    const kind = pending.pending_interaction.kind === "permission" ? "tool_permission" : pending.pending_interaction.kind;
    items.push({
      kind,
      interaction_id: pending.pending_interaction.id,
      details: (pending.pending_interaction.details as Record<string, any> | null) ?? {},
    });
  }
  return items;
}

export function registerIpcHandlers(
  client: RingingClient,
  daemonMgr: DaemonManager,
  challenges: ChallengeManager
): void {
  // 统一通用转发口（支持 preload 的 tauri:invoke 调用）
  ipcMain.handle("tauri:invoke", async (_event, cmd: string, args: Record<string, any> = {}) => {
    return handleCommand(cmd, args, client, daemonMgr, challenges);
  });
}

async function handleCommand(
  cmd: string,
  args: Record<string, any>,
  client: RingingClient,
  _daemonMgr: DaemonManager,
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
      const seed = String(args.seed || "");
      // approvals.admin 是已实现的 canonical capability（旧的
      // session.pending_approvals 是后端 pending 方法，永远兜底成空数组）。
      const view = await client.approvals(seed).catch(() => null);
      const items = view && view.kind === "admin" ? flattenAdminApprovals(view.pending) : [];
      return challenges.issueViews(seed, items);
    }

    case "respond_approval": {
      const seed = String(args.seed || "");
      const challengeId = String(args.challengeId || "");
      const decision = String(args.decision || "");
      const payload = args.payload || {};

      const stored = challenges.consume(seed, challengeId);
      if (!stored) {
        throw new Error(`Invalid or expired challenge: ${challengeId}`);
      }

      return client.command("control", {
        type: "approval_decision",
        session_id: seed,
        decision,
        call_id: stored.internalId,
        payload,
      });
    }

    case "send_message": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const text = String(args.text || "");
      const attachments = Array.isArray(args.attachments) ? args.attachments : [];

      const ack = await client.command("conversation", {
        type: "conversation_send_message",
        session_id: seed,
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
        session_id: seed,
        turn_id: turnId,
      });
      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      return ack;
    }

    case "compact_context": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const ack = await client.command("conversation", {
        type: "conversation_compact",
        session_id: seed,
      });
      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      return ack;
    }

    case "create_session": {
      const cwd = typeof args.cwd === "string" && args.cwd.trim() !== "" ? args.cwd.trim() : null;
      const ack = await client.command("control", {
        type: "session_create",
        cwd,
      });
      if (ack.status === "rejected") {
        throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
      }
      return ack;
    }

    case "service_rpc": {
      const method = String(args.method || "");
      const params = (args.params && typeof args.params === "object") ? { ...args.params } : {};

      const exemptMethods = [
        "daemon.version",
        "session.list",
        "session.activity",
        "workspace.list",
        "workspace.create",
        "workspace.move_session",
        "workspace.detach",
        "config.load",
        "config.save",
        "profile.apply",
        "profile.save_current",
        "profile.delete",
        "diagnostics.memory.start",
        "diagnostics.memory.stop",
        "diagnostics.memory.snapshot",
      ];

      const isExempt = exemptMethods.includes(method) || method.startsWith("siwc.") || method.startsWith("dsaccount.");
      if (!isExempt) {
        const activeSeed = client.getActiveSeed();
        if (activeSeed && !params.session_id) {
          params.session_id = activeSeed;
        }
        if (method.startsWith("fs.") && !params.scope_session_id) {
          params.scope_session_id = params.session_id || activeSeed;
        }
      }

      return client.serviceRpc(method, params);
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
      const seed = String(args.seed || "");
      // 渲染层读取 bootstrap.control.state.activity —— canonical ClientV2Bootstrap
      // （旧的 session.activity 是后端 pending 方法，此前一直失败兜底成 {}）
      return client.bootstrap(seed).catch(() => ({}));
    }

    case "timeline_status": {
      const seed = String(args.seed || "");
      return {
        status: client.getActiveSeed() === seed ? "open" : "closed",
        session_id: seed,
      };
    }

    case "streams_retry": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      if (seed) {
        await client.attach(seed);
      }
      return null;
    }

    case "stop_stale_daemon": {
      // 在 Electron 模式下无需强行停止其他 daemon
      return "unsupported";
    }

    case "pick_directory": {
      return pickDirectory();
    }

    case "pick_attachments": {
      return pickAttachments();
    }

    case "capture_screenshot": {
      const mode = args.mode === "fullscreen" ? "fullscreen" : "selection";
      return captureScreenshot(mode);
    }

    case "upload_attachment": {
      const seed = String(args.seed || client.getActiveSeed() || "");
      const filePath = String(args.path || "");
      return uploadAttachment(client, seed, filePath);
    }

    case "open_external": {
      const url = String(args.url || "");
      await openExternalUrl(url);
      return null;
    }

    case "set_window_theme": {
      // Linux 下主题设置可返回 false 让前端走标准 CSS 主题变量
      return false;
    }

    default:
      console.warn(`[ipc] Unhandled command: ${cmd}`, args);
      throw new Error(`Command ${cmd} not implemented in Electron shell`);
  }
}
