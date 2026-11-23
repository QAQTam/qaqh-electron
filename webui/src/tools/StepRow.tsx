/** 面向用户的工具结果：文件路径/diff、exec 终态徽章、待办/skills 语义。
 *  exec 的输出正文（运行中与终态）都不在这里渲染——只进后台执行抽屉。 */
import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch, untrack, type Component } from "solid-js";
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
import { parseJsonish } from "../session/reducer";
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

/**
 * 展开区是「第二层」:zcode 纪律——每层有界,下一层有出口。
 * 正文进视口前按字符数封顶(布局只为可见区付钱);全文仍在数据层,
 * 截断与否由徽标/提示行说话,不许静默。
 */
const DETAIL_MAX_CHARS = 200_000;
const ARGS_MAX_CHARS = 8_000;

function clipText(text: string, cap: number): { text: string; omitted: number } {
  return text.length > cap ? { text: text.slice(0, cap), omitted: text.length - cap } : { text, omitted: 0 };
}

function prettyArgs(argsJson: string | undefined): string {
  if (argsJson == null || argsJson.trim() === "") return "";
  const parsed = parseJsonish(argsJson);
  if (parsed == null) return argsJson;
  try { return JSON.stringify(parsed, null, 2); } catch { return argsJson; }
}

export const ToolDetail: Component<{ step: ToolStep; loadOutput?: (ref: string) => void; contentStatus?: Record<string, "loading" | "ready" | "failed"> }> = (props) => {
  const step = () => props.step;
  const kind = () => toolPresentation(step());
  const shell = () => kind() === "shell";
  const args = createMemo(() => clipText(prettyArgs(step().argsJson), ARGS_MAX_CHARS));
  // exec 的输入/输出都归命令摘要与抽屉,展开区只有 error 一种事实(文件头口径)。
  const showArgs = () => !shell() && kind() !== "handoff" && step().status !== "declared" && args().text !== "";
  const errorText = () => step().error?.trim() || undefined;
  const shownDiff = () => (step().status === "finished" ? step().output?.diffText : undefined);
  const result = createMemo(() => {
    const text = step().output?.text;
    if (text == null || shell()) return null;
    const trimmed = text.trim();
    if (errorText() && trimmed === errorText()) return null;
    const diff = shownDiff();
    if (diff && trimmed === diff.trim()) return null;
    return clipText(text, DETAIL_MAX_CHARS);
  });
  // 懒水合:外置正文(>32 KiB)未拉取时这里给占位/失败重试,不静默空段。
  const pending = () => !shell() && step().outputRef != null && step().output?.text == null;
  const pendingStatus = () => (step().outputRef != null ? props.contentStatus?.[step().outputRef!] : undefined);
  const stderr = () => {
    if (shell()) return undefined;
    const text = step().output?.stderr;
    if (!text) return undefined;
    if (errorText() && text.trim() === errorText()) return undefined;
    return text;
  };
  const errorBody = createMemo(() => {
    const text = step().error;
    return text ? clipText(text, DETAIL_MAX_CHARS) : null;
  });
  const omitLine = (omitted: number) => <Show when={omitted > 0}><span class="tool-omit">{STR.resultCharsOmitted(omitted)}</span></Show>;
  return <div class="tool-detail">
    <Show when={shownDiff()}>
      {(diff) => <>
        <div class="tool-detail-label">修改结果<span class="spacer" /><CopyButton text={() => diff()} /></div>
        <DiffList diffText={diff()} hideSingleFilePath />
      </>}
    </Show>
    <Show when={showArgs()}>
      <div class="tool-detail-label">{STR.toolSectionInput}<span class="spacer" /><CopyButton text={() => args().text} /></div>
      <pre class="tool-text">{args().text}{omitLine(args().omitted)}</pre>
    </Show>
    <Show when={result() || pending()}>
      <Show when={result()} fallback={
        <Show when={pendingStatus() === "failed"} fallback={<p class="tool-text muted" role="status">正文加载中…</p>}>
          <button type="button" class="content-placeholder retry" onClick={() => {
            const ref = step().outputRef;
            if (ref != null) props.loadOutput?.(ref);
          }}>正文加载失败，重试</button>
        </Show>
      }>
        {(body) => <>
          <div class="tool-detail-label">
            {STR.toolSectionResult}
            <Show when={step().output?.truncated === true}><span class="tool-omit">{STR.truncatedNotice}</span></Show>
            <span class="spacer" /><CopyButton text={() => body().text} />
          </div>
          <pre class="tool-text">{body().text}{omitLine(body().omitted)}</pre>
        </>}
      </Show>
    </Show>
    <Show when={stderr()}>
      {(text) => <>
        <div class="tool-detail-label">{STR.toolSectionStderr}<span class="spacer" /><CopyButton text={() => text()} /></div>
        <pre class="tool-text tool-error">{text()}</pre>
      </>}
    </Show>
    <Show when={errorBody()}>
      {(body) => <>
        <div class="tool-detail-label">
          错误
          <Show when={step().output?.truncated === true && !result()}><span class="tool-omit">{STR.truncatedNotice}</span></Show>
          <span class="spacer" /><CopyButton text={() => body().text} />
        </div>
        <pre class="tool-text tool-error">{body().text}{omitLine(body().omitted)}</pre>
      </>}
    </Show>
  </div>;
};

export const StepRow: Component<{ step: ToolStep; turn: Turn; expandable?: boolean; cwd?: string | null; isLatest?: boolean; isShimmer?: boolean; onFollowUp?: (text: string) => void; loadOutput?: (ref: string) => void; contentStatus?: Record<string, "loading" | "ready" | "failed"> }> = (props) => {
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
    if (props.turn != null && props.turn.status !== "running") return false;
    const st = step().status;
    if (st === "finished" || st === "failed" || st === "cancelled" || st === "interrupted") return false;
    const active = (isLatest() && !yielded()) || st === "running" || st === "declared" || st === "awaiting_permission" || st === "cancelling";
    return Boolean(active && (summary() || commandIcon()));
  });
  const execTarget = () => kind() === "shell" && step().execSessionId != null;
  const bodyTool = () => kind() !== "shell" && kind() !== "handoff";
  const terminalish = () => ["finished", "failed", "cancelled", "interrupted"].includes(step().status);
  const hasDetails = () => Boolean(step().error)
    || (step().status === "finished" && Boolean(step().output?.diffText))
    || (bodyTool() && terminalish()
        && (Boolean(step().outputRef) || Boolean(step().output?.text) || Boolean(step().output?.stderr) || Boolean(step().argsJson)));
  const [override, setOverride] = createSignal<boolean | null>(null);
  // 展开区一律默认收起:失败不再自动展开(zcode 纪律——错误由状态位 tooltip
  // 与手动展开承担,红块墙不是消息区的职责)。
  const open = () => hasDetails() && (override() ?? false);
  // 展开即按需拉取外置正文:收起状态下几百 KB 不进渲染进程。
  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    const ref = untrack(() => step().outputRef);
    if (ref != null) props.loadOutput?.(ref);
  });
  const stats = createMemo(() => {
    // 终态 code_delta 是真实 diff(权威,优先);编辑中只有内核随参数流数出的
    // 累计估算 linesAdded/linesRemoved 可用,逐帧实时更新。
    const delta = step().codeDelta;
    const add = delta?.lines_added ?? step().linesAdded;
    const del = delta?.lines_removed ?? step().linesRemoved;
    if (add == null || del == null || (add === 0 && del === 0)) return null;
    return { add, del };
  });
  return (
    <Switch fallback={<div data-tool-call-id={step().id} class={{ "step-row": true, tool: true, [`st-${step().status}`]: true, "is-latest": isLatest() }}>
    <button type="button" class="tool-head" disabled={!hasDetails() && !execTarget()} aria-expanded={hasDetails() ? open() ? "true" : "false" : undefined} onClick={(event) => { if (hasDetails()) { setOverride(!open()); return; } openExecDrawer(event); }}>
      <Switch>
        <Match when={step().status === "declared" || step().status === "awaiting_permission" || step().status === "running" || step().status === "cancelling"}><span class="tool-icon muted"><IconLoader /></span></Match>
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
        {/* 截断必须可见(非 shell——exec 的窗口提示在抽屉):过去 output_truncated
            在消息区零展示,用户无法区分「没有输出」与「输出被截断」。 */}
        <Match when={step().output?.truncated === true && bodyTool()}>
          <span class="tool-state err" title={STR.truncatedNotice}>{STR.truncatedFlag}</span>
        </Match>
      </Switch>
      <Show when={hasDetails()}><IconChevronRight class={`tool-chevron${open() ? " is-open" : ""}`} /></Show>
    </button>
    <Collapse open={open()}><ToolDetail step={step()} loadOutput={props.loadOutput} contentStatus={props.contentStatus} /></Collapse>
    </div>}>
      <Match when={todoCardData(step())}>
        <TodoCard step={step()} />
      </Match>
    </Switch>
  );
};
