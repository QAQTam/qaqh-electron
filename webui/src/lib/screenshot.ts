/**
 * 应用内截图 —— 快捷键判定 + 取一张图的口径（薄壳，可脱浏览器测）。
 *
 * ## 为什么这么切
 *
 * 截图本身在宿主（`src-tauri/src/commands.rs::capture_screenshot`，macOS 走系统
 * `screencapture`）。这一层只管三件前端的事：
 *
 * 1. **哪个键**触发（`isScreenshotShortcut`）——纯判定，写成函数而不是在 `onKey`
 *    里现编条件：那个处理器已经有 quit 遮罩 / 设置浮层 / ESC 三层优先级，条件
 *    散在里面迟早和别的键位撞。
 * 2. **三种结局**要分得开：拿到文件 / 用户按 Esc 取消 / 平台或系统工具失败。
 *    混成"空结果"就会挂一个坏附件，混成"失败"就会在用户什么都没做时弹错误。
 * 3. 截图**落到哪**：结果只是一个本机临时文件路径，后续走既有的附件面
 *    （`upload_attachment`）——不为截图新辟一条上传口。
 */
import { transport, type ScreenshotWire, type ShotMode } from "./transport";
import {
  checkScreenRecordingPermission,
  requestScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";

/**
 * 截图快捷键：`⌘⇧S`（mac）/ `Ctrl+Shift+S`（其余平台）。
 *
 * 选 `⇧S` 而不是 `⌘S`：后者将来要给"保存"之类留位；也刻意**不**用 `⌘⇧3/4/5`
 * ——那是系统级截屏键位，webview 抢不到，抢到了也和用户肌肉记忆打架。
 */
export const SHOT_SHORTCUT_LABEL = "⌘⇧S";

/** 键盘事件里这条判定关心的那几个位（结构型：脱浏览器可测，不需要真 KeyboardEvent）。 */
export type ShortcutProbe = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** 按住不放会连发：那不是"我要连拍"，是同一个键被系统重复上报。 */
  repeat?: boolean;
};

export function isScreenshotShortcut(event: ShortcutProbe): boolean {
  if (event.repeat === true) return false;
  // Alt 留给以后别的键位；现在明确不参与，免得某天 ⌘⌥⇧S 意外触发截图。
  if (event.altKey) return false;
  if (!event.shiftKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return event.key.toLowerCase() === "s";
}

/** 一次截图的四种结局（**刻意不用 `null` 表示两种意思**）。 */
export type ShotOutcome =
  | { kind: "captured"; shot: ScreenshotWire }
  | { kind: "cancelled" }
  /** 屏幕「屏幕录制」TCC 未授权：UI 应弹引导并打开系统设置，而不是当失败静默。 */
  | { kind: "permission" }
  | { kind: "failed"; message: string };

/** 可注入的取图动作（测试里给假宿主）。 */
export type ShotDeps = {
  capture: (mode: ShotMode) => Promise<ScreenshotWire | null>;
  /**
   * 屏幕「屏幕录制」授权预检：true = 已授权可截。缺省 = **跳过门控**（测试与
   * 非 Tauri 环境不接插件）；运行时由 defaultDeps 接插件实现。
   */
  ensureScreenRecording?: () => Promise<boolean>;
};

const defaultDeps: ShotDeps = {
  capture: (mode) => transport.captureScreenshot(mode),
  // fail-open：预检本身出错（非 mac / 插件异常）时不拦截图，行为退回旧路径
  //（宿主命令自己的错误信息兜底），绝不因为预检故障把可用功能锁死。
  ensureScreenRecording: async () => {
    try {
      if (await checkScreenRecordingPermission()) return true;
      // 首次调用会触发系统授权弹窗（TCC 归因到本 app）；曾被拒则无弹窗，回 false。
      await requestScreenRecordingPermission();
      return checkScreenRecordingPermission();
    } catch {
      return true;
    }
  },
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * 宿主这一形态给不给得了系统截图 —— 决定按钮**出不出**，而不是等用户按了才报错。
 *
 * 现在只有 macOS 有实现（宿主那条命令在非 mac 直接返回不支持）。判定用 UA 而不是
 * 加一条 `platform` 命令：多一个 IPC 面只为一个 bool 不值，而这里猜错的后果只是
 * "按钮没出现"（用户仍能用系统的截图键 + 「添加附件」），不是坏功能。
 */
export function screenshotSupported(options: { inTauri: boolean; userAgent: string }): boolean {
  if (!options.inTauri) return false;
  return /Macintosh|Mac OS X|iPad|iPhone/i.test(options.userAgent);
}

/**
 * 取一张截图。
 *
 * 宿主回 `null` = 用户在十字准星上按了 Esc（进程成功但没写文件）；回对象但路径为空
 * 是**自相矛盾**的结果，按失败处理而不是静默当取消 —— 那种情况值得出声。
 */
export async function takeScreenshot(
  mode: ShotMode = "selection",
  deps: ShotDeps = defaultDeps,
): Promise<ShotOutcome> {
  // 授权预检在取图之前：未授权时 `screencapture` 会「成功」但产出**全黑图**，
  // 与取消难以区分还污染附件区——必须在 spawn 之前拦下。
  if (deps.ensureScreenRecording != null) {
    let authorized = false;
    try {
      authorized = await deps.ensureScreenRecording();
    } catch {
      authorized = true; // 预检故障 fail-open,同 defaultDeps 的口径。
    }
    if (!authorized) return { kind: "permission" };
  }
  let shot: ScreenshotWire | null;
  try {
    shot = await deps.capture(mode);
  } catch (cause) {
    const message = messageOf(cause);
    // 宿主预检(第二道防线)拦下的授权缺口,归并到同一个引导结局。
    if (message.includes("SCREEN_RECORDING_REQUIRED")) return { kind: "permission" };
    return { kind: "failed", message };
  }
  if (shot == null) return { kind: "cancelled" };
  if (typeof shot.path !== "string" || shot.path.trim() === "") {
    return { kind: "failed", message: "宿主回了截图结果但没有文件路径" };
  }
  return { kind: "captured", shot };
}
