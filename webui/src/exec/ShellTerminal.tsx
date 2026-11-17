/**
 * 用户 shell 终端(交互式 xterm + 主进程 PTY)。
 *
 * 入口在后台执行抽屉头部的「终端」钮:cwd 直接吸收工作区粘字段
 * (tabs/store 的 newSessionCwd),没有就落主进程 home——「开个 terminal
 * 再 cd」这一步从流程里删掉了。
 *
 * 与 ReadOnlyTerminal 的分工:那边是 80 列固定解析器 + 纯只读回看;这边
 * cols/rows 随窗测量、允许 resize,是真正的活 shell。主题探测/终端配色复用
 * 同一套(lib/terminal-theme)。
 */
import { createEffect, onSettled, type Component } from "solid-js";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { desktopHost, type ShellFrame } from "../lib/desktop-host";
import { transport } from "../lib/transport";
import { resolvedTheme } from "../lib/theme";
import { terminalScheme, terminalThemeFor } from "../lib/terminal-theme";
import { newSessionCwd } from "../tabs/store";

/** 等宽字符测量:0.6em 列宽 × 1.25 行高,与 ReadOnlyTerminal 同一比例。 */
const CHAR_RATIO = 0.6;
const LINE_RATIO = 1.25;

export const ShellTerminal: Component<{ class?: string }> = (props) => {
  const host = desktopHost();
  const bridge = host?.shell;
  let root: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let shellId: string | null = null;
  let lastGeometry = { cols: 0, rows: 0 };

  const geometry = (): { cols: number; rows: number } | null => {
    if (root == null || terminal == null) return null;
    const fontSize = Number.parseFloat(getComputedStyle(root).fontSize) || 12;
    // clientWidth/Height 含 padding(10px 左右 / 8px 上下,见 .shell-terminal),
    // 屏宽必须按内容盒折算,否则末列溢出到容器外。
    const cols = Math.max(20, Math.floor((root.clientWidth - 20) / (fontSize * CHAR_RATIO)));
    const rows = Math.max(4, Math.floor((root.clientHeight - 16) / (fontSize * LINE_RATIO)));
    if (cols < 20 || rows < 4) return null; // 抽屉未布局完成(0 宽)不启动。
    return { cols, rows };
  };

  const applyTheme = (): void => {
    if (root == null || terminal == null) return;
    const style = getComputedStyle(root);
    const scheme = terminalThemeFor(terminalScheme());
    if (scheme != null) {
      root.style.background = scheme.background ?? "";
      terminal.options.theme = { ...scheme };
    } else {
      root.style.background = "";
      const isDark = resolvedTheme() === "dark";
      terminal.options.theme = {
        foreground: style.color,
        background: style.backgroundColor,
        selectionBackground: isDark ? "rgba(120, 160, 255, 0.32)" : "rgba(32, 92, 190, 0.24)",
      };
    }
    terminal.options.fontFamily = style.fontFamily;
    terminal.options.fontSize = Number.parseFloat(style.fontSize) || 12;
  };

  // 挂载与清理走 onSettled(仓内 ReadOnlyTerminal 同一模式:effect 的 apply
  // 作用域里注册 onCleanup 是惰性的,必须**返回**清理函数才会挂上)。
  onSettled(() => {
    if (root == null) return undefined;
    terminal = new Terminal({
      disableStdin: false,
      cursorBlink: true,
      convertEol: false,
      fontSize: 11,
      fontFamily: getComputedStyle(root).fontFamily,
      lineHeight: LINE_RATIO,
      scrollback: 2000,
      theme: { background: "transparent" },
    });
    terminal.open(root);
    applyTheme();
    terminal.onData((data) => {
      if (shellId != null) void bridge?.stdin(shellId, data);
    });

    const offFrame = host?.listen("app://shell-frame", (payload) => {
      const frame = payload as ShellFrame | null;
      if (frame == null || frame.id !== shellId) return;
      if (frame.data != null) terminal?.write(frame.data);
      else if (frame.closed != null) {
        // 词表里唯一一种下行 text 帧;ws 断了不走这里(§D5 断联不 kill)。
        terminal?.writeln(`\r\n\x1b[2m[shell 已结束:${frame.closed.reason}]\x1b[0m`);
        if (terminal != null) terminal.options.disableStdin = true;
      }
    });

    const start = async (): Promise<void> => {
      if (bridge == null || terminal == null) return;
      const size = geometry();
      if (size == null) return;
      lastGeometry = size;
      terminal.writeln("正在启动 shell…");
      try {
        // 生命周期走服务面,字节走这条 ws;中途被打断的无人观看 shell 由 idle 回收收走。
        const created = await transport.query("shell.open", { cwd: newSessionCwd() ?? undefined, ...size });
        shellId = created.id;
        await bridge.attach(created.id);
        terminal.reset();
        terminal.focus();
      } catch (error) {
        terminal.writeln(`shell 启动失败:${String(error instanceof Error ? error.message : error)}`);
      }
    };
    void start();

    const observer = new ResizeObserver(() => {
      const size = geometry();
      if (size == null || bridge == null || shellId == null) return;
      if (size.cols === lastGeometry.cols && size.rows === lastGeometry.rows) return;
      lastGeometry = size;
      void bridge.resize(shellId, size.cols, size.rows);
    });
    observer.observe(root);

    return (): void => {
      observer.disconnect();
      offFrame?.();
      // 关页签 = 用户明确收走这个终端:服务面 `shell.close`;detach 是幂等的双保险
      // (closed 帧到达时主进程自己会收句柄)。
      if (shellId != null) {
        void transport.query("shell.close", { shell_id: shellId }).catch(() => {});
        void bridge?.detach(shellId);
      }
      terminal?.dispose();
    };
  });

  createEffect(() => [resolvedTheme(), terminalScheme()] as const, () => applyTheme());

  return <div class={`shell-terminal ${props.class ?? ""}`} ref={root} role="textbox" aria-label="用户终端" tabindex={0} />;
};
