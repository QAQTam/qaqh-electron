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

export type ReadOnlyTerminalProps = { text: string; live: boolean; stream?: ToolProgressStream; tty?: boolean; onWrite?: () => void };

export const ReadOnlyTerminal: Component<ReadOnlyTerminalProps> = (props) => {
  let host: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let observer: ResizeObserver | undefined;
  let lastText = "";
  let lastOffset = 0;
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
      props.onWrite?.();
    });
  };

  const sync = (text: string, live: boolean, stream?: ToolProgressStream): void => {
    if (terminal == null) return;
    if (!initialized) {
      initialized = true;
      lastText = text;
      wasLive = live;
      lastOffset = live ? stream?.endOffset ?? text.length : 0;
      write(text);
      return;
    }
    if (text === lastText && live === wasLive && (!live || stream?.endOffset === lastOffset)) return;

    // The bounded stream window carries offsets so repeated output and tail rollover
    // remain incremental. Rehydrate only if the component fell behind the retained
    // window; final output always replaces the live preview with the full snapshot.
    const finalSnapshot = wasLive && !live;
    if (finalSnapshot) {
      terminal.reset();
      following = true;
      if (host != null) host.style.height = `${Math.ceil(12 * LINE_HEIGHT + VERTICAL_PADDING)}px`;
      write(text);
      lastOffset = 0;
    } else if (live && stream != null) {
      if (lastOffset < stream.startOffset || lastOffset > stream.endOffset) {
        terminal.reset();
        following = true;
        if (host != null) host.style.height = `${Math.ceil(12 * LINE_HEIGHT + VERTICAL_PADDING)}px`;
        write(stream.data);
      } else {
        const offset = lastOffset - stream.startOffset;
        write(stream.offsetEncoding === "utf8"
          ? new TextDecoder().decode(new TextEncoder().encode(stream.data).subarray(offset))
          : stream.data.slice(offset));
      }
      lastOffset = stream.endOffset;
    } else {
      if (!text.startsWith(lastText)) {
        terminal.reset();
        following = true;
        if (host != null) host.style.height = `${Math.ceil(12 * LINE_HEIGHT + VERTICAL_PADDING)}px`;
        write(text);
      } else {
        write(text.slice(lastText.length));
      }
      lastOffset = live ? stream?.endOffset ?? text.length : 0;
    }
    lastText = text;
    wasLive = live;
  };

  createEffect(
    () => [props.text, props.live, props.stream?.startOffset, props.stream?.endOffset, props.stream?.data, props.stream?.offsetEncoding] as const,
    ([text, live]) => sync(text, live, props.stream),
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
    observer = new ResizeObserver(() => { resizeToContent(); props.onWrite?.(); });
    const screen = host.querySelector(".xterm-screen");
    if (screen) observer.observe(screen);
    sync(props.text, props.live, props.stream);

    return () => {
      observer?.disconnect();
      terminal?.dispose();
      terminal = undefined;
    };
  });

  return <div class="tool-xterm" ref={host} role="region" aria-label="只读终端输出" />;
};
