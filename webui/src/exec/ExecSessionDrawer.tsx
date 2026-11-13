/**
 * 后台执行抽屉 (效仿 DiffReviewDrawer 的右侧滑入工作台)
 *
 * 性能与内存纪律(与 diff 抽屉同一套,见 deliverables.css §2 的注释):
 * 1. 物理卸载: execPanelStore isOpen=false 时整棵子树不挂载。
 * 2. 动画-渲染错峰: 200ms 滑入期间只挂 Skeleton,动画落地后再点亮 xterm。
 * 3. 单实例终端: 同一时刻只挂当前选中会话的一台 xterm(keyed by execId,切换即重建),
 *    列表行纯文本;数据本体是活动会话 store 的 execSessions 记录,这里不复制状态。
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";
import IconPause from "~icons/lucide/pause";
import IconSquare from "~icons/lucide/square";
import IconCopy from "~icons/lucide/copy";
import IconX from "~icons/lucide/x";
import { execPanelStore } from "./panel-store";
import { activeTab } from "../tabs/store";
import { execSessionContent } from "../tools/presentation";
import { formatWorkDuration } from "../lib/strings";
import { now } from "../lib/time";
import type { ExecSessionView } from "../api/contract";
import type { ReadOnlyTerminalProps } from "../tools/ReadOnlyTerminal";

type ReadOnlyTerminalView = Component<ReadOnlyTerminalProps>;
let readOnlyTerminalPromise: Promise<ReadOnlyTerminalView> | undefined;

function loadReadOnlyTerminal(): Promise<ReadOnlyTerminalView> {
  readOnlyTerminalPromise ??= import("../tools/ReadOnlyTerminal").then((module) => module.ReadOnlyTerminal);
  return readOnlyTerminalPromise;
}

const TerminalSlot: Component<ReadOnlyTerminalProps & { component: ReadOnlyTerminalView | undefined }> = (props) => (
  <Show when={props.component} fallback={<div class="tool-xterm tool-xterm-loading" aria-hidden="true" />}>
    {(view) => {
      const ReadOnlyTerminal = view();
      return <ReadOnlyTerminal text={props.text} live={props.live} stream={props.stream} stderr={props.stderr} tty={props.tty} />;
    }}
  </Show>
);

function execStateLabel(session: ExecSessionView): string {
  const state = session.state;
  if (state.kind === "running") return "后台运行";
  if (state.kind === "stopping") return "正在停止";
  const outcome = state.outcome;
  if (outcome.kind === "exited") return outcome.exit_code === 0 ? "已结束" : `已退出 · ${outcome.exit_code}`;
  if (outcome.kind === "cancelled") return "已取消";
  if (outcome.kind === "timed_out") return "已超时";
  return "已中断";
}

function execStateClass(session: ExecSessionView): string {
  const state = session.state;
  if (state.kind === "running") return "running";
  if (state.kind === "stopping") return "stopping";
  return state.outcome.kind === "exited" && state.outcome.exit_code === 0 ? "ok" : "err";
}

export const ExecSessionDrawer: Component = () => {
  const state = () => execPanelStore.snapshot();
  const [filterQuery, setFilterQuery] = createSignal("");
  const [animReady, setAnimReady] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [terminalComponent, setTerminalComponent] = createSignal<ReadOnlyTerminalView>();

  const [tick, setTick] = createSignal(now());

  // 动画-渲染解耦:滑入 200ms 内只挂 Skeleton,落地后再挂终端。
  // 心跳也只在开窗期间跑,喂列表/横幅的运行时长;关闭即一并清理。
  createEffect(
    () => state().isOpen,
    (isOpen) => {
      setAnimReady(false);
      if (!isOpen) return undefined;
      setFilterQuery("");
      const timer = setTimeout(() => setAnimReady(true), 200);
      const heartbeat = setInterval(() => setTick(now()), 1_000);
      return (): void => {
        clearTimeout(timer);
        clearInterval(heartbeat);
      };
    }
  );

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!state().isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      execPanelStore.close();
    }
  };

  createEffect(
    () => state().isOpen,
    (isOpen) => {
      if (!isOpen) return undefined;
      window.addEventListener("keydown", handleKeyDown);
      return (): void => window.removeEventListener("keydown", handleKeyDown);
    }
  );

  // 数据源:活动会话 store 的 execSessions(Solid store 细粒度响应),面板不复制状态。
  const execSessions = () => activeTab()?.store.state[0].execSessions ?? {};
  const sessionStore = () => activeTab()?.store;

  const entries = createMemo(() => {
    const q = filterQuery().trim().toLowerCase();
    const list = Object.values(execSessions()).filter((session) => !q || session.command.toLowerCase().includes(q));
    // 运行中的排前面,其余按开始时间倒序。
    const rank = (session: ExecSessionView) => (session.state.kind === "finished" ? 1 : 0);
    return list.sort((a, b) => rank(a) - rank(b) || b.started_at_ms - a.started_at_ms);
  });

  const activeSession = createMemo<ExecSessionView | undefined>(() => {
    const current = state().activeExecId;
    return current != null ? execSessions()[current] : undefined;
  });

  const activeContent = createMemo(() => {
    const session = activeSession();
    if (!session) return null;
    // execSessionContent 只接受会话视图——exec 正文的唯一渲染点就是这里。
    return execSessionContent(session);
  });

  // 终端懒加载与 StepRow 同一模式:第一份输出出现时才拉模块。
  createEffect(
    () => Boolean(activeContent()?.text),
    (hasOutput) => {
      if (hasOutput) void loadReadOnlyTerminal().then((component) => setTerminalComponent(() => component));
    }
  );

  const elapsedOf = (session: ExecSessionView): string =>
    formatWorkDuration(Math.max(0, (session.finished_at_ms ?? tick()) - session.started_at_ms));

  const runningCount = createMemo(() => entries().filter((session) => session.state.kind !== "finished").length);

  const handleInterrupt = () => {
    const store = sessionStore();
    const id = activeSession()?.id;
    if (store && id != null) void store.interruptExecSession(id);
  };

  const handleTerminate = () => {
    const store = sessionStore();
    const id = activeSession()?.id;
    if (store && id != null) void store.terminateExecSession(id);
  };

  const handleCopy = () => {
    const text = activeContent()?.text ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <Show when={state().isOpen}>
      <div
        class="exec-drawer-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) execPanelStore.close();
        }}
        role="presentation"
      >
        <aside class="exec-drawer-panel" role="dialog" aria-modal="true" aria-label="后台执行抽屉">
          <header class="exec-drawer-header">
            <div class="exec-drawer-header-left">
              <span class="exec-drawer-title">后台执行</span>
              <Show when={runningCount() > 0}>
                <span class="exec-drawer-live-count">{runningCount()} 个运行中</span>
              </Show>
            </div>
            <button type="button" class="exec-drawer-close-btn" title="关闭抽屉 (Esc)" onClick={() => execPanelStore.close()}>
              <IconX />
            </button>
          </header>

          <div class="exec-drawer-body">
            {/* 左侧会话导航 */}
            <div class="exec-drawer-sidebar">
              <div class="exec-drawer-filter">
                <input
                  type="text"
                  class="exec-drawer-input"
                  placeholder="过滤命令..."
                  value={filterQuery()}
                  onInput={(e) => setFilterQuery(e.currentTarget.value)}
                />
              </div>
              <div class="exec-drawer-list" role="list">
                <Show when={entries().length > 0} fallback={<div class="exec-drawer-empty">当前会话没有后台执行会话。</div>}>
                  <For each={entries()}>
                    {(session) => (
                      <div
                        class={{ "exec-drawer-row": true, active: activeSession()?.id === session.id }}
                        role="listitem"
                        title={session.command}
                        onClick={() => execPanelStore.select(session.id)}
                      >
                        <div class="exec-drawer-row-head">
                          <span class={`exec-state-dot ${execStateClass(session)}`} aria-hidden="true" />
                          <span class="exec-drawer-row-command">{session.command}</span>
                        </div>
                        <div class="exec-drawer-row-meta">
                          <span>{execStateLabel(session)}</span>
                          <span>·</span>
                          <span>{elapsedOf(session)}</span>
                          <Show when={session.cwd}>
                            {(cwd) => <span class="exec-drawer-row-cwd" title={cwd()}>{cwd()}</span>}
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>

            {/* 右侧终端工作区 */}
            <div class="exec-drawer-content-pane">
              <Show when={activeSession()} fallback={<div class="exec-drawer-empty">没有选中的后台执行。</div>}>
                {(session) => (
                  <>
                    <div class="exec-drawer-banner">
                      <div class="exec-drawer-banner-main">
                        <span class={`exec-state-dot ${execStateClass(session())}`} aria-hidden="true" />
                        <span class="exec-drawer-banner-command" title={session().command}>{session().command}</span>
                        <span class="exec-drawer-banner-state">{execStateLabel(session())}</span>
                        <span class="exec-drawer-banner-elapsed">{elapsedOf(session())}</span>
                      </div>
                      <div class="exec-drawer-banner-actions">
                        <Show when={activeContent()?.text}>
                          <button type="button" class="exec-drawer-action-btn" title="复制当前输出" onClick={handleCopy}>
                            <IconCopy />
                            <span>{copied() ? "已复制" : "复制"}</span>
                          </button>
                        </Show>
                        <Show when={session().state.kind === "running"}>
                          <button type="button" class="exec-drawer-action-btn" title="请求温和停止" onClick={handleInterrupt}>
                            <IconPause />
                            <span>中断</span>
                          </button>
                        </Show>
                        <Show when={session().state.kind !== "finished"}>
                          <button type="button" class="exec-drawer-action-btn danger" title="强制终止进程" onClick={handleTerminate}>
                            <IconSquare />
                            <span>终止</span>
                          </button>
                        </Show>
                      </div>
                    </div>
                    <Show
                      when={Boolean(activeContent()?.text) || session().state.kind !== "finished"}
                      fallback={<div class="exec-drawer-empty">该进程没有捕获到输出。</div>}
                    >
                      <div class="exec-drawer-terminal">
                        <Show when={activeContent()?.truncated}>
                          <div class="tool-truncated">仅显示输出尾部</div>
                        </Show>
                        <Show
                          when={animReady()}
                          fallback={
                            <div class="exec-drawer-skeleton">
                              <div class="exec-drawer-skeleton-line" style={{ width: "78%" }} />
                              <div class="exec-drawer-skeleton-line" style={{ width: "56%" }} />
                              <div class="exec-drawer-skeleton-line" style={{ width: "70%" }} />
                            </div>
                          }
                        >
                          {/* keyed:切换会话必须重建 xterm(offset 状态在实例闭包里)。 */}
                          <Show when={activeSession()?.id} keyed>
                            {(id) => (
                              <div class="tool-shell-output">
                                <TerminalSlot
                                  text={activeContent()?.text ?? ""}
                                  live={execSessions()[id]?.state.kind !== "finished"}
                                  stream={activeContent()?.stream}
                                  tty={execSessions()[id]?.tty}
                                  component={terminalComponent()}
                                />
                              </div>
                            )}
                          </Show>
                        </Show>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </aside>
      </div>
    </Show>
  );
};
