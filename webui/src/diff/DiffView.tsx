/**
 * Diff 渲染(spec §9.2–§9.5,仅 unified 视图)。
 * 行内容一律 textContent/文本节点(JSX 文本节点等价),不走 innerHTML;
 * shiki 异步高亮,未完成或失败回退纯文本,不得改变文本与行数。
 *
 * 性能分级(吸收 ZCode 的降级纪律,补上它缺的行虚拟化):
 *  - 所有展开的文件走虚拟开窗:DOM 只挂可见行 ± overscan,万行文件不再是
 *    DOM 爆炸点(ZCode 富渲染整段无虚拟化,靠前置门槛兜底)。行高两档:
 *    不换行恒为 ROW_HEIGHT;换行 = ROW_HEIGHT × 视觉行数(估高打底 + 实测校正)。
 *  - 富渲染门槛:单文件 >1200 行或 >180k 字符 → 只停掉「每行都付」的词级 diff 与
 *    shiki,行集合仍全量交给虚拟开窗。ZCode 卡死的主因是富路径的同步解析 +
 *    主线程词级 diff(其 patchDiffPreview.ts 注释自证),把超限输入挡在富路径
 *    之外即可;它还需要 head/tail 截断是因为它没有虚拟化,我们不需要。
 *  - 词级 diff 惰性化:配对映射只做廉价扫描(parse.pairLines),Myers 代价
 *    「渲染到哪行付哪行」(WeakMap 缓存),展开时不再整文件一次算完。
 */
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack, type Component } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  fileContentChars,
  fileTotalLines,
  flattenFileRows,
  languageOf,
  pairLines,
  parseUnifiedDiff,
  trailingWhitespace,
  wordSegments,
  type DiffRow,
  type ParsedFile,
  type ParsedLine,
  type WordSegment,
} from "./parse";
import { resolvedTheme } from "../lib/theme";
import { STR } from "../lib/strings";
import { highlight, type Tokens } from "./highlight";
import { diffWrap } from "./wrap";
import { syntaxPackRef } from "../plugins/loader";

/** 超过该改动行数默认折叠(§9.5 大 diff);展开后走虚拟开窗,只挂可见行。 */
const BIG_DIFF_LINES = 400;
/** 富渲染门槛:任一超限即停掉词级 diff 与 shiki 这两项「每行都付」的代价。 */
const RICH_MAX_LINES = 1200;
const RICH_MAX_CHARS = 180_000;
/** 虚拟开窗的基础行高(px);必须与 CSS `.diff-row` 的 line-height 严格一致。
 *  换行模式下行盒高度是它的整数倍(折 N 行 = N×21),估高与实测都以它为基。 */
const ROW_HEIGHT = 21;
/** 行盒 gutter 总宽(行号 44 + 行号 44 + 符号 18)与内容列右 padding,
 *  估高的可见容量 = 容器宽 − 这两项;与 minWidth 的 `+106px` 保持同一套数字。 */
const GUTTER_PX = 106;
const CONTENT_PAD_RIGHT = 8;
const OVERSCAN = 12;

const STATUS_TEXT: Record<ParsedFile["status"], string> = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
  unknown: "变更",
};

/** 单行内容单元格:词级高亮 / shiki 彩色 token / 行尾空白与 ␍ 标记。 */
const LineContent: Component<{ line: ParsedLine; segments?: WordSegment[]; tokens?: { content: string; color?: string }[] }> = (props) => {
  const trailing = () => trailingWhitespace(props.line.text);
  const base = () => {
    const text = props.line.text;
    const trail = trailing();
    return trail != null ? text.slice(0, text.length - trail.length) : text;
  };
  return (
    <>
      <For each={props.segments} keyed={false}>
        {(segment) => (
          <Show when={segment().kind !== "same"} fallback={<>{segment().value}</>}>
            <span class={segment().kind === "added" ? "diff-word add" : "diff-word del"}>{segment().value}</span>
          </Show>
        )}
      </For>
      <Show when={props.segments == null && props.tokens != null}>
        <For each={props.tokens} keyed={false}>
          {(token) => (
            <Show when={token().color} fallback={<>{token().content}</>}>
              <span style={{ color: token().color ?? "" }}>{token().content}</span>
            </Show>
          )}
        </For>
      </Show>
      <Show when={props.segments == null && props.tokens == null}>{base()}</Show>
      <Show when={trailing() != null}>
        <span class="diff-ws">{trailing()}</span>
      </Show>
      <Show when={props.line.text.endsWith("\r")}>
        <span class="diff-cr">␍</span>
      </Show>
    </>
  );
};

/**
 * 虚拟开窗:只渲染 [scrollTop±overscan] 内的行,上下留白由容器总高撑出。
 * 不换行:行高恒定(等宽字体 + white-space:pre),scrollTop/21 直接定位,零测量。
 * 换行:行盒高度 = 21 × 实际折行数。估高用等宽列单位近似(只做滚动条基准),
 * 渲染后逐行实测回写 measured 校正;实测以行对象为键,文件切换天然失效。
 * 定位统一走前缀和二分,等高时与 floor(top/21) 逐点等价(语义不漂移)。
 */
const VirtualRows: Component<{ rows: DiffRow[]; row: (row: DiffRow) => JSX.Element; wrap?: boolean }> = (props) => {
  const renderRow = untrack(() => props.row);
  const wrap = (): boolean => props.wrap ?? false;
  let container: HTMLDivElement | undefined;
  const [view, setView] = createSignal({ start: 0, end: 0 });

  /* ---- 高度模型(仅换行档;不换行恒为 ROW_HEIGHT,原数学一字不动) ---- */
  // 实测高度以行对象为键;容量大改后整表重置(WeakMap 无 clear,换新表)。
  let measured = new WeakMap<DiffRow, number>();
  // 实测回写的版本号:WeakMap 对响应式不可见,靠它把 prefix 标脏。
  const [heightsRev, setHeightsRev] = createSignal(0);
  // 容器宽的响应式化:ResizeObserver → recalc 里更新,capacity 随之重算。
  const [paneWidth, setPaneWidth] = createSignal(0);
  let lastCapacity = -1;

  /** 每行列单位(等宽近似:CJK/全角 2 列、tab 记 4 列)——估高只需要单位总量。 */
  const rowUnits = createMemo(() => {
    const list = props.rows;
    const units = new Array<number>(list.length);
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index]!;
      const text = row.kind === "line" ? row.line.text : row.kind === "hunkhead" ? row.text : "";
      let total = 0;
      for (const char of text) total += char === "\t" ? 4 : char.charCodeAt(0) > 0x2e7f ? 2 : 1;
      units[index] = total;
    }
    return units;
  });

  /** 可见容量(列):容器宽 − gutter − 内容列右 padding,÷ 实测等宽 '0' 宽。 */
  const capacity = createMemo(() => {
    if (!wrap()) return 0;
    const width = paneWidth();
    if (width <= GUTTER_PX) return 0;
    const probe = document.createElement("span");
    probe.textContent = "0";
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(container!).font};`;
    container!.appendChild(probe);
    const chWidth = probe.getBoundingClientRect().width || 8;
    probe.remove();
    return Math.max(8, Math.floor((width - GUTTER_PX - CONTENT_PAD_RIGHT) / chWidth));
  });

  /** 行高前缀和:定位与总高的唯一事实源。heightsRev 是手动依赖
   *  (measured 的写响应式看不见,必须显式标脏);不换行时各档依赖都是常量。 */
  const prefix = createMemo(() => {
    heightsRev();
    const list = props.rows;
    const wrapNow = wrap();
    const units = wrapNow ? rowUnits() : null;
    const cap = wrapNow ? capacity() : 0;
    const acc = new Float64Array(list.length + 1);
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index]!;
      let height = ROW_HEIGHT;
      if (wrapNow) {
        const actual = measured.get(row);
        if (actual != null) height = actual;
        else if (cap > 0 && units != null) height = ROW_HEIGHT * Math.max(1, Math.ceil((units[index] ?? 0) / cap));
      }
      acc[index + 1] = (acc[index] ?? 0) + height;
    }
    return acc;
  });

  const recalc = (): void => {
    const el = container;
    if (el == null) return;
    if (el.clientWidth > 0) setPaneWidth(el.clientWidth);
    // 容量变了,旧实测折行数全部作废;±8 列容差挡住窗口微拖时的整表重置。
    const cap = untrack(capacity);
    if (cap !== lastCapacity) {
      if (lastCapacity >= 0 && Math.abs(cap - lastCapacity) >= 8) measured = new WeakMap();
      lastCapacity = cap;
    }
    const acc = prefix();
    const count = acc.length - 1;
    const top = el.scrollTop;
    // start = prefix[i] ≤ top 的最大 i(等高即 floor(top/21)),
    // end = prefix[i] ≥ bottom 的最小 i(等高即 ceil(bottom/21)),再各贴 overscan。
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (acc[mid]! <= top) lo = mid;
      else hi = mid - 1;
    }
    const start = lo;
    const bottom = top + el.clientHeight;
    lo = 0;
    hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (acc[mid]! < bottom) lo = mid + 1;
      else hi = mid;
    }
    const end = Math.min(count, lo + OVERSCAN);
    setView((previous) => previous.start === start && previous.end === end ? previous : { start, end });
    // 每次重算后排一次实测(下一帧,DOM 已提交):首屏、滚动、缩放、换行切换全覆盖。
    requestAnimationFrame(measure);
  };

  /** 渲染后逐行实测回写(下一帧,保证 DOM 已提交):估高只服务未到访区域,
   *  到访过的行以后永远用真高。回写只 bump 版本号,translate/总高走响应式。 */
  const measure = (): void => {
    if (!untrack(wrap)) return;
    const el = container;
    if (el == null) return;
    const winEl = el.querySelector<HTMLElement>(".diff-rows-window");
    if (winEl == null) return;
    const { start, end } = untrack(view);
    const list = untrack(() => props.rows);
    let changed = false;
    for (let index = start; index < end; index += 1) {
      const node = winEl.children[index - start] as HTMLElement | undefined;
      if (node == null) continue;
      const height = node.offsetHeight;
      if (height > 0 && measured.get(list[index]!) !== height) {
        measured.set(list[index]!, height);
        changed = true;
      }
    }
    if (changed) setHeightsRev((version) => version + 1);
  };

  /** 帧级合并:一次滚动事件只付一次重算;实测由 recalc 统一排到下一帧。 */
  let frame = 0;
  const onScroll = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      recalc();
    });
  };
  let observer: ResizeObserver | null = null;
  // ref 挂载点:元素创建即测量首屏 + 追踪容器尺寸变化。
  const attach = (el: HTMLDivElement): void => {
    container = el;
  };
  onSettled(() => {
    recalc();
    observer = new ResizeObserver(recalc);
    if (container != null) observer.observe(container);
    return () => {
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  });
  createEffect(() => props.rows.length, () => recalc());
  /** 等宽字体下的行宽估算(ch 单位,CJK/全角按 2 列、tab 按 4 列):给窗口一个
   *  稳定的 min-width,横向滚动条范围不随「当前渲染到哪些行」跳动。 */
  const minWidth = createMemo((): string => {
    // 精确列数要逐字符数,但不必每行都付:`units >= text.length` 恒成立(CJK 只加不减、
    // tab 记 4 列),所以比当前最优还短的行不可能翻盘,直接跳过。截断取消后这里
    // 面对的是整篇行集,少付一次内层循环就是少一次主线程长任务。
    let units = 0;
    for (const row of props.rows) {
      const text = row.kind === "line" ? row.line.text : row.kind === "hunkhead" ? row.text : "";
      if (text.length < units) continue;
      let lineUnits = 0;
      for (const char of text) lineUnits += char.charCodeAt(0) > 0x2e7f ? 2 : 1;
      lineUnits += (text.match(/\t/g)?.length ?? 0) * 3;
      if (lineUnits > units) units = lineUnits;
    }
    return `calc(${units}ch + ${GUTTER_PX}px)`;
  });
  return (
    <div class={{ "diff-scroll": true, "diff-wrap": wrap() }} ref={attach} onScroll={onScroll}>
      <div class="diff-rows" style={{ height: `${prefix()[prefix().length - 1]}px` }}>
        <div
          class="diff-rows-window"
          style={{
            transform: `translateY(${prefix()[view().start]}px)`,
            width: wrap() ? "100%" : undefined,
            "min-width": wrap() ? undefined : minWidth(),
          }}
        >
          <For each={props.rows.slice(view().start, view().end)}>
            {(row) => renderRow(row)}
          </For>
        </div>
      </div>
    </div>
  );
};

export const DiffFileView: Component<{ file: ParsedFile; hidePath?: boolean }> = (props) => {
  const file = () => props.file;
  const rows = createMemo(() => flattenFileRows(file()));
  const totalLines = () => fileTotalLines(file());
  // 富渲染门槛:超限只砍「每行的代价」——词级 diff 与 shiki 都不跑。
  // 行集合不再做 head/tail 截断:两条路径都走固定行高虚拟开窗,DOM 里永远只有
  // 可见行 ±overscan,截断既省不下节点也省不下堆,只是把中段的行藏起来。
  // (ZCode 需要前置门槛是因为它富渲染整段无虚拟化;我们不是那个形状。)
  const rich = () => totalLines() <= RICH_MAX_LINES && fileContentChars(file()) <= RICH_MAX_CHARS;
  const [expanded, setExpanded] = createSignal(untrack(() => totalLines() <= BIG_DIFF_LINES));

  // 词级配对映射:廉价扫描(O(行数),无 Myers);真正的 diff 在渲染时逐行结算。
  const EMPTY_PAIRS = new Map<ParsedLine, ParsedLine>();
  const pairMap = createMemo(() => {
    if (!expanded() || !rich()) return EMPTY_PAIRS;
    const map = new Map<ParsedLine, ParsedLine>();
    for (const hunk of file().hunks) for (const [line, pair] of pairLines(hunk)) map.set(line, pair);
    return map;
  });
  // Myers 结果缓存:渲染到哪行算哪行,一对 del/add 共享一次计算结果。
  const segmentsCache = new WeakMap<ParsedLine, WordSegment[]>();
  const segmentsFor = (line: ParsedLine): WordSegment[] | undefined => {
    const cached = segmentsCache.get(line);
    if (cached != null) return cached;
    const pair = pairMap().get(line);
    if (pair == null) return undefined;
    const segments = wordSegments(
      line.t === "del" ? line.text : pair.text,
      line.t === "del" ? pair.text : line.text,
    );
    const delSegments = line.t === "del" ? segments.del : segments.add;
    const addSegments = line.t === "del" ? segments.add : segments.del;
    segmentsCache.set(pair, addSegments);
    segmentsCache.set(line, delSegments);
    return delSegments;
  };

  const [tokenMap, setTokenMap] = createSignal<WeakMap<ParsedLine, Tokens[number]> | null>(null);
  // 折叠时不拼整篇内容字符串、不跑 shiki:一个大文件的 token 数组是回合数据
  // 本身的数十倍,收起的状态下常驻内存毫无意义(展开时再高亮,§9.4 允许纯文本回退)。
  createEffect(
    () => {
      if (!expanded() || !rich()) return null;
      const lines: ParsedLine[] = [];
      for (const hunk of file().hunks) for (const line of hunk.lines) lines.push(line);
      const content = lines.map((line) => line.text).join("\n");
      const lang = languageOf(file().path);
      // 主题进依赖:切亮/暗或换语法主题包(含 rev 热更)都重算高亮。
      return { lang, content, lines, theme: resolvedTheme(), syntax: syntaxPackRef() };
    },
    (job) => {
      if (job == null || job.lang == null) return;
      const { lang, content, lines, theme, syntax } = job;
      let disposed = false;
      void (async () => {
        try {
          const tokens = await highlight(content, lang, theme, syntax);
          if (disposed) return;
          const map = new WeakMap<ParsedLine, Tokens[number]>();
          // codeToTokens 按换行切 token 行,与 lines 顺序一一对应;防御性兜底长度差。
          for (let index = 0; index < lines.length && index < tokens.length; index += 1) {
            map.set(lines[index]!, tokens[index]!);
          }
          setTokenMap(map);
        } catch {
          // 高亮失败回退纯文本(§9.4)。
        }
      })();
      // apply 阶段不是反应式上下文:`onCleanup` 在这里注册等于永不执行(NO_OWNER_CLEANUP),
      // 返回清理函数才会挂到本 effect 的下一次运行/销毁上 —— 否则收起分支后,迟到的
      // shiki 结果仍会写进已经废弃的 signal。
      return (): void => {
        disposed = true;
      };
    },
  );

  const renderRow = (row: DiffRow): JSX.Element => {
    if (row.kind === "omit") {
      return <div class="diff-row omit">{`…… 省略 ${row.count} 行`}</div>;
    }
    if (row.kind === "hunkhead") {
      return <div class="diff-row hunkhead">{row.text}</div>;
    }
    const line = row.line;
    return (
      <div class={`diff-row ${line.t}`}>
        <span class="diff-no">{line.oldNo ?? ""}</span>
        <span class="diff-no">{line.newNo ?? ""}</span>
        <span class="diff-sign">{line.t === "add" ? "+" : line.t === "del" ? "−" : " "}</span>
        <span class="diff-content">
          <LineContent
            line={line}
            segments={rich() ? segmentsFor(line) : undefined}
            tokens={rich() ? tokenMap()?.get(line) : undefined}
          />
        </span>
      </div>
    );
  };

  return (
    <div class="diff-file">
      {/* data-copy-path 给右键菜单取「复制路径」的值(见 ui/contextMenu.tsx);
          隐藏路径时不挂,免得复制到界面上看不见的东西。 */}
      <button
        type="button"
        class="diff-file-head"
        aria-expanded={expanded() ? "true" : "false"}
        onClick={() => setExpanded(!expanded())}
        title={props.hidePath ? undefined : file().path}
        data-copy-path={props.hidePath ? undefined : file().path}
      >
        <span class="diff-path">
          <Show when={!props.hidePath} fallback="差异">
          <Show when={file().oldPath != null}>
            {file().oldPath} → {file().path}
          </Show>
          <Show when={file().oldPath == null}>{file().path}</Show>
          </Show>
        </span>
        <span class="diff-stat">
          <b class="diff-stat-add">+{file().stats.add}</b>
          <b class="diff-stat-del">−{file().stats.del}</b>
          <span class="diff-status">{STATUS_TEXT[file().status]}</span>
        </span>
      </button>
      <Show when={expanded()}>
        <Show when={file().binary} fallback={<VirtualRows rows={rows()} row={renderRow} wrap={diffWrap()} />}>
          <div class="diff-binary">{STR.binaryChanged ?? "二进制文件已变更"}</div>
        </Show>
      </Show>
    </div>
  );
};

export const DiffList: Component<{ diffText: string; hideSingleFilePath?: boolean }> = (props) => {
  const files = createMemo(() => {
    try {
      return parseUnifiedDiff(props.diffText);
    } catch {
      return [] as ParsedFile[];
    }
  });
  return (
    <Show when={files().length > 0}>
      <div class="diff-list">
        <For each={files()}>{(file) => <DiffFileView file={file} hidePath={props.hideSingleFilePath && files().length === 1} />}</For>
      </div>
    </Show>
  );
};
