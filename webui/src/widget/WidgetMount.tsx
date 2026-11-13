/**
 * widget-directive C2：visualize tool call 的渲染入口。
 *
 * 模型经结构化 `visualize` 工具声明 widget（args 仅 path/title/mode，无 PUA，
 * 免疫云传输隐形字符清洗）。本组件从 ToolStep.argsJson 产出与旧 marker 同形的
 * `div.qqh-widget-mount[data-qqh-*]`，交给 host.ts 水合 iframe 沙箱——渲染/桥/
 * 状态快照链路完全复用，仅指令来源从正文 marker 换成工具段。
 */
import { createEffect, type Component } from "solid-js";

import type { ToolStep } from "../session/types";
import { hydrateWidgetMounts, type WidgetHostContext } from "./host";

interface VisualizeArgs {
  path?: string;
  title?: string;
  mode?: string;
}

export const WidgetMount: Component<{ step: ToolStep; ctx: WidgetHostContext }> = (props) => {
  let wrapper: HTMLDivElement | undefined;
  const args = (): VisualizeArgs => {
    try {
      const parsed: unknown = JSON.parse(props.step.argsJson ?? "{}");
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as VisualizeArgs)
        : {};
    } catch {
      return {};
    }
  };
  // 参数流式吐完即水合；host 侧 dataset 幂等，重复调用不会重挂。
  createEffect(
    () => args().path,
    (path) => { if (path && wrapper) hydrateWidgetMounts(wrapper, props.ctx); },
  );
  return (
    <div ref={wrapper} class="qqh-widget-directive">
      <div
        class="qqh-widget-mount"
        data-qqh-path={args().path ?? ""}
        data-qqh-title={args().title ?? ""}
        data-qqh-mode={args().mode}
      />
    </div>
  );
};