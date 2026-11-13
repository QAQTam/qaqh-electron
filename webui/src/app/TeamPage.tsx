/**
 * Team 页(subagent-team 施工单):任务板 + 花名册 + 留言板摘要。
 *
 * 数据源 = `GET /ringing/v2/sessions/{seed}/team`(读侧投影)。**没有推送**:
 * TeamDelta/TaskBoardDelta 词表在契约里活着但零发射器,不写订阅代码(§〇·1)。
 * 刷新两路(§一·3):
 *  1. 主触发:订阅 `onBoardToolActivity`,task_* 与 board_* 工具收尾即 refetch;
 *  2. 兜底:页可见时 5s 低频轮询,不可见停。
 *
 * 两个已知粗糙(§〇·2,不要当 bug 修):
 *  - 花名册是端点现算的粗投影(子级 Idle 也映射 running、residency 恒 unloaded、
 *    nickname/role/current_task_id 恒 null)——精确状态 join 会话列表的 status;
 *  - unread_messages 恒空(无发射器),不渲染未读角标。
 *
 * 工具输出的 TaskBoardTask 与这里的 TaskView **不同形**(owner 一个是 string
 * 一个是 TeamActor),解析器不混用。
 */
import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import IconRefresh from "~icons/lucide/rotate-cw";
import type { TaskState } from "../api/qaqh/TaskState";
import type { TaskView } from "../api/qaqh/TaskView";
import type { TeamResponse } from "../api/qaqh/TeamResponse";
import { Select } from "../ui/Select";
import { onBoardToolActivity } from "../session/store";
import { sessionCatalog, activeTab } from "../tabs/store";
import { transport } from "../lib/transport";
import { STR } from "../lib/strings";

const TASK_STATE_LABELS: Record<TaskState, string> = {
  open: STR.teamTaskOpen,
  claimed: STR.teamTaskClaimed,
  completed: STR.teamTaskCompleted,
  closed: STR.teamTaskClosed,
  cancelled: STR.teamTaskCancelled,
};

/** 依赖满足 = 前置任务是 completed|closed(后端 TaskState 同口径)。 */
const depsSatisfied = (task: TaskView, all: readonly TaskView[]): boolean =>
  (task.depends_on ?? []).every((id) => {
    const dep = all.find((item) => item.task_id === id);
    return dep != null && (dep.state === "completed" || dep.state === "closed");
  });

export const TeamPage: Component = () => {
  const [seed, setSeed] = createSignal(activeTab()?.seed ?? sessionCatalog()[0]?.session_id ?? "");
  const [snapshot, setSnapshot] = createSignal<TeamResponse | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const refetch = async (): Promise<void> => {
    const target = seed();
    if (target === "") return;
    setLoading(true);
    try {
      const body = await transport.teamSnapshot(target);
      if (typeof body !== "object" || body == null) throw new Error("/team 未返回对象");
      const parsed = body as TeamResponse;
      if (parsed.schema !== "qaqh.ringing.team/v1") throw new Error(`schema 不认识:${String(parsed.schema)}`);
      // 会话切换在飞时旧响应不落地(只认当前选中的 seed)。
      if (target === seed()) {
        setSnapshot(parsed);
        setError(null);
      }
    } catch (cause) {
      if (target === seed()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (target === seed()) setLoading(false);
    }
  };

  // 换会话即重取;refetch 内部按 target === seed() 守卫,切换在飞的旧响应不落地。
  const unsubscribeBoard = onBoardToolActivity((changedSeed) => {
    if (changedSeed === seed()) void refetch();
  });
  const pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refetch();
  }, 5_000);
  onCleanup(() => { unsubscribeBoard(); clearInterval(pollTimer); });
  // 本仓的 Solid 2.0-rc:createEffect 是 (deps, fn) 双参形态(见 ui/NumberInput)。
  createEffect(() => seed(), () => { void refetch(); });

  const tasks = (): TaskView[] => snapshot()?.tasks.tasks ?? [];
  const sessionOptions = () => sessionCatalog().map((item) => ({
    value: item.session_id,
    label: item.title != null && item.title.trim() !== "" ? item.title.trim() : `会话 ${item.session_id.slice(0, 8)}`,
  }));

  return (
    <div class="team-page">
      <header class="team-toolbar">
        <span class="team-toolbar-label">{STR.teamSessionLabel}</span>
        <Select
          value={seed()}
          options={sessionOptions()}
          onChange={setSeed}
          class="team-session-select"
          ariaLabel={STR.teamSessionLabel}
        />
        <button type="button" class="team-refresh" onClick={() => void refetch()} disabled={loading()}>
          <IconRefresh class={{ spin: loading() }} />
          {STR.teamRefresh}
        </button>
      </header>

      <Show when={error()} fallback={undefined}>
        {(message) => <p class="team-error">{STR.teamError(message())}</p>}
      </Show>

      <Show when={snapshot()} fallback={
        <Show when={error() == null}><p class="team-empty">{STR.teamEmpty}</p></Show>
      }>
        {(data) => (
          <>
            <section class="team-section">
              <h3>{STR.teamTasksTitle}</h3>
              <Show when={tasks().length > 0} fallback={<p class="team-empty">{STR.teamEmpty}</p>}>
                <div class="team-task-list">
                  <For each={tasks()}>{(task) => (
                    <article class="team-task" data-state={task.state}>
                      <div class="team-task-head">
                        <span class="team-task-state" data-state={task.state}>{TASK_STATE_LABELS[task.state]}</span>
                        <Show when={!depsSatisfied(task, tasks()) && (task.state === "open" || task.state === "claimed")}>
                          <span class="team-task-blocked" title={(task.depends_on ?? []).join(", ")}>{STR.teamTaskBlocked}</span>
                        </Show>
                        <span class="team-task-title">{task.title}</span>
                        <span class="team-task-owner" title={task.owner?.agent_path ?? ""}>
                          {task.owner?.agent_path ?? STR.teamTaskOwnerNone}
                        </span>
                        <span class="team-task-epoch">{STR.teamTaskEpoch(task.claim_epoch)}</span>
                      </div>
                      <Show when={(task.depends_on ?? []).length > 0}>
                        <p class="team-task-deps">{STR.teamTaskDeps}:{(task.depends_on ?? []).join(" · ")}</p>
                      </Show>
                      <Show when={(task.acceptance ?? []).length > 0}>
                        <ul class="team-task-acceptance">
                          <For each={task.acceptance}>{(item) => <li>{item}</li>}</For>
                        </ul>
                      </Show>
                      <Show when={(task.artifacts ?? []).length > 0}>
                        <p class="team-task-meta">{STR.teamTaskArtifacts((task.artifacts ?? []).length)}</p>
                      </Show>
                    </article>
                  )}</For>
                </div>
              </Show>
            </section>

            <section class="team-section">
              <h3>{STR.teamRosterTitle}</h3>
              <p class="team-note">{STR.teamRosterCoarse}</p>
              <ul class="team-roster">
                <For each={[...data().team.agents].sort((a, b) => a.agent_path.localeCompare(b.agent_path))}>{(agent) => (
                  <li class="team-agent" style={{ "--depth": String(agent.agent_path.split("/").length - 1) }}>
                    <span class="team-agent-path" title={agent.agent_path}>{agent.agent_path.split("/").pop()}</span>
                    <span class="team-agent-status">{agent.status}</span>
                  </li>
                )}</For>
              </ul>
            </section>

            <section class="team-section">
              <h3>{STR.teamBoardTitle}</h3>
              <Show when={(data().board.channels ?? []).length > 0} fallback={<p class="team-empty">{STR.teamBoardEmpty}</p>}>
                <div class="team-board">
                  <For each={data().board.channels ?? []}>{(channel) => (
                    <div class="team-channel">
                      <span class="team-channel-name">#{channel.name}</span>
                      <Show when={channel.topic}><span class="team-channel-topic">{channel.topic}</span></Show>
                      <ul class="team-threads">
                        <For each={(data().board.threads ?? []).filter((thread) => thread.channel_id === channel.channel_id)}>{(thread) => (
                          <li class="team-thread">
                            <span class="team-thread-title">{thread.title}</span>
                            <span class="team-thread-count">{STR.teamBoardPosts(thread.post_count)}</span>
                          </li>
                        )}</For>
                      </ul>
                    </div>
                  )}</For>
                </div>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
};
