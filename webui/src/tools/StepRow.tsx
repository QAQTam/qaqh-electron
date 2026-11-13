/** 面向用户的工具结果：文件路径/diff、exec 终态徽章、待办/skills 语义。
 *  exec 的输出正文（运行中与终态）都不在这里渲染——只进后台执行抽屉。 */
import { createMemo, createSignal, Match, onCleanup, Show, Switch, type Component } from "solid-js";
import IconFile from "~icons/lucide/file-text";
import IconEdit from "~icons/lucide/file-pen-line";
import IconSearch from "~icons/lucide/search";
import IconTerminal from "~icons/lucide/square-terminal";
import IconWrench from "~icons/lucide/wrench";
import IconTarget from "~icons/lucide/target";
import { BoxSeal } from "../ui/box-anim";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconCopy from "~icons/lucide/copy";
import IconLoader from "~icons/lucide/loader-circle";
import IconX from "~icons/lucide/x";
import { Collapse } from "../ui/Collapse";
import { TextShimmer } from "../ui/TextShimmer";
import { TodoCard, todoCardData } from "./TodoCard";
import { STR, formatWorkDuration } from "../lib/strings";
import { now } from "../lib/time";
import { DiffList } from "../diff/DiffView";
import type { ToolStep, Turn } from "../session/types";
import { handoffToolErrorCode } from "../session/handoff";
import { primaryArg, toolLabel } from "./registry";
import { execRowBadge, handoffSummary, isSkillStep, semanticLabel, spawnForkBadge, toolPaths, toolPresentation, toolPhaseLabel } from "./presentation";
import { toolCommandIcon } from "./command-icons";
import { execPanelStore } from "../exec/panel-store";

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
    <Show when={step().error}><pre class="tool-text tool-error">{step().error}</pre></Show>
  </div>;
};

export const StepRow: Component<{ step: ToolStep; turn: Turn; expandable?: boolean; cwd?: string | null; isLatest?: boolean; isShimmer?: boolean; onFollowUp?: (text: string) => void }> = (props) => {
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
  // exec 行终态徽章:消息区对 exec 只留两个事实——命令(行首摘要)与 exit code。
  // 运行中/后台态也走这里,点击一律直达抽屉;正文渲染完全不在消息流里发生。
  const execBadge = createMemo(() => {
    const st = step().status;
    if (st !== "finished" && st !== "failed" && st !== "cancelled" && st !== "interrupted") return undefined;
    return execRowBadge(step());
  });
  const openExecDrawer = (event: MouseEvent): void => {
    event.stopPropagation();
    const id = step().execSessionId;
    if (id != null) execPanelStore.toggle(id);
  };
  const isShimmer = createMemo(() => {
    if (props.isShimmer !== undefined) return props.isShimmer;
    const st = step().status;
    if (st === "failed" || st === "cancelled" || st === "interrupted") return false;
    const active = (isLatest() && !yielded()) || st === "running" || st === "declared" || st === "awaiting_permission" || st === "cancelling";
    return Boolean(active && (summary() || commandIcon()));
  });
  const execTarget = () => kind() === "shell" && step().execSessionId != null;
  const hasDetails = () => (["read", "edit"].includes(kind()) && step().status === "finished" && Boolean(step().output?.diffText))
    || Boolean(step().error);
  const [override, setOverride] = createSignal<boolean | null>(null);
  // exec 展开区只剩工具级 error 一种事实；其余工具的展开语义不变。
  const open = () => hasDetails() && (override() ?? step().status === "failed");
  const stats = createMemo(() => {
    const delta = step().codeDelta;
    if (delta == null || (delta.lines_added === 0 && delta.lines_removed === 0)) return null;
    return { add: delta.lines_added, del: delta.lines_removed };
  });
  return (
    <Switch fallback={<div data-tool-call-id={step().id} class={{ "step-row": true, tool: true, [`st-${step().status}`]: true, "is-latest": isLatest() }}>
    <button type="button" class="tool-head" disabled={!hasDetails() && !execTarget()} aria-expanded={hasDetails() ? open() ? "true" : "false" : undefined} onClick={(event) => { if (hasDetails()) { setOverride(!open()); return; } openExecDrawer(event); }}>
      <Switch>
        <Match when={step().status === "declared" || step().status === "awaiting_permission" || step().status === "running" || step().status === "cancelling"}><span class="tool-icon spin"><IconLoader /></span></Match>
        <Match when={step().status === "finished"}><span class="tool-icon muted" title={execBadge()?.label ?? (kind() === "handoff" ? STR.handoffSealed : "已完成")}><Switch fallback={<IconWrench />}>
          <Match when={kind() === "shell"}><IconTerminal /></Match><Match when={kind() === "read" || kind() === "skill"}><IconFile /></Match><Match when={kind() === "edit"}><IconEdit /></Match><Match when={kind() === "search"}><IconSearch /></Match>
          {/* 交接工具在 minimal/custom 档也会被后端声明(控制面工具不吃 allowlist),
              按工具名给图标,不再套一层白名单,否则模型真会调的这行少个图标。 */}
          <Match when={kind() === "handoff"}><BoxSeal /></Match>
          <Match when={kind() === "goal"}><IconTarget /></Match>
        </Switch></span></Match>
        <Match when={step().status === "failed"}><span class="tool-icon err"><IconX /></span></Match>
        <Match when={step().status === "cancelled" || step().status === "interrupted"}><span class="tool-icon muted"><IconChevronRight /></span></Match>
      </Switch>
      <span class="tool-name">{semantic() ?? toolLabel(step().name)}</span>
      <Show when={spawnForkBadge(step())}>{(badge) => <span class="tool-fork-badge" title="子会话继承父会话已完成回合的历史">{badge()}</span>}</Show>
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
        <Match when={execBadge()}>
          {/* exec 行的全部消息区事实:命令在摘要,exit code 在这里;
              点击直达后台执行抽屉,正文不进转录渲染。 */}
          {(badge) => (
            <span class={{ "tool-state": true, clickable: execTarget(), err: badge().tone === "err" }}
              title={execTarget() ? "打开后台执行抽屉" : undefined}
              onClick={openExecDrawer}>{badge().label}</span>
          )}
        </Match>
        {/* 封箱成功的那一行状态位直说「已封箱交接」:loop 到此为止是事实,
            不是"任务完成"——用户得知道接下来要靠交接会话继续。 */}
        <Match when={kind() === "handoff" && step().status === "finished"}><span class="tool-state">{STR.handoffSealed}</span></Match>
        <Match when={step().status === "declared" || step().status === "awaiting_permission" || step().status === "running" || step().status === "cancelling"}>
          <span class="tool-state">{toolPhaseLabel(step())}</span>
          <LiveElapsed startedAt={step().startedAt} />
          <Show when={execTarget()}>
            <span class="tool-state clickable" title="完整输出在后台执行抽屉" onClick={openExecDrawer}>输出</span>
          </Show>
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
      <Match when={todoCardData(step())}>
        <TodoCard step={step()} />
      </Match>
    </Switch>
  );
};
