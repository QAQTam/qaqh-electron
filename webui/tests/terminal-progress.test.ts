// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { Terminal } from "@xterm/xterm";

test("80x24 PTY parser overwrites the bottom progress bar and preserves the scrolling region", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, convertEol: false, allowProposedApi: true });
  const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));
  try {
    // Reserve row 24 for a progress bar, save/restore the log cursor as apt does.
    await write("\x1b[1;23r\x1b[1;1Hlog\r\n\x1b7\x1b[24;1HProgress: 10%\x1b8");
    const buffer = terminal.buffer.active;
    expect(buffer.getLine(23)?.translateToString(true)).toBe("Progress: 10%");
    expect(buffer.cursorY).toBe(1);
    await write("\x1b7\x1b[24;1H\r\x1b[2KProgress: 20%\x1b8");
    expect(buffer.getLine(23)?.translateToString(true)).toBe("Progress: 20%");
    expect(buffer.cursorY).toBe(1);
    await write("next log\r\n".repeat(30));
    expect(buffer.getLine(buffer.baseY + 23)?.translateToString(true)).toBe("Progress: 20%");
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
    await write("\x1b[r\x1b[1;1Hab\nc");
    // Raw LF moves down without inventing a carriage return in PTY mode.
    expect(buffer.getLine(buffer.baseY + 1)?.translateToString(false).slice(2, 3)).toBe("c");
  } finally { terminal.dispose(); }
});
