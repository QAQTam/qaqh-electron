/**
 * AssistantContent(spec-generative-ui-runtime §12):text segment 的呈现入口。
 * Step.text 仍是权威真相;这里只是把它的**派生视图**按 ContentDecoder 的分帧
 * 结果摆出来——Markdown 部分复用既有流式 Markdown,UI 部分在原型阶段渲染为
 * 受限占位卡(不编译、不执行源码,spec D06/D08)。
 *
 * 渲染纪律:行按"位置令牌"复用(For + 原始数下标,按值缓存视图)——流式期间
 * 分帧结果每个增量都是新数组,若直接 For objects 会让 Markdown 每个增量整棵
 * 重挂。UI 围栏开合是唯一的"位数变化"事件,频率远低于文本增量。
 */
import { For, Match, Show, Switch, createMemo, createSignal, type Accessor, type Component } from "solid-js";
import { Collapse } from "../ui/Collapse";
import { Markdown } from "../markdown/Markdown";
import SurfaceView from "./render/SurfaceView";
import SurfaceView2 from "./v2/render/SurfaceView2";
import { compileSurface } from "./compiler";
import { createContentDecoder, type ContentPart, type UiSourcePart } from "./source/decoder";

/** UI 分帧的呈现:seal 后尝试编译成受限 Surface;失败/生成中回退占位卡(带具名错误)。 */
const UiSurfaceBlock: Component<{ part: Accessor<UiSourcePart>; onFollowUp?: (text: string) => void }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const compiled = createMemo(() => {
    if (props.part().version === "0.2") return { state: "v2" as const };
    const part = props.part();
    if (part.sealed) {
      try {
        return { state: "ok" as const, ir: compileSurface(part.source, part.format, { final: true }) };
      } catch (cause) {
        return { state: "error" as const, message: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    // 流式:未闭合围栏尝试部分编译,已到齐的行先渲染(失败静默回占位卡,
    // 半截代码不报错——seal 后的编译失败才具名展示)。
    try {
      return { state: "partial" as const, ir: compileSurface(part.source, part.format, { final: false }) };
    } catch {
      return { state: "building" as const };
    }
  });
  const ir = () => {
    const current = compiled();
    return current.state === "ok" || current.state === "partial" ? current.ir : null;
  };
  const problem = () => {
    const current = compiled();
    return current.state === "error" ? current.message : null;
  };
  const status = () => (props.part().sealed ? "已生成" : "生成中");
  // v0.2(A2UI 消息流):编译/patch/流式占位/具名失败全部由 SurfaceView2 自管,
  // 这里按围栏协议版本整体分流;v0.1 路径(v1View)保持原样不动。
  const v1View = (
    /* keyed 按 surfaceId 而非对象身份:流式期间每一帧部分编译都产出新 IR,
     * 按对象 key 会让 SurfaceView 整棵重挂(输入到一半的 TextInput 被清空、
     * 已渲染的节点闪烁);按 id key 则同一 surface 就地更新,节点到达即出现。 */
    <Show keyed when={(() => { const value = ir(); return value == null ? null : { key: value.surfaceId, ir: value }; })()} fallback={
      <div class={{ "genui-surface": true, sealed: props.part().sealed }} data-surface={props.part().surfaceId}>
        <button type="button" class="genui-surface-head" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
          <span class="genui-surface-title">生成式界面 · {props.part().surfaceId ?? "未命名"}</span>
          <span class="genui-surface-status">{status()}</span>
        </button>
        <Show when={props.part().fallback}><p class="genui-surface-fallback">{props.part().fallback}</p></Show>
        <Show when={problem()}><p class="genui-surface-error" role="alert">编译失败：{problem()}</p></Show>
        <Collapse open={open()}>
          <pre class="genui-surface-source">{props.part().source}</pre>
        </Collapse>
      </div>
    }>
      {(value) => <SurfaceView ir={value.ir} onFollowUp={props.onFollowUp} streaming={compiled().state === "partial"} />}
    </Show>
  );
  return (
    <Switch>
      <Match when={props.part().version === "0.2"}>
        <SurfaceView2 part={props.part} onFollowUp={props.onFollowUp} />
      </Match>
      <Match when={true}>{v1View}</Match>
    </Switch>
  );
};

const PartRow: Component<{ part: Accessor<ContentPart>; revision?: string | number; streaming?: boolean; onFollowUp?: (text: string) => void }> = (props) => {
  // Solid 下同一 accessor 调两次是两次求值,先读进局部变量再收窄联合类型。
  const ui = () => {
    const part = props.part();
    return part.kind === "ui" ? part : null;
  };
  const markdownText = () => {
    const part = props.part();
    return part.kind === "markdown" ? part.text : "";
  };
  return (
    <Switch>
      <Match when={ui()}>
        {(part) => <UiSurfaceBlock part={part} onFollowUp={props.onFollowUp} />}
      </Match>
      <Match when={markdownText() !== ""}>
        <Markdown text={markdownText} revision={props.revision} streaming={props.streaming} />
      </Match>
    </Switch>
  );
};

export const AssistantContent: Component<{ text: () => string; revision?: string | number; streaming?: boolean; onFollowUp?: (text: string) => void }> = (props) => {
  // 增量水位:流式追加只扫新完成的行,已确认前缀不重扫(改写则自动全量重扫)。
  const contentDecoder = createContentDecoder();
  const parts = createMemo(() => contentDecoder.push(props.text(), (props.streaming ?? true) === false));
  // Solid 2 RC 已移除 Index;For 对原始数 items 按值缓存视图,行随位置复用,
  // 分帧结果每次都是新数组也不会重挂 Markdown(内容经 part accessor 反应式更新)。
  const rows = createMemo(() => parts().map((_, index) => index));
  return (
    <For keyed={false} each={rows()}>
      {(row) => <PartRow part={() => parts()[row()] ?? { kind: "markdown", text: "" }} revision={props.revision} streaming={props.streaming} onFollowUp={props.onFollowUp} />}
    </For>
  );
};
