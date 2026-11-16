/**
 * 终端输出 → 剪贴板纯文本(后台执行抽屉「复制」按钮的数据净化)。
 *
 * 复制的数据源是原始 PTY 捕获字节流:TTY 会话里带全套 ANSI 转义(SGR 颜色、
 * \r 重绘、光标定位、OSC 标题),直接进剪贴板就是一屏乱码。这里按「用户最后
 * 看到的画面」重建纯文本:
 *  - 转义序列全剥:OSC(标题/超链接) → CSI(颜色/擦除/光标) → 其余 ESC 单序列;
 *  - 独立 \r(非 \r\n)按覆写语义处理:丢掉当前行已积累内容——进度条与
 *    cargo/dotnet 的编译进度以「最后一次重绘为准」,中间帧全部丢弃;
 *  - \b 退格删一个码点;bell 等其余 C0 控制符丢弃,\t 与 \n 保留;
 *  - 尾部空白修剪(终端复制同样如此)。
 *
 * 已知边界:滚动区/光标定位型重绘(apt 的 \x1b7...\x1b8)按线性文本处理——
 * 定位序列丢弃、内容按到达顺序排列;多行状态栏的全屏重绘无法在纯文本层精确
 * 还原,那需要逐行模拟器(xterm buffer 序列化,且会受 1000 行 scrollback 截断)。
 */

// CSI:参数字节(0x30-3F)+ 中间字节(0x20-2F)+ 终止字节(0x40-7E),含私有 ?/=/</> 标记。
const CSI_RE = /\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g;
// OSC:BEL 终止(Body 不含 ESC 即可);ST 终止走可选分支。截断的尾部 OSC 一并吃掉。
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// 其余 ESC 序列:0+ 中间字节(0x20-2F,如 \x1b(B 字符集指定)+ 任意 final(0x30-7E)。
// 覆盖 DEC 私有的 \x1b7/\x1b8(存取光标)、\x1b=/>(键盘模式)、\x1bc(复位)与残留 ST。
// [\ 与 ] 开头的 CSI/OSC 已在前两步吃完,不会误伤。
const ESC_RE = /\x1b[ -/]*[0-~]/g;
// 收尾的孤立 ESC(写入流在序列中间被截断)。
const LONE_ESC_RE = /\x1b$/g;

/** 删掉字符串末尾的一个码点(代理对整体删除)。 */
function dropLastCodePoint(text: string): string {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]$|[\s\S]$/, "");
}

export function terminalPlainText(raw: string): string {
  if (!raw) return "";
  // 1) 剥转义序列。顺序很重要:OSC 先吃(否则其 Body 会被 CSI 误拆),残留 ESC 后吃。
  const stripped = raw
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(ESC_RE, "")
    .replace(LONE_ESC_RE, "");

  // 2) 逐字符过 C0 层,行缓冲实现 \r 覆写与 \b 退格。
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < stripped.length; ) {
    const ch = stripped[index]!;
    if (ch === "\n") {
      lines.push(current);
      current = "";
      index += 1;
    } else if (ch === "\r") {
      if (stripped[index + 1] === "\n") {
        // CRLF 是正常换行,不触发覆写。
        lines.push(current);
        current = "";
        index += 2;
      } else {
        // 独立 CR:进度条重绘,当前行内容作废,后续文本从行首重来。
        current = "";
        index += 1;
      }
    } else if (ch === "\b") {
      current = dropLastCodePoint(current);
      index += 1;
    } else if (ch < " " && ch !== "\t") {
      // bell(0x07)与其它 C0 控制符:对剪贴板纯文本是噪声。
      index += 1;
    } else {
      current += ch;
      index += 1;
    }
  }
  lines.push(current);
  return lines.join("\n").replace(/\s+$/, "");
}
