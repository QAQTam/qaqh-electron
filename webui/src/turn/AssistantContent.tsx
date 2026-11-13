/**
 * AssistantContent：text segment 的呈现入口。
 *
 * 生成式 UI 走 widget-directive 正文 marker 协议（widget/directive.ts 解析、
 * widget/host.ts 水合沙箱 iframe）——这里只做 Markdown 流式呈现与 widget
 * 宿主上下文的透传，不再分帧、不再编译。
 */
import { type Component } from "solid-js";
import { Markdown } from "../markdown/Markdown";
import type { WidgetHostContext } from "../widget/host";

export const AssistantContent: Component<{
  text: () => string;
  revision?: string | number;
  streaming?: boolean;
  widgetCtx?: WidgetHostContext;
}> = (props) => (
  <Markdown text={props.text} revision={props.revision} streaming={props.streaming} widgetCtx={props.widgetCtx} />
);
