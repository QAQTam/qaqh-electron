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
        const status = entry.status || "idle";
        return {
          session_id: meta.session_id || entry.session_id,
          title: meta.title,
          cwd: meta.cwd,
          updated_at: meta.updated_at || Date.now(),
          turn_count: meta.turn_count || 0,
          status,
          busy: sessionIsBusy(status),
          archived: Boolean(meta.archived),
          workspace_id: entry.workspace_id,
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
      const pending = await client.serviceRpc<any[]>("session.pending_approvals", { session_id: seed }).catch(() => []);
      return challenges.issueViews(seed, Array.isArray(pending) ? pending : []);
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
        attachments,
      });

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
      const params = args.params || {};
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
      return client.serviceRpc("session.activity", { session_id: seed }).catch(() => ({}));
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
