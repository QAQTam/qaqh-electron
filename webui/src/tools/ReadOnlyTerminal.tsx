import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createEffect, onSettled, type Component } from "solid-js";
import { resolvedTheme, themePreset } from "../lib/theme";
import type { ToolProgressStream } from "../session/types";

// Match ExecSessionManager's PTY size. Cropping the UI must never resize the parser.
const TERMINAL_COLS = 80;
const TERMINAL_ROWS = 24;
const LINE_HEIGHT = 1.25;
const VERTICAL_PADDING = 16;
// stdout/stderr 共用这一台 xterm：stderr 首次出现时打一条着色分隔行，每个增量裹红色。
// 滚动面唯一（xterm viewport），外层容器不再参与任何滚动。
const STDERR_HEADER = "\n\x1b[1m\x1b[31m── stderr ──\x1b[22m\x1b[39m\n";

export type ReadOnlyTerminalProps = {
  text: string;
  live: boolean;
  stream?: ToolProgressStream;
  stderr?: string;
  stderrStream?: ToolProgressStream;
  tty?: boolean;
};

export const ReadOnlyTerminal: Component<ReadOnlyTerminalProps> = (props) => {
  let host: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let observer: ResizeObserver | undefined;
  let lastText = "";
  let lastOffset = 0;
  let lastStderr = "";
  let lastStderrOffset = 0;
  let stderrStarted = false;
  let wasLive = false;
  let initialized = false;
  let following = true;

  const syncTheme = (): void => {
    if (host == null || terminal == null) return;
    const style = getComputedStyle(host);
    const isDark = resolvedTheme() === "dark";
    terminal.options.theme = {
      foreground: style.color,
      background: style.backgroundColor,
      cursor: style.color,
      selectionBackground: isDark ? "rgba(120, 160, 255, 0.32)" : "rgba(32, 92, 190, 0.24)",
    };
    terminal.options.fontFamily = style.fontFamily;
    terminal.options.fontSize = Number.parseFloat(style.fontSize) || 12;
  };

  const resizeToContent = (): void => {
    if (host == null || terminal == null) return;
    const buffer = terminal.buffer.active;
    // Hide unused bottom rows for short output, keeping the full 80x24 screen
    // inside. Scan the screen because progress UIs often restore the cursor
    // after painting a status bar on the bottom row.
    let rows = Math.max(1, buffer.cursorY + 1);
    for (let row = TERMINAL_ROWS - 1; row >= rows; row--) {
      if (buffer.getLine(buffer.viewportY + row)?.translateToString(true)) {
        rows = row + 1;
        break;
      }
    }
    const fontSize = Number.parseFloat(getComputedStyle(host).fontSize) || 12;
    const screenHeight = host.querySelector(".xterm-screen")?.getBoundingClientRect().height;
    const rowHeight = screenHeight ? screenHeight / TERMINAL_ROWS : fontSize * LINE_HEIGHT;
    host.style.height = `${Math.ceil(rows * rowHeight + VERTICAL_PADDING)}px`;
  };

  const write = (text: string): void => {
    if (text === "" || terminal == null) return;
    terminal.write(text, () => {
      if (terminal == null) return;
      if (following) terminal.scrollToBottom();
      resizeToContent();
    });
  };

  const writeStderr = (delta: string): void => {
    if (delta === "" || terminal == null) return;
    if (!stderrStarted) {
      stderrStarted = true;
      write(STDERR_HEADER);
    }
    write(`\x1b[31m${delta}\x1b[39m`);
  };

  // 返回待写增量；null 表示组件落后于保留窗口，必须 reset 后按两条流整体重建。
  const pendingChunk = (
    lastContent: string,
    lastPos: number,
    full: string,
    live: boolean,
    stream?: ToolProgressStream,
  ): string | null => {
    if (live && stream != null) {
      if (lastPos < stream.startOffset || lastPos > stream.endOffset) return null;
      const skip = lastPos - stream.startOffset;
      return stream.offsetEncoding === "utf8"
        ? new TextDecoder().decode(new TextEncoder().encode(stream.data).subarray(skip))
        : stream.data.slice(skip);
    }
    if (!full.startsWith(lastContent)) return null;
    return full.slice(lastContent.length);
  };

  const rehydrate = (
    text: string,
    live: boolean,
    stream: ToolProgressStream | undefined,
    stderrText: string,
    stderrStream: ToolProgressStream | undefined,
  ): void => {
    terminal!.reset();
    following = true;
    stderrStarted = false;
    write(live && stream != null ? stream.data : text);
    writeStderr(live && stderrStream != null ? stderrStream.data : stderrText);
    lastText = text;
    lastStderr = stderrText;
    lastOffset = live ? stream?.endOffset ?? text.length : 0;
    lastStderrOffset = live ? stderrStream?.endOffset ?? stderrText.length : 0;
  };

  const sync = (text: string, live: boolean, stream?: ToolProgressStream, stderrText = "", stderrStream?: ToolProgressStream): void => {
    if (terminal == null) return;
    if (!initialized) {
      initialized = true;
      wasLive = live;
      lastText = text;
      lastStderr = stderrText;
      lastOffset = live ? stream?.endOffset ?? text.length : 0;
      lastStderrOffset = live ? stderrStream?.endOffset ?? stderrText.length : 0;
      write(text);
      writeStderr(stderrText);
      return;
    }
    const finalSnapshot = wasLive && !live;
    const stdoutQuiet = text === lastText && live === wasLive && (!live || stream?.endOffset === lastOffset);
    const stderrQuiet = stderrText === lastStderr && (!live || stderrStream?.endOffset === lastStderrOffset);
    if (!finalSnapshot && stdoutQuiet && stderrQuiet) return;

    // The bounded stream window carries offsets so repeated output and tail rollover
    // remain incremental. Rehydrate only if the component fell behind the retained
    // window; final output always replaces the live preview with the full snapshot.
    if (finalSnapshot) {
      rehydrate(text, live, stream, stderrText, stderrStream);
    } else {
      const stdoutChunk = pendingChunk(lastText, lastOffset, text, live, stream);
      const stderrChunk = pendingChunk(lastStderr, lastStderrOffset, stderrText, live, stderrStream);
      if (stdoutChunk === null || stderrChunk === null) {
        rehydrate(text, live, stream, stderrText, stderrStream);
      } else {
        write(stdoutChunk);
        writeStderr(stderrChunk);
        lastText = text;
        lastStderr = stderrText;
        lastOffset = live ? stream?.endOffset ?? text.length : 0;
        lastStderrOffset = live ? stderrStream?.endOffset ?? stderrText.length : 0;
      }
    }
    wasLive = live;
  };

  createEffect(
    () => [
      props.text, props.live, props.stream, props.stderr, props.stderrStream,
      props.stream?.startOffset, props.stream?.endOffset, props.stream?.data, props.stream?.offsetEncoding,
      props.stderrStream?.startOffset, props.stderrStream?.endOffset, props.stderrStream?.data, props.stderrStream?.offsetEncoding,
    ] as const,
    ([text, live, stream, stderr, stderrStream]) => sync(text, live, stream, stderr ?? "", stderrStream),
  );

  createEffect(
    () => [resolvedTheme(), themePreset()] as const,
    () => syncTheme(),
  );

  createEffect(() => props.tty ?? false, (tty) => {
    if (terminal) terminal.options.convertEol = !tty;
  });

  onSettled(() => {
    if (host == null) return;
    terminal = new Terminal({
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      allowTransparency: false,
      convertEol: !(props.tty ?? false),
      cursorBlink: false,
      cursorInactiveStyle: "none",
      disableStdin: true,
      fontFamily: getComputedStyle(host).fontFamily,
      fontSize: Number.parseFloat(getComputedStyle(host).fontSize) || 12,
      lineHeight: LINE_HEIGHT,
      scrollback: 1000,
    });
    terminal.open(host);
    syncTheme();
    terminal.onScroll(() => {
      if (terminal == null) return;
      const buffer = terminal.buffer.active;
      following = buffer.viewportY >= buffer.baseY;
      resizeToContent();
    });
    observer = new ResizeObserver(() => { resizeToContent(); });
    const screen = host.querySelector(".xterm-screen");
    if (screen) observer.observe(screen);
    sync(props.text, props.live, props.stream, props.stderr ?? "", props.stderrStream);

    return () => {
      observer?.disconnect();
      terminal?.dispose();
      terminal = undefined;
    };
  });

  return <div class="tool-xterm" ref={host} role="region" aria-label="只读终端输出" />;
};
