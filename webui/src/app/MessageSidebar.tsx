import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconFolder from "~icons/lucide/folder";
import IconMessageSquare from "~icons/lucide/message-square";
import IconMoreHorizontal from "~icons/lucide/more-horizontal";
import IconPlus from "~icons/lucide/plus";
import { STR } from "../lib/strings";
import type { ApprovalView } from "../lib/transport";
import { sessionCatalog, workspaceCatalog, type SidebarSession, type SidebarWorkspace } from "../tabs/store";
import { WorkspaceMenuItem } from "../workspace/WorkspaceMenu";
import { SessionPendingCard } from "./SessionPendingCard";
import { pendingPresentation, workingOnly } from "./session-pending";

const pathName = (path: string | null | undefined): string => {
  const value = (path ?? "").replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名工作区";
};

const normalizePath = (p: string | null | undefined): string =>
  (p ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();

const sessionBelongsToWorkspace = (session: SidebarSession, workspace: SidebarWorkspace): boolean => {
  if (session.workspace_id === workspace.id) return true;
  if (!session.workspace_id && session.cwd && workspace.path) {
    const sc = normalizePath(session.cwd);
    const wp = normalizePath(workspace.path);
    return sc === wp || sc.startsWith(`${wp}/`);
  }
  return false;
};

const WORKSPACE_COLLAPSED_KEY = "qaqh.sidebar.collapsed";

function readStoredCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(WORKSPACE_COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

const sessionName = (session: SidebarSession): string =>
  session.title?.trim() || `会话 ${session.session_id.slice(0, 8)}`;

export const MessageSidebar: Component<{
  onSelect: (seed: string) => void;
  sessions?: SidebarSession[];
  workspaces?: SidebarWorkspace[];
  activeSeed?: string | null;
  /** 活动会话当前的即时待办列表(fast path,无需等待 15s 轮询)。 */
  activePending?: () => ApprovalView[];
  onCreate?: () => void;
  creating?: boolean;
  canCreate?: boolean;
  /** 移入工作区(`workspace.move_session`);只改组织归属,不动会话运行目录。 */
  onMove?: (seed: string, workspaceId: string) => void;
  /** 移出到未分组(`workspace.detach`)。 */
  onDetach?: (seed: string) => void;
}> = (props) => {
  const [collapsed, setCollapsedSignal] = createSignal<Set<string>>(readStoredCollapsed());
  const setCollapsed = (next: Set<string>): void => {
    setCollapsedSignal(next);
    try {
      localStorage.setItem(WORKSPACE_COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {}
  };
  /** 展开行菜单的会话 seed(null = 全部收起);同时只开一个。 */
  const [menuSeed, setMenuSeed] = createSignal<string | null>(null);
  const allSessions = () => props.sessions ?? sessionCatalog();
  const allWorkspaces = () => props.workspaces ?? workspaceCatalog();

  const groups = createMemo(() => {
    // 稳定排序工作区：order 升序，次级按 title 字典序
    const workspaces = [...allWorkspaces()].sort((a, b) => {
      const ord = (a.order ?? 0) - (b.order ?? 0);
      if (ord !== 0) return ord;
      return (a.title || "").localeCompare(b.title || "");
    });
    const sessions = allSessions().filter((item) => !item.archived);

    // 同一分组内会话的绝对确定性排序：主键 updated_at 降序，决胜键 session_id 字典序
    // 杜绝相等时间戳在 15s 轮询时由于后端返回数组随机顺序造成的抽搐跳动。
    const sortSessions = (list: SidebarSession[]): SidebarSession[] =>
      [...list].sort((a, b) => {
        const timeDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return a.session_id.localeCompare(b.session_id);
      });

    const grouped = workspaces.map((workspace) => ({
      id: workspace.id,
      title: workspace.title || pathName(workspace.path),
      path: workspace.path,
      sessions: sortSessions(sessions.filter((session) => sessionBelongsToWorkspace(session, workspace))),
    }));
    const ungrouped = sessions.filter((session) => !workspaces.some((workspace) => sessionBelongsToWorkspace(session, workspace)));
    if (ungrouped.length > 0) {
      grouped.push({
        id: "__ungrouped",
        title: "未分组",
        path: "",
        sessions: sortSessions(ungrouped),
      });
    }
    return grouped.filter((group) => group.sessions.length > 0);
  });

  const toggle = (id: string): void => {
    const next = new Set(collapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  return (
    <aside class="message-sidebar" aria-label="工作区与会话">
      <div class="message-sidebar-head">
        <span>工作区</span>
        <span class="message-sidebar-count">{allSessions().filter((item) => !item.archived).length}</span>
        <Show when={props.onCreate != null}>
          <button type="button" class="message-create" aria-label="新建会话" title="新建会话" disabled={props.creating || props.canCreate === false} onClick={() => props.onCreate?.()}><IconPlus /></button>
        </Show>
      </div>
      <div class="message-sidebar-groups">
        <Show when={groups().length > 0} fallback={<div class="message-sidebar-empty">暂无会话</div>}>
          {/* 按 id 做键,不按引用:`pollSessions` 每轮都用 IPC 新解出来的对象
              换掉整个目录(`tabs/store.ts:362`),引用键会让每次轮询把整棵侧栏
              卸载重建——悬停态、焦点、正在播的入场动画全被打断。 */}
          <For each={groups()} keyed={(group) => group.id}>{(group) => (
            <section class="message-workspace-group">
              <button
                class="message-workspace-toggle"
                type="button"
                aria-expanded={collapsed().has(group().id) ? "false" : "true"}
                onClick={() => toggle(group().id)}
                title={group().path || group().title}
              >
                <IconChevronDown class={{ collapsed: collapsed().has(group().id) }} />
                <Show when={group().id !== "__ungrouped"}><IconFolder /></Show>
                <span class="message-workspace-title">{group().title}</span>
                <span class="message-workspace-count">{group().sessions.length}</span>
              </button>
              <Show when={!collapsed().has(group().id)}>
                <div class="message-workspace-sessions">
                  <For each={group().sessions} keyed={(session) => session.session_id}>{(session) => {
                    const active = () => props.activeSeed === session().session_id;
                    const menuOpen = () => menuSeed() === session().session_id;
                    // 归属看「名录里真有这个工作区」,而不是 workspace_id 非空:
                    // 工作区被删后 id 仍留在卡片上,那种会话显示在未分组里,
                    // 再给它「移出」就成了无意义动作。
                    const grouped = () => allWorkspaces().some((workspace) => sessionBelongsToWorkspace(session(), workspace));
                    // 活动会话的待审批快轨 (Fast path):若是当前会话且内存已有待审批挑战，优先取第一项
                    const fastApproval = () => (active() ? props.activePending?.()[0] ?? null : null);
                    // 待人响应:整行让位给弹出卡(卡体 pointer-events:none,点击仍落到会话按钮)。
                    const pending = () => pendingPresentation(session(), fastApproval());
                    const isWorking = () => workingOnly(session(), pending() != null);
                    return (
                      <>
                        <div
                          class={{ "message-session-row": true, active: active() }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (props.onMove != null && allWorkspaces().length > 0) {
                              setMenuSeed(session().session_id);
                            }
                          }}
                        >
                          <button
                            class={{ "message-session-item": true, active: active(), running: isWorking() }}
                            type="button"
                            aria-current={active() ? "page" : undefined}
                            // 待响应时把状态挂到按钮的可访问名上:卡体是
                            // aria-hidden 的装饰(跑马灯文案重复,不能进朗读)。
                            aria-label={pending()?.ariaLabel}
                            onClick={() => props.onSelect(session().session_id)}
                            title={session().title || session().cwd || session().session_id}
                          >
                            <IconMessageSquare />
                            <span class="message-session-title">{sessionName(session())}</span>
                            <Show when={isWorking()}><i class="message-session-running" aria-label={STR.running} /></Show>
                            {/* 常驻挂载,不用 <Show> 包:状态一离开待人,父级若把组件
                                从树上摘掉,slide-out 就永远没机会播(卡片会瞬间消失,
                                而不是「原路滑回去」)。进出场由卡内相位机自己管。 */}
                            <SessionPendingCard session={session()} fastApproval={fastApproval()} />
                          </button>
                          <Show when={props.onMove != null && allWorkspaces().length > 0}>
                            <button
                              type="button"
                              class="message-session-more"
                              aria-label={`${STR.sessionActions}:${sessionName(session())}`}
                              aria-expanded={menuOpen() ? "true" : "false"}
                              title={STR.sessionActions}
                              onClick={() => setMenuSeed(menuOpen() ? null : session().session_id)}
                            >
                              <IconMoreHorizontal />
                            </button>
                          </Show>
                        </div>
                        <Show when={menuOpen()}>
                          {/* 行样式与首页/输入区的工作区菜单是同一份(`WorkspaceMenuItem`):
                              单行「目录 + 末段名」比原来的「名字 + 完整路径」两行矮一半,
                              侧栏里三层工作区一展开就不会把会话列表整个顶下去。 */}
                          <div class="message-session-menu" role="menu">
                            <strong>{STR.moveToWorkspace}</strong>
                            <For each={allWorkspaces()}>{(workspace) => (
                              <WorkspaceMenuItem
                                workspace={workspace}
                                selected={session().workspace_id === workspace.id}
                                compact
                                onPick={() => { setMenuSeed(null); props.onMove?.(session().session_id, workspace.id); }}
                              />
                            )}</For>
                            <Show when={grouped()}>
                              <button
                                type="button"
                                role="menuitem"
                                class="message-session-menu-detach"
                                onClick={() => { setMenuSeed(null); props.onDetach?.(session().session_id); }}
                              >
                                <span>{STR.detachWorkspace}</span>
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </>
                    );
                  }}</For>
                </div>
              </Show>
            </section>
          )}</For>
        </Show>
      </div>
    </aside>
  );
};
