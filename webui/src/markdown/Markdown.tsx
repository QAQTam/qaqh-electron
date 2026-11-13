/**
 * 流式 Markdown 块组件(spec §7.5):闭合块渲染一次直接 append(真实 DOM 只追加,
 * 不重建),未闭合尾块**按帧**重绘;单帧绘制超预算时自动退回限频。
 *
 * 两层节奏(纯表现层,不改数据、不改 store):
 *  - `reveal`:v3 的 `message_delta.text` 是**累计全文替换**,不是增量片段。
 *    `target` 是真相,`shown` 是它的前缀游标;一次突发(几百字/resync 后整块
 *    落地)直接画就是「蹦」,所以按帧把 backlog 摊平。小 backlog 直接追平,
 *    正常逐 token 流零额外延迟。
 *  - 预算自适应:尾块形状决定代价 —— 段落/代码每帧画得起,未闭合表格画不起。
 *    实测见 PAINT_BUDGET_MS 注释;超预算就退回 THROTTLE_MS,不再一刀切 120ms
 *    把观感钉在 ~8fps。
 *
 * 刻意**不**恢复早期 store 的 `pendingFragments`/rAF 合帧:那是「增量片段
 * append」时代的机制,在累计全文语义下会重复拼接正文,还会打乱 v3 的
 * `watermark = event.seq` 与封口顺序。后端没有任何推送节流,削峰只需这一层。
 *
 * `revision` 变化(消息正文被整体替换/重置)时清空缓存整体重渲染。
 */
import { createEffect, onSettled, type Component } from "solid-js";
import { splitBlocks } from "./split";
import { renderMarkdownHtml } from "./render";
import { patchMarkdown } from "./patch";
import { createPaintScheduler } from "./paint";
import { hydrateWidgetMounts, type WidgetHostContext } from "../widget/host";

/**
 * 单帧同步绘制预算(ms)。120Hz 一帧 8.3ms,留一半给布局与绘制。
 * 夹具实测(尾块持续增长 120 帧):段落 p50 0.6 / max 1.8ms;未闭合代码块
 * p50 0.3 / max 2.7ms;未闭合表格 p50 5.9 / p95 11.7 / max 15.5ms。
 */
const PAINT_BUDGET_MS = 4;
/** 超预算时的退回限频(ms)。 */
const THROTTLE_MS = 120;
/** 突发摊到几帧内露完:6 帧 ≈ 50ms@120Hz,连得上且不把延迟堆成长尾。 */
const REVEAL_FRAMES = 6;
/** 单帧到达量不超过此值视为正常逐 token 流,直接追平;也作为突发时的最小推进步长。 */
const REVEAL_MIN_CHARS = 24;
/** 落后超过这个字符量说明不是实时流(v3 resync / 快照 / 切标签回来),直接全量显示。 */
const CATCH_UP_CHARS = 4_000;

function addCodeBlockHeaders(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (pre.parentElement?.classList.contains("md-code-block")) continue;
    const wrapper = root.ownerDocument.createElement("div");
    wrapper.className = "md-code-block";
    const head = root.ownerDocument.createElement("div");
    head.className = "md-code-head";
    const label = root.ownerDocument.createElement("span");
    label.textContent = "代码";
    const button = root.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "md-copy-code";
    button.dataset.copyCode = "true";
    button.setAttribute("aria-label", "复制代码");
    button.title = "复制代码";
    button.textContent = "复制";
    head.append(label, button);
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.append(head, pre);
  }
}

export const Markdown: Component<{
  text: () => string;
  revision?: string | number;
  streaming?: boolean;
  /** widget-directive：提供后正文 marker 水合成 iframe（assistant 消息专用）。 */
  widgetCtx?: WidgetHostContext;
}> = (props) => {
  let host!: HTMLDivElement;
  let tail: HTMLDivElement | undefined;
  let sealedOffset = 0;
  let tailSource = "";
  let tailHtml = "";
  let plainText: Text | null = null;
  let isStreaming = true;

  let target = ""; // store 里的累计全文(真相)
  let shown = 0; // 已露出的字符数(表现);v3 累计全文天然是 target 的前缀
  let reduceMotion = false;
  let revisionKey: string | number = 0;
  let lastCostMs = 0;
  let earliestAt = 0;
  let painter!: ReturnType<typeof createPaintScheduler>;

  const reset = (): void => {
    sealedOffset = 0;
    tailSource = "";
    tailHtml = "";
    plainText = null;
    while (host.firstChild && host.firstChild !== tail) host.firstChild.remove();
    tail?.replaceChildren();
  };

  const sealInto = (html: string): void => {
    const node = document.createElement("div");
    node.className = "md-block";
    node.innerHTML = html; // 已净化输出
    addCodeBlockHeaders(node);
    if (props.widgetCtx) hydrateWidgetMounts(node, props.widgetCtx);
    host.insertBefore(node, tail!);
  };

  /**
   * 绘制露出前缀,并记下这次花了多久(下一帧的节奏据此决定)。
   * `finish` = 封口 / rAF 暂停兜底 / 全量替换:必须一次画完且不再排帧。
   */
  const draw = (finish = false): void => {
    const startedAt = performance.now();
    const backlog = target.length - shown;
    // 比例追赶(而非恒定字/秒):后端多快都能收敛,不会把用户钉在长尾等待。
    // 小 backlog 直接追平,避免旧版「逐 token 流也被拖成 1 字/帧」的毛病;
    // 超大 backlog 是快照/resync/回切,不是实时流,没必要动画。
    if (finish || reduceMotion || backlog <= REVEAL_MIN_CHARS || backlog > CATCH_UP_CHARS) {
      shown = target.length;
    } else {
      shown += Math.max(REVEAL_MIN_CHARS, Math.ceil(backlog / REVEAL_FRAMES));
    }
    const text = shown >= target.length ? target : target.slice(0, shown);
    // 已闭合前缀永远不再扫描;工作量只随当前尾块增长。
    const suffix = text.slice(sealedOffset);
    const blocks = splitBlocks(suffix);
    // 闭合除尾块之外的新增块:内容 append-only,不会再变——
    // 渲染一次直接写进 DOM,不再缓存 HTML 字符串(缓存等于把整篇输出存两遍)。
    let consumed = 0;
    for (let index = 0; index < blocks.length - 1; index += 1) {
      const block = blocks[index]!;
      sealInto(renderMarkdownHtml(block.content));
      consumed = suffix.indexOf(block.content, consumed) + block.content.length;
    }
    sealedOffset += consumed;
    const tailBlock = blocks[blocks.length - 1];
    const source = tailBlock?.content ?? "";
    if (tail && source !== tailSource) {
      tailSource = source;
      // 单行普通段落用稳定 text node;每个 token 不需要销毁/重建 <p>。
      if (source.trim() !== "" && !/[\n\r\\`*_~\[\]<>#|&]/.test(source)
        && !/^(?: {4}|\t)|^\s*(?:[-+]|\d+[.)])\s|^\s*-{3,}\s*$/.test(source)
        && !/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(source)) {
        if (plainText == null) {
          const paragraph = document.createElement("p");
          plainText = document.createTextNode(source);
          paragraph.append(plainText);
          tail.replaceChildren(paragraph);
        } else plainText.data = source;
        tailHtml = "";
      } else {
        const html = source ? renderMarkdownHtml(source) : "";
        if (plainText != null || html !== tailHtml) patchMarkdown(tail, html);
        plainText = null;
        tailHtml = html;
      }
    }
    if (!isStreaming && tail != null) {
      addCodeBlockHeaders(tail);
      if (props.widgetCtx) hydrateWidgetMounts(tail, props.widgetCtx);
    }
    lastCostMs = performance.now() - startedAt;
    earliestAt = performance.now() + (lastCostMs > PAINT_BUDGET_MS ? THROTTLE_MS : 0);
    // 还有没露完的突发就带着新算出的 deadline 再排一帧(每次绘制仍追最新全文)。
    if (shown < target.length && !finish) painter.schedule(earliestAt);
  };

  painter = createPaintScheduler((finish) => draw(finish));

  let primed = false; // 首帧不动画:静态文本块不该有「从零长出来」的入场
  const copyTimers = new Set<number>();

  createEffect(
    () => [props.text(), props.revision ?? 0, props.streaming ?? true] as const,
    ([text, revision, streaming]) => {
      // 全量替换(checkpoint / 权威快照重写)或换块(revision 变了):按真相整块画。
      const wholesale = !primed || revision !== revisionKey || (text !== target && !text.startsWith(target));
      isStreaming = streaming;
      target = text;
      revisionKey = revision;
      if (wholesale) {
        primed = true;
        shown = text.length;
        painter.cancel();
        reset();
        draw(true); // checkpoint / revision / 回撤:整块落地,不做入场动画
        return;
      }
      if (shown > text.length) shown = text.length;
      if (!streaming) {
        painter.flush(); // 封口立即补齐,不留半截尾巴
        return;
      }
      painter.schedule(earliestAt);
    },
  );

  onSettled(() => {
    const motion = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const updateMotion = (): void => { reduceMotion = motion?.matches ?? false; };
    const onClick = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLButtonElement>("button[data-copy-code]");
      const code = button?.closest(".md-code-block")?.querySelector("pre code");
      if (button == null || code == null || navigator.clipboard?.writeText == null) return;
      void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
        if (!button.isConnected) return;
        button.textContent = "已复制";
        button.setAttribute("aria-label", "已复制代码");
        const timer = window.setTimeout(() => {
          copyTimers.delete(timer);
          if (button.isConnected) {
            button.textContent = "复制";
            button.setAttribute("aria-label", "复制代码");
          }
        }, 1200);
        copyTimers.add(timer);
      }).catch(() => {});
    };
    updateMotion();
    motion?.addEventListener?.("change", updateMotion);
    host.addEventListener("click", onClick);
    return () => {
      motion?.removeEventListener?.("change", updateMotion);
      host.removeEventListener("click", onClick);
      for (const timer of copyTimers) window.clearTimeout(timer);
      copyTimers.clear();
      painter.cancel();
    };
  });

  return (
    <div class="md-host" ref={host}>
      <div class="md-tail" ref={tail} />
    </div>
  );
};
