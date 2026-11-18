/**
 * AssistantContent：text segment 的呈现入口。
 *
 * 生成式 UI 走结构化 visualize 工具段（widget/WidgetMount.tsx 挂 host.ts 沙箱
 * iframe）——正文不再承载 widget marker，这里只做 Markdown 流式呈现。
 *
 * copyText：悬停浮出「复制原文」——拖选渲染结果会丢表格结构，复制原始
 * markdown 才保真；空串（懒加载占位，由 TurnView 判定）时按钮不渲染。
 */
import { createSignal, Show, type Component } from "solid-js";
import IconCopy from "~icons/lucide/copy";
import { STR } from "../lib/strings";
import { Markdown } from "../markdown/Markdown";

export const AssistantContent: Component<{
  text: () => string;
  revision?: string | number;
  streaming?: boolean;
  copyText?: () => string;
}> = (props) => {
  const [copied, setCopied] = createSignal(false);
  const source = () => (props.copyText ?? props.text)();
  return (
    <div class="answer-body">
      <Markdown text={props.text} revision={props.revision} streaming={props.streaming} />
      <Show when={source().length > 0}>
        <button type="button" class="ghost-mini answer-copy" title={STR.copy} onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(source()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
        }}>{copied() ? STR.copied : STR.copy}<IconCopy /></button>
      </Show>
    </div>
  );
};
