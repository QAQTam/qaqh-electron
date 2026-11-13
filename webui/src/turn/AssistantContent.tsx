/**
 * AssistantContent：text segment 的呈现入口。
 *
 * 生成式 UI 走结构化 visualize 工具段（widget/WidgetMount.tsx 挂 host.ts 沙箱
 * iframe）——正文不再承载 widget marker，这里只做 Markdown 流式呈现。
 */
import { type Component } from "solid-js";
import { Markdown } from "../markdown/Markdown";

export const AssistantContent: Component<{
  text: () => string;
  revision?: string | number;
  streaming?: boolean;
}> = (props) => (
  <Markdown text={props.text} revision={props.revision} streaming={props.streaming} />
);