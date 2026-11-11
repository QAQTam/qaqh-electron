/** 面向用户的工具结果：文件路径/diff、exec 流、待办/skills 语义。 */
import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch, type Component } from "solid-js";
import IconFile from "~icons/lucide/file-text";
import IconEdit from "~icons/lucide/file-pen-line";
import IconSearch from "~icons/lucide/search";
import IconTerminal from "~icons/lucide/square-terminal";
import IconWrench from "~icons/lucide/wrench";
import IconHandoff from "~icons/lucide/package-check";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconCopy from "~icons/lucide/copy";
import IconLoader from "~icons/lucide/loader-circle";
import IconX from "~icons/lucide/x";
import { Collapse } from "../ui/Collapse";
import { TextShimmer } from "../ui/TextShimmer";
import { TodoCard, todoCardData } from "./TodoCard";
import type { ReadOnlyTerminalProps } from "./ReadOnlyTerminal";
import { STR, formatWorkDuration } from "../lib/strings";
import { now } from "../lib/time";
import { DiffList } from "../diff/DiffView";
import type { ToolStep, Turn } from "../session/types";
import { handoffToolErrorCode } from "../session/handoff";
import { primaryArg, toolLabel } from "./registry";
import { handoffSummary, isSkillStep, semanticLabel, shellContent, shellLive, toolPaths, toolPresentation, toolPhaseLabel } from "./presentation";
import { toolCommandIcon } from "./command-icons";

type ReadOnlyTerminalView = Component<ReadOnlyTerminalProps>;
let readOnlyTerminalPromise: Promise<ReadOnlyTerminalView> | undefined;

function loadReadOnlyTerminal(): Promise<ReadOnlyTerminalView> {
  readOnlyTerminalPromise ??= import("./ReadOnlyTerminal").then((module) => module.ReadOnlyTerminal);
  return readOnlyTerminalPromise;
}

const TerminalSlot: Component<ReadOnlyTerminalProps & { component: ReadOnlyTerminalView | undefined }> = (props) => (
  <Show when={props.component} fallback={<div class="tool-xterm tool-xterm-loading" aria-hidden="true" />}>
    {(view) => {
      const ReadOnlyTerminal = view();
      return <ReadOnlyTerminal text={props.text} live={props.live} stream={props.stream} tty={props.tty} onWrite={props.onWrite} />;
    }}
  </Show>
);

const CopyButton: Component<{ text: () => string }> = (props) => {
  const [copied, setCopied] = createSignal(false);
  return <button type="button" class="ghost-mini" title={STR.copy} onClick={(event) => {
    event.stopPropagation();
    void navigator.clipboard.writeText(props.text()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  }}>{copied() ? STR.copied : STR.copy}<IconCopy /></button>;
};

const LiveElapsed: Component<{ startedAt: number | undefined }> = (props) => {
  const [tick, setTick] = createSignal(now());
  const timer = setInterval(() => setTick(now()), 1_000);
  onCleanup(() => clearInterval(timer));
  return <span class="tool-elapsed">{formatWorkDuration(props.startedAt == null ? 0 : Math.max(0, tick() - props.startedAt))}</span>;
};

const ExecResult: Component<{ step: ToolStep }> = (props) => {
  const content = createMemo(() => shellContent(props.step));
  const live = () => shellLive(props.step);
  const yielded = () => props.step.state?.kind === "finished" && props.step.state.outcome.kind === "yielded";
  const [terminalComponent, setTerminalComponent] = createSignal<ReadOnlyTerminalView>();
  let scroller: HTMLDivElement | undefined;
  let following = true;
  let frame: number | undefined;
  const followOutput = (): void => {
    if (frame != null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (following && scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  };
  createEffect(() => content(), followOutput);
  onCleanup(() => { if (frame != null) cancelAnimationFrame(frame); });
  createEffect(
    () => Boolean(content().text || content().stderr),
    (hasOutput) => {
      if (hasOutput) void loadReadOnlyTerminal().then((component) => setTerminalComponent(() => component));
    },
  );
  return <>
    <Show when={content().text || content().stderr}>
      <div class="tool-output">
        <div class="tool-detail-label">{live() ? "运行输出" : yielded() ? "本次输出" : "执行结果"}<span class="spacer" /><CopyButton text={() => [content().text, content().stderr].filter(Boolean).join("\n")} /></div>
        <div ref={scroller} class={{ "tool-shell-output": true, "tool-progress": live() }}
          onWheel={(event) => { if (event.deltaY < 0) following = false; }}
          onPointerDown={() => { following = false; }} onTouchStart={() => { following = false; }}
          onScroll={(event) => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) following = true; }}>
          <Show when={content().text}><TerminalSlot text={content().text} live={live()} stream={content().stream ?? props.step.progressStream} tty={props.step.execSession?.tty} onWrite={followOutput} component={terminalComponent()} /></Show>
          <Show when={content().stderr}><div class="tool-detail-label">stderr</div><TerminalSlot text={content().stderr} live={live()} stream={props.step.progressStderrStream} onWrite={followOutput} component={terminalComponent()} /></Show>
        </div>
      </div>
    </Show>
    <Show when={content().truncated}><div class="tool-truncated">仅显示输出尾部</div></Show>
  </>;
};

export const ToolDetail: Component<{ step: ToolStep }> = (props) => {
  const step = () => props.step;
  const file = () => !isSkillStep(step()) && ["read", "edit"].includes(toolPresentation(step()));
  return <div class="tool-detail">
    <Show when={file()}>
      <Show when={step().status === "finished" && step().output?.diffText}>
        <div class="tool-detail-label">修改结果<span class="spacer" /><CopyButton text={() => step().output?.diffText ?? ""} /></div>
        <DiffList diffText={step().output!.diffText!} hideSingleFilePath />
      </Show>
    </Show>
    <Show when={toolPresentation(step()) === "shell"}>
      <ExecResult step={step()} />
    </Show>
    <Show when={step().error}><pre class="tool-text tool-error">{step().error}</pre></Show>
  </div>;
};

export const StepRow: Component<{ step: ToolStep; turn: Turn; expandable?: boolean; cwd?: string | null; isLatest?: boolean; isShimmer?: boolean }> = (props) => {
  const step = () => props.step;
  const kind = () => isSkillStep(step()) ? "skill" : toolPresentation(step());
  const semantic = () => semanticLabel(step());
  const commandIcon = () => kind() === "shell" ? toolCommandIcon(step().argsJson) : undefined;
  const paths = createMemo(() => ["read", "edit"].includes(kind()) ? toolPaths(step(), props.cwd) : []);
  // 交接行的摘要 = 模型的 work_summary;primaryArg 会拿整篇 handoff_doc 的第一个字符串。
  const summary = () => kind() === "handoff" ? handoffSummary(step())
    : semantic() ? "" : paths().length ? paths().join(" · ") : primaryArg(step().argsJson);
  const isLatest = createMemo(() => {
    if (props.isLatest !== undefined) return props.isLatest;
    const toolSteps = (props.turn?.steps ?? []).filter((s) => s.kind === "tool");
    return toolSteps.length > 0 && toolSteps[toolSteps.length - 1]?.id === step().id;
  });
  const yielded = () => {
    const state = step().state;
    return state?.kind === "finished" && state.outcome.kind === "yielded";
  };
  const yieldedLabel = () => {
    const state = step().execSessionState;
    if (state == null || state.kind === "running") return "后台运行";
    if (state.kind === "stopping") return "正在停止后台进程";
    const outcome = state.outcome;
    if (outcome.kind === "exited") {
      return outcome.exit_code === 0 ? "后台进程已结束" : `后台进程已退出 · ${outcome.exit_code}`;
    }
    if (outcome.kind === "cancelled") return "后台进程已取消";
    if (outcome.kind === "timed_out") return "后台进程已超时";
    return "后台进程已中断";
  };
  const isShimmer = createMemo(() => {
    if (props.isShimmer !== undefined) return props.isShimmer;
    const st = step().status;
    if (st === "failed" || st === "cancelled" || st === "interrupted") return false;
    const active = (isLatest() && !yielded()) || st === "running" || st === "declared" || st === "awaiting_permission" || st === "cancelling";
    return Boolean(active && (summary() || commandIcon()));
  });
  const hasDetails = () => kind() === "shell"
    || (["read", "edit"].includes(kind()) && step().status === "finished" && Boolean(step().output?.diffText))
    || Boolean(step().error);
  const [override, setOverride] = createSignal<boolean | null>(null);
  // exec 默认直接展示流与终态输出；用户折叠意图优先且不会被终态重置。
  const open = () => hasDetails() && (override() ?? (kind() === "shell" || step().status === "failed"));
  const stats = createMemo(() => {
    const delta = step().codeDelta;
    if (delta == null || (delta.lines_added === 0 && delta.lines_removed === 0)) return null;
    return { add: delta.lines_added, del: delta.lines_removed };
  });
  return (
    <Show when={todoCardData(step())} fallback={<div data-tool-call-id={step().id} class={{ "step-row": true, tool: true, [`st-${step().status}`]: true, "is-latest": isLatest() }}>
    <button type="button" class="tool-head" disabled={!hasDetails()} aria-expanded={hasDetails() ? open() ? "true" : "false" : undefined} onClick={() => setOverride(!open())}>
      <Switch>
        <Match when={step().status === "declared" || step().status === "awaiting_permission" || step().status === "running" || step().status === "cancelling"}><span class="tool-icon spin"><IconLoader /></span></Match>
        <Match when={step().status === "finished"}><span class="tool-icon muted" title={yielded() ? yieldedLabel() : kind() === "handoff" ? STR.handoffSealed : "已完成"}><Switch fallback={<IconWrench />}>
          <Match when={kind() === "shell"}><IconTerminal /></Match><Match when={kind() === "read" || kind() === "skill"}><IconFile /></Match><Match when={kind() === "edit"}><IconEdit /></Match><Match when={kind() === "search"}><IconSearch /></Match>
          {/* 交接工具在 minimal/custom 档也会被后端声明(控制面工具不吃 allowlist),
              按工具名给图标,不再套一层白名单,否则模型真会调的这行少个图标。 */}
          <Match when={kind() === "handoff"}><IconHandoff /></Match>
        </Switch></span></Match>
        <Match when={step().status === "failed"}><span class="tool-icon err"><IconX /></span></Match>
        <Match when={step().status === "cancelled" || step().status === "interrupted"}><span class="tool-icon muted"><IconChevronRight /></span></Match>
      </Switch>
      <span class="tool-name">{semantic() ?? toolLabel(step().name)}</span>
      <span class="tool-summary" title={summary()}>
        {/* 图标走 CSS 遮罩(见 tools.css 的 .tool-command-icon):Simple Icons 的 path
            不带 fill,`<img>` 直出就是纯黑,深色主题下只剩一团黑;bash/powershell 又是
            彩色的,没法用一条 filter 统一修。遮罩只取轮廓,颜色跟文字走。 */}
        <Show when={commandIcon()}>
          {(icon) => (
            <span
              class="tool-command-icon"
              aria-hidden="true"
              title={icon().label}
              style={{ "--tool-command-icon": `url("${icon().src}")` }}
            />
          )}
        </Show>
        <span class="tool-summary-text"><TextShimmer text={summary()} active={isShimmer()} /></span>
      </span>
      <Show when={stats()}><span class="tool-diffstat"><b class="diff-stat-add">+{stats()!.add}</b><b class="diff-stat-del">−{stats()!.del}</b></span></Show>
      <Switch>
        <Match when={yielded()}><span class="tool-state">{yieldedLabel()}</span></Match>
        {/* 封箱成功的那一行状态位直说「已封箱交接」:loop 到此为止是事实,
            不是"任务完成"——用户得知道接下来要靠交接会话继续。 */}
        <Match when={kind() === "handoff" && step().status === "finished"}><span class="tool-state">{STR.handoffSealed}</span></Match>
        <Match when={step().status === "declared" || step().status === "awaiting_permission" || step().status === "running" || step().status === "cancelling"}>
          <span class="tool-state">{toolPhaseLabel(step())}</span>
          <LiveElapsed startedAt={step().startedAt} />
        </Match>
        <Match when={step().status === "failed"}>
          {/* 交接类失败(`handoff_invalid_args` / `handoff_write_failed`)走工具错误、
              不走 TurnError:回合继续、模型可重试。这里把 code 摆进状态位,正文留在
              展开区(`step.error`),不做任何自动补救。 */}
          <span class="tool-state err" title={step().error ?? undefined}>{handoffToolErrorCode(step()) ?? STR.failed}</span>
        </Match>
        <Match when={step().status === "cancelled" || step().status === "interrupted"}><span class="tool-state">{STR.aborted}</span></Match>
      </Switch>
      <Show when={hasDetails()}><IconChevronRight class={`tool-chevron${open() ? " is-open" : ""}`} /></Show>
    </button>
    <Collapse open={open()}><ToolDetail step={step()} /></Collapse>
    </div>}>
      <TodoCard step={step()} />
    </Show>
  );
};
