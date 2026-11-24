import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import type { RingingClient } from "./ringing-client.js";

const ACTIVITY_QUERY_TIMEOUT_MS = 500;

export interface NativeQuitDeps {
  getClient: () => RingingClient | null;
  getParentWindow: () => BrowserWindow | null;
}

let quitInFlight: Promise<void> | null = null;

/**
 * 触发跨平台原生系统退出确认对话框（Windows TaskDialog / macOS NSAlert / Linux GTK）。
 *
 * 托盘退出或主窗口隐藏时不强行唤醒/重绘主窗口，也不传隐藏窗口作 parent，
 * 避免渲染进程卡死、后台节流或 GPU/Mica 合成导致托盘退出无响应。
 */
export function requestNativeQuit(deps: NativeQuitDeps): Promise<void> {
  if (quitInFlight != null) return quitInFlight;
  quitInFlight = runNativeQuit(deps).finally(() => {
    quitInFlight = null;
  });
  return quitInFlight;
}

function visibleParentWindow(getParentWindow: () => BrowserWindow | null): BrowserWindow | null {
  const win = getParentWindow();
  if (win == null || win.isDestroyed()) return null;
  if (!win.isVisible() || win.isMinimized()) return null;
  return win;
}

function showMessageBox(parent: BrowserWindow | null, options: MessageBoxOptions) {
  return parent != null ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

async function queryActiveSessionCount(client: RingingClient | null): Promise<number | null> {
  if (client == null) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const activities = await Promise.race([
      client.serviceCall("session.activity", {}),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ACTIVITY_QUERY_TIMEOUT_MS);
      }),
    ]);
    if (activities == null) return null;
    return activities.filter(
      (item) => item.state === "running" || item.state === "waiting_user" || item.state === "cancelling",
    ).length;
  } catch {
    return null;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function showStopFailure(parent: BrowserWindow | null, reason: string): Promise<void> {
  await showMessageBox(parent, {
    type: "error",
    title: "无法停止服务",
    message: "未能安全停止后台 daemon",
    detail: reason,
    buttons: ["确定"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

async function stopDaemonAndQuit(
  client: RingingClient | null,
  idleOnly: boolean,
  parent: BrowserWindow | null,
): Promise<void> {
  if (client == null) {
    await showStopFailure(parent, "尚未连接 daemon，无法安全停止。");
    return;
  }
  try {
    const status = await client.stopDaemon(idleOnly);
    if (status === "busy") {
      await showStopFailure(parent, "后台任务状态刚刚变化；为保护任务，daemon 未停止。");
      return;
    }
    if (status === "unsupported") {
      await showStopFailure(parent, "当前 daemon 不支持安全停止。");
      return;
    }
    app.quit();
  } catch (cause) {
    await showStopFailure(parent, cause instanceof Error ? cause.message : String(cause));
  }
}

async function runNativeQuit(deps: NativeQuitDeps): Promise<void> {
  const client = deps.getClient();
  const activeCount = await queryActiveSessionCount(client);
  const parent = visibleParentWindow(deps.getParentWindow);

  if (activeCount === null) {
    const { response } = await showMessageBox(parent, {
      type: "question",
      title: "退出 QAQH",
      message: "退出 QAQH",
      detail:
        "暂时无法确认 daemon 的活动状态。为保护后台任务，建议退出界面并让 daemon 继续运行。\n\n" +
        "停止服务选项已禁用，直到活动状态可查询。",
      buttons: ["退出并保留后台任务", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) app.quit();
    return;
  }

  if (activeCount === 0) {
    const { response } = await showMessageBox(parent, {
      type: "question",
      title: "退出 QAQH",
      message: "退出 QAQH",
      detail:
        "当前没有运行中或等待处理的会话。\n\n" +
        "停止 daemon 会断开其他客户端；也可以退出 QAQH 并让服务留在后台。",
      buttons: ["退出并保留后台任务", "退出并停止空闲服务", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) app.quit();
    else if (response === 1) await stopDaemonAndQuit(client, true, parent);
    return;
  }

  const { response } = await showMessageBox(parent, {
    type: "warning",
    title: "退出 QAQH",
    message: `有 ${activeCount} 个会话正在运行或等待处理`,
    detail: "退出界面会让后台任务继续运行。停止 daemon 会中断所有客户端连接中的会话。",
    buttons: ["退出并保留后台任务", "停止任务并退出…", "取消"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) {
    app.quit();
    return;
  }
  if (response !== 1) return;

  const confirm = await showMessageBox(parent, {
    type: "warning",
    title: "确认停止后台任务",
    message: "确认停止所有后台任务？",
    detail: "这会优雅关闭共享 daemon，并中断运行中或等待授权的会话。其他客户端也会断开。",
    buttons: ["确认停止并退出", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirm.response === 0) {
    await stopDaemonAndQuit(client, false, parent);
  }
}
