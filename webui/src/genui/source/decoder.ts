/**
 * ContentDecoder(spec-generative-ui-runtime §6):在 Markdown 之前把 assistant
 * 正文分帧为 MarkdownPart / UiSourcePart。
 *
 * 规则(原型实现,对齐 spec §6.1/§6.2):
 *  - 只有顶层(≤3 空格缩进)、info 串恰好为 `qaqh-ui v=0.1 format=tsx|jsonl`
 *    的反引号围栏才有 UI 语义;普通 ```tsx / ```jsonl 仍是代码,引用块与
 *    4 空格缩进代码里的同名围栏一律不触发。
 *  - 围栏按 CommonMark 反引号长度配对:关门必须 ≥ 开门长度且不带 info;
 *    展示语法本身时用更长的外层普通围栏即可,不会被误编译。
 *  - 流式期间「可能的围栏头」先缓冲(holdback),不能先绘成 Markdown 再销毁;
 *    判定不出来的尾行(如裸 ``` 或 info 前缀)只吞最多一行。
 *  - 本模块是纯函数:每次对全文重扫。线性单趟,无回溯;正规化输入假设 LF。
 *  - UI 源码是**不可信文本**:这里只分帧与提取展示字段(surfaceId/fallback),
 *    不编译、不执行;编译与准入是后续 compiler/Gateway 的事(spec §7/§11)。
 */

export type UiFormat = "tsx" | "jsonl";
/** 围栏协议版本:0.1 = v0.1 IR 渲染器;0.2 = A2UI 消息流渲染器(SurfaceView2)。 */
export type UiVersion = "0.1" | "0.2";

export type MarkdownPart = { kind: "markdown"; text: string };
export type UiSourcePart = {
  kind: "ui";
  version: UiVersion;
  format: UiFormat;
  /** 围栏体内源码(不含围栏行本身)。 */
  source: string;
  /** false = 围栏未闭合(流式生成中或缺结尾);缺结尾永远不得伪造成 seal。 */
  sealed: boolean;
  surfaceId?: string;
  fallback?: string;
};
export type ContentPart = MarkdownPart | UiSourcePart;

const UI_INFOS = [
  "qaqh-ui v=0.1 format=tsx",
  "qaqh-ui v=0.1 format=jsonl",
  "qaqh-ui v=0.2 format=tsx",
  "qaqh-ui v=0.2 format=jsonl",
] as const;
const FENCE_OPEN = /^ {0,3}(`{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;
/** holdback 只吞一行;合法 info 最长 26 字符,64 已是宽裕上限。 */
const HOLDBACK_MAX_LINE = 64;
/** jsonl 探测 surface.open 时最多看的行数。 */
const JSONL_PROBE_LINES = 50;

function uiFormatOf(info: string): { version: UiVersion; format: UiFormat } | null {
  const tokens = info.trim().split(/\s+/);
  if (tokens[0] !== "qaqh-ui" || tokens.length > 3) return null;
  let version: UiVersion | null = null;
  let format: UiFormat | null = null;
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) return null;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "v" && (value === "0.1" || value === "0.2")) version = value;
    else if (key === "format" && (value === "tsx" || value === "jsonl")) format = value;
    else return null;
  }
  return version != null && format != null ? { version, format } : null;
}

/**
 * 不完整尾行是否仍可能长成 qaqh-ui 围栏头:
 *  - 反引号还没长够 3 个(后面可能续成 ```qaqh-ui);
 *  - 或 info 串为空 / 仍是某个合法 info 的前缀(长度未定,两头都可能)。
 */
function isHoldbackCandidate(line: string): boolean {
  if (line.length > HOLDBACK_MAX_LINE) return false;
  const match = /^ {0,3}(`+)(.*)$/.exec(line);
  if (match == null) return false;
  const rest = match[2] ?? "";
  if (rest.includes("`")) return false;
  if (match[1]!.length < 3) return rest.trim() === "";
  const info = rest.trim();
  return info === "" || UI_INFOS.some((valid) => valid.startsWith(info));
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
}

/** 从源码提取展示字段;纯正则/逐行 JSON,失败即缺省,不影响分帧。 */
function describe(format: UiFormat, source: string): { surfaceId?: string; fallback?: string } {
  if (format === "tsx") {
    const id = /ui\.surface\(\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1];
    const fallback = /fallback:\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1];
    return {
      surfaceId: id ? unescape(id) : undefined,
      fallback: fallback ? unescape(fallback) : undefined,
    };
  }
  for (const raw of source.split("\n").slice(0, JSONL_PROBE_LINES)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line) as { op?: string; surface?: string; fallback?: string };
      if (record.op === "surface.open") {
        return {
          surfaceId: typeof record.surface === "string" && record.surface ? record.surface : undefined,
          fallback: typeof record.fallback === "string" && record.fallback ? record.fallback : undefined,
        };
      }
    } catch { /* 生成中的半截行:跳过 */ }
  }
  return {};
}

type TailState = "md" | "normalFence" | "ui";

interface ScanResult {
  /** 扫描结束时的状态:holdback 只在顶层 md 上有意义。 */
  tail: TailState;
  /** 并入尾行(或收尾)后的完整分帧结果。 */
  finish(pendingLine: string | null): ContentPart[];
}

function scan(lines: string[]): ScanResult {
  const parts: ContentPart[] = [];
  let md: string[] = [];
  let ui: { version: UiVersion; format: UiFormat; source: string[]; openLength: number } | null = null;
  let fenceLength = 0; // 普通(非 UI)围栏的开门长度;0 = 不在围栏内
  const flushMd = (into: ContentPart[]): void => {
    // 空行(如仅 "\n")拼出来是空串:不产 part,与增量视图/渲染层(Match 跳过空文本)同约。
    const joined = md.join("\n");
    if (joined !== "") into.push({ kind: "markdown", text: joined });
    md = [];
  };
  for (const line of lines) {
    if (ui != null) {
      const close = FENCE_CLOSE.exec(line);
      if (close != null && close[1]!.length >= ui.openLength) {
        const source = ui.source.join("\n");
        parts.push({ kind: "ui", version: ui.version, format: ui.format, source, sealed: true, ...describe(ui.format, source) });
        ui = null;
      } else {
        ui.source.push(line);
      }
      continue;
    }
    if (fenceLength > 0) {
      const close = FENCE_CLOSE.exec(line);
      if (close != null && close[1]!.length >= fenceLength) fenceLength = 0;
      md.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open != null && !(open[2] ?? "").includes("`")) {
      const parsed = uiFormatOf(open[2]!);
      if (parsed != null) {
        flushMd(parts);
        ui = { version: parsed.version, format: parsed.format, source: [], openLength: open[1]!.length };
        continue;
      }
      md.push(line);
      fenceLength = open[1]!.length;
      continue;
    }
    md.push(line);
  }
  const tail: TailState = ui != null ? "ui" : fenceLength > 0 ? "normalFence" : "md";
  return {
    tail,
    finish(pendingLine: string | null): ContentPart[] {
      const result = parts.slice();
      if (ui != null) {
        const close = pendingLine != null ? FENCE_CLOSE.exec(pendingLine) : null;
        const sealed = close != null && close[1]!.length >= ui.openLength;
        if (!sealed && pendingLine != null) ui.source.push(pendingLine);
        const source = ui.source.join("\n");
        result.push({ kind: "ui", version: ui.version, format: ui.format, source, sealed, ...describe(ui.format, source) });
      } else {
        if (pendingLine != null) md.push(pendingLine);
        flushMd(result);
      }
      return result;
    },
  };
}

/**
 * 全量分帧。`options.final = true`(流已结束/非流式历史)时不再 holdback——
 * 不完整的尾行按字面渲染,不能把用户可见文本吞掉。
 */
export function splitContentParts(text: string, options: { final?: boolean } = {}): ContentPart[] {
  if (!text.includes("`")) {
    // 快路径与扫描路径同行模型:尾部 \n 的切分伪影不算内容;全空(如仅 "\n")
    // 不产 part——空 markdown 在渲染层本来就被 Match 跳过。
    if (text === "") return [];
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return body === "" ? [] : [{ kind: "markdown", text: body }];
  }
  const lines = text.split("\n");
  // 尾部 \n 的切分伪影(末尾空串)不是真实行,统一丢弃——与增量水位封装同行模型。
  if (text.endsWith("\n")) lines.pop();
  const pending = !(options.final ?? false) && !text.endsWith("\n") ? lines.pop()! : null;
  const state = scan(lines);
  if (pending != null && state.tail === "md" && isHoldbackCandidate(pending)) {
    return state.finish(null); // 缓冲该行:既不当 Markdown,也不提前开 UI
  }
  return state.finish(pending);
}

/* ── 增量水位封装 ──────────────────────────────────────────────────────────
 * 纯函数每次对全文重扫(O(n)/次,流式全程 O(n²))。createContentDecoder
 * 维护「已确认前缀」水位:只对新完成的行推进状态机,live 行(末尾不完整行)
 * 每次以纯视图方式并入结果,绝不写入已确认状态。
 *
 * 语义契约:任何前缀上 push(text[, final]) 的输出与 splitContentParts(
 * 同前缀,同 final)深相等;前缀被改写(非 startsWith)时回退全量重扫并计数,
 * 因此调用方无需关心文本是否真的是流式追加。
 * ──────────────────────────────────────────────────────────────────────── */

export type ContentDecoderStats = { pushes: number; rescans: number; scannedChars: number };

type Machine = {
  fenceLength: number;
  ui: { version: UiVersion; format: UiFormat; source: string[]; openLength: number } | null;
  md: string[];
};

const freshMachine = (): Machine => ({ fenceLength: 0, ui: null, md: [] });

export function createContentDecoder(): {
  push(text: string, final?: boolean): ContentPart[];
  stats(): ContentDecoderStats;
} {
  let confirmed = "";
  let machine = freshMachine();
  let emitted: ContentPart[] = [];
  const stats: ContentDecoderStats = { pushes: 0, rescans: 0, scannedChars: 0 };

  const flushMd = (into: ContentPart[]): void => {
    const joined = machine.md.join("\n");
    if (joined !== "") into.push({ kind: "markdown", text: joined });
    machine.md = [];
  };

  /** 只吃完整行;live 行永远不走这里。 */
  const feed = (line: string): void => {
    if (machine.ui != null) {
      const close = FENCE_CLOSE.exec(line);
      if (close != null && close[1]!.length >= machine.ui.openLength) {
        const source = machine.ui.source.join("\n");
        emitted.push({ kind: "ui", version: machine.ui.version, format: machine.ui.format, source, sealed: true, ...describe(machine.ui.format, source) });
        machine.ui = null;
      } else {
        machine.ui.source.push(line);
      }
      return;
    }
    if (machine.fenceLength > 0) {
      const close = FENCE_CLOSE.exec(line);
      if (close != null && close[1]!.length >= machine.fenceLength) machine.fenceLength = 0;
      machine.md.push(line);
      return;
    }
    const open = FENCE_OPEN.exec(line);
    if (open != null && !(open[2] ?? "").includes("`")) {
      const parsed = uiFormatOf(open[2]!);
      if (parsed != null) {
        flushMd(emitted);
        machine.ui = { version: parsed.version, format: parsed.format, source: [], openLength: open[1]!.length };
        return;
      }
      machine.md.push(line);
      machine.fenceLength = open[1]!.length;
      return;
    }
    machine.md.push(line);
  };

  const reset = (): void => {
    machine = freshMachine();
    emitted = [];
    confirmed = "";
    stats.rescans += 1;
  };

  const push = (text: string, final = false): ContentPart[] => {
    stats.pushes += 1;
    if (!text.startsWith(confirmed)) reset();
    // 水位只推进到最后一个 \n:live 行(不完整尾行)的字符不进已确认集,
    // 它长成完整行后才在后续 push 里被喂进状态机。
    const nl = text.lastIndexOf("\n");
    const complete = final || nl >= 0 ? (final ? text : text.slice(0, nl + 1)) : "";
    const rest = complete.slice(confirmed.length);
    const raw = final ? "" : text.slice(complete.length);
    const live = raw === "" ? null : raw;
    stats.scannedChars += rest.length;
    if (rest !== "") {
      // 行模型与纯函数对齐:rest 以 \n 结尾时,切分产生的末尾空串是伪影,不喂。
      const lines = rest.split("\n");
      if (rest.endsWith("\n")) lines.pop();
      for (const line of lines) feed(line!);
    }
    confirmed = complete;

    if (final) {
      // 流结束:ui 未闭合按未 seal 收尾,其余 flush Markdown;结果并入已确认
      // 集(final 之后不会再有增量),重复 push 幂等。
      if (machine.ui != null) {
        const source = machine.ui.source.join("\n");
        emitted.push({ kind: "ui", version: machine.ui.version, format: machine.ui.format, source, sealed: false, ...describe(machine.ui.format, source) });
        machine.ui = null;
      } else {
        flushMd(emitted);
      }
      return emitted.slice();
    }

    // live 行:纯视图,不落状态。
    const result = emitted.slice();
    if (machine.ui != null) {
      const close = live != null ? FENCE_CLOSE.exec(live) : null;
      const sealed = close != null && close[1]!.length >= machine.ui.openLength;
      // 「还没有源码」看行数而不是 join 结果:围栏头后的空行让 source 变 "" 但行数 > 0,
      // 此时 live 行要追加(否则空行被 live 替换吞掉,与纯函数逐行模型不一致)。
      const hasSource = machine.ui.source.length > 0;
      let source = machine.ui.source.join("\n");
      if (live != null && !sealed) source = hasSource ? `${source}\n${live}` : live;
      result.push({ kind: "ui", version: machine.ui.version, format: machine.ui.format, source, sealed, ...describe(machine.ui.format, source) });
      return result;
    }
    const mdTail = live == null || machine.fenceLength > 0 || !isHoldbackCandidate(live);
    const mdText = live == null
      ? machine.md.join("\n")
      : machine.md.length === 0
        ? (mdTail ? live : "")
        : mdTail ? `${machine.md.join("\n")}\n${live}` : machine.md.join("\n");
    if (mdText !== "") result.push({ kind: "markdown", text: mdText });
    return result;
  };

  return { push, stats: () => ({ ...stats }) };
}
