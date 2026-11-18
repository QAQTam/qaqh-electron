/**
 * 用户 shell 终端(交互式 xterm + 主进程 PTY)。
 *
 * 本组件是**受控视图**:shell 由 shell-tabs store 在开标签时 `shell.open` 出来,
 * 这里只拿 `shellId` 附着 WS 数据面。DOM 卸载(切标签/收起面板)只 `detach`
 * 退订,绝不发 `shell.close`——杀进程只发生在用户显式关标签时(store.close)。
 * cwd 同样在开标签时快照,一个编前端一个编后端互不干扰。
 *
 * 与 ReadOnlyTerminal 的分工:那边是 80 列固定解析器 + 纯只读回看;这边
 * 允许 resize,是真正的活 shell。主题探测/终端配色复用同一套(lib/terminal-theme)。
 *
 * 几何唯一真值是 xterm 网格自己:FitAddon 按真实字形量出行列(壳层
 * .shell-terminal-fit 是不带 padding 的净量尺),封顶后 resize 网格,再把
 * 同一份数字喂给 PTY(bridge.resize)——PTY 与模拟器永远同一
 * 坐标系。曾经容器按 0.6em 估宽喂 PTY、网格却停在默认 80×24,两套坐标
 * 各算各的,重绘/回显被钉到视口底部(2026-11-18 根因)。
 */
import { createEffect, onSettled, type Component } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { desktopHost, type ShellFrame } from "../lib/desktop-host";
import { resolvedTheme } from "../lib/theme";
import { terminalScheme, terminalThemeFor } from "../lib/terminal-theme";

/** 行高比例,与 ReadOnlyTerminal 同一比例(只管单元格视觉高度,fit 自会量真值)。 */
const LINE_RATIO = 1.25;

/** 几何上限(所有者口径 2026-11-18:200 列 × 70 行):FitAddon 实测的行列在此封顶——
 * 小窗口既不横向出条也不缩字号,裁掉的只是用不上的余量;低于下限视为
 * overlay 未布局完成(0 宽),不启动也不 resize。 */
const MAX_COLS = 200;
const MAX_ROWS = 70;
const MIN_COLS = 20;
const MIN_ROWS = 4;

export const ShellTerminal: Component<{ shellId: string; class?: string }> = (props) => {
  const host = desktopHost();
  const bridge = host?.shell;
  let root: HTMLDivElement | undefined;
  let fitRoot: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let lastGeometry = { cols: 0, rows: 0 };

  /** 把网格 resize 到 FitAddon 实测(封顶后)的行列,返回这份真值;
   * 量不出来(未布局/0 宽)返回 null。 */
  const applyFit = (): { cols: number; rows: number } | null => {
    if (terminal == null || fitAddon == null) return null;
    const proposal = fitAddon.proposeDimensions();
    if (proposal == null || Number.isNaN(proposal.cols) || Number.isNaN(proposal.rows)
      || proposal.cols < MIN_COLS || proposal.rows < MIN_ROWS) return null;
    const size = { cols: Math.min(MAX_COLS, proposal.cols), rows: Math.min(MAX_ROWS, proposal.rows) };
    if (size.cols !== terminal.cols || size.rows !== terminal.rows) terminal.resize(size.cols, size.rows);
    return size;
  };

  /** 网格即真值:变了才把同一份数字同步给 PTY,两边永远同一坐标系。 */
  const syncSize = (): void => {
    const size = applyFit();
    if (size == null || bridge == null) return;
    if (size.cols === lastGeometry.cols && size.rows === lastGeometry.rows) return;
    lastGeometry = size;
    void bridge.resize(props.shellId, size.cols, size.rows);
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
    if (root == null || fitRoot == null) return undefined;
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
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(fitRoot);
    applyTheme();
    terminal.onData((data) => {
      void bridge?.stdin(props.shellId, data);
    });

    const offFrame = host?.listen("app://shell-frame", (payload) => {
      const frame = payload as ShellFrame | null;
      if (frame == null || frame.id !== props.shellId) return;
      if (frame.data != null) terminal?.write(frame.data);
      else if (frame.closed != null) {
        // 词表里唯一一种下行 text 帧;ws 断了不走这里(§D5 断联不 kill)。
        terminal?.writeln(`\r\n\x1b[2m[shell 已结束:${frame.closed.reason}]\x1b[0m`);
        if (terminal != null) terminal.options.disableStdin = true;
      }
    });

    const start = async (): Promise<void> => {
      if (bridge == null || terminal == null) return;
      const size = applyFit();
      if (size == null) return;
      lastGeometry = size;
      terminal.writeln("正在连接终端…");
      try {
        // shell 已由 store 开好;这里只订阅它的裸字节流(重连从 from_offset 续)。
        await bridge.attach(props.shellId);
        terminal.reset();
        terminal.focus();
      } catch (error) {
        terminal.writeln(`终端连接失败:${String(error instanceof Error ? error.message : error)}`);
      }
    };
    void start();

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(fitRoot);

    return (): void => {
      observer.disconnect();
      offFrame?.();
      // 只退订,不杀进程:切标签/收起面板不能中断用户正在跑的编译。
      // 真正的 `shell.close` 在 shell-tabs store 的 close(id) 里。
      void bridge?.detach(props.shellId);
      terminal?.dispose();
    };
  });

  createEffect(() => [resolvedTheme(), terminalScheme()] as const, () => {
    applyTheme();
    // 字体族/字号随主题走,单元格实测尺寸跟着变,同一容器量出的行列可能
    // 不同:顺手把网格与 PTY 一起带到新真值。
    syncSize();
  });

  return (
    <div class={`shell-terminal ${props.class ?? ""}`} ref={root} role="textbox" aria-label="用户终端" tabindex={0}>
      {/* FitAddon 量的是 .xterm 父元素:这层空壳是不带 padding 的净量尺,
          根上的 padding 留在外面继续露主题底色。 */}
      <div class="shell-terminal-fit" ref={fitRoot} />
    </div>
  );
};
