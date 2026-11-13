import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconFolder from "~icons/lucide/folder";
import IconMessageSquare from "~icons/lucide/message-square";
import IconMoreHorizontal from "~icons/lucide/more-horizontal";
import IconPlus from "~icons/lucide/plus";
import { STR } from "../lib/strings";
import type { ApprovalView } from "../lib/transport";
import { sessionCatalog, sessionDot, workspaceCatalog, type SidebarSession, type SidebarWorkspace } from "../tabs/store";
import { parentSessionOf } from "../session/handoff-journal";
import { Collapse } from "../ui/Collapse";
import { SessionPendingCard } from "./SessionPendingCard";
import { createSelectionPill } from "./selection-pill";
import { pendingPresentation, workingOnly } from "./session-pending";

const pathName = (path: string | null | undefined): string => {
  const value = (path ?? "").replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名工作区";
};

const sessionBelongsToWorkspace = (session: SidebarSession, workspace: SidebarWorkspace): boolean => {
  return session.workspace_id === workspace.id;
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

/**
 * fork 血缘徽标文案;不是 fork 对话返回 null。
 *
 * 权威 = 读模型血缘字段 `SessionListEntry.handoff_from_session_id`(ADR-016
 * 切片 2 导出,内核 fork 与建行同事务写入);本地交接账本只剩升级前旧数据的
 * 兼容读取(旧数据没有后端血缘字段)。
 */
function forkLineage(seed: string, catalog: SidebarSession[]): string | null {
  const parentSeed = catalog.find((item) => item.session_id === seed)?.handoff_from_session_id ?? parentSessionOf(seed);
  if (parentSeed == null) return null;
  const parentTitle = catalog.find((item) => item.session_id === parentSeed)?.title?.trim();
  return parentTitle ? `${STR.forkBadgeTitle} · ${STR.forkFrom(parentTitle)}` : STR.forkBadgeTitle;
}

export const MessageSidebar: Component<{
  onSelect: (seed: string) => void;
  sessions?: SidebarSession[];
  workspaces?: SidebarWorkspace[];
  activeSeed?: string | null;
  /** 活动会话当前的即时待办列表(fast path,无需等待 15s 轮询)。 */
  activePending?: () => ApprovalView[];
  onCreate?: () => void;
  /**
   * 在**指定工作区**新建会话:把该目录设为新会话的粘性目标,再去启动页。
   * 不传即不渲染工作区行上的「+」(夹具页/宿主不合格时用这条关掉)。
   */
  onCreateIn?: (path: string) => void;
  creating?: boolean;
  canCreate?: boolean;
  onRename?: (seed: string, title: string) => Promise<void>;
  onDelete?: (seed: string) => Promise<void>;
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
      /** 目录已不存在:仍列出(里面的历史会话得看得见),但不给「在此新建会话」。 */
      missingDir: workspace.missing_dir === true,
      sessions: sortSessions(sessions.filter((session) => sessionBelongsToWorkspace(session, workspace))),
    }));
    const ungrouped = sessions.filter((session) => !workspaces.some((workspace) => sessionBelongsToWorkspace(session, workspace)));
    if (ungrouped.length > 0) {
      grouped.push({
        id: "__ungrouped",
        title: "未分组",
        path: "",
        missingDir: false,
        sessions: sortSessions(ungrouped),
      });
    }
    /* 零会话的工作区**也列出**。此前这里过滤掉了空组,于是「给一个还没开过会话的
     * 工作区起第一条对话」在侧栏根本没有落点——只能去输入区/启动页那颗目录 chip
     * 的菜单里绕。列出来还顺带回答「这个工作区我注册过吗」,组头的「+」就是它自己的入口。
     * 两类例外仍然不出现:「未分组」是伪组(零会话时上面那段 if 已经不放它进来),
     * 以及**目录已不存在又一条会话都没有**的组——那里既没内容可看也没法新建,留着
     * 只是一行再也点不动的死字。 */
    return grouped.filter((group) => group.sessions.length > 0 || group.missingDir !== true);
  });

  /** 「+」只在有明确目录、目录还在、且宿主允许新建时出现。 */
  const canCreateIn = (group: { path: string; missingDir: boolean }): boolean =>
    props.onCreateIn != null && group.path !== "" && group.missingDir !== true;

  const toggle = (id: string): void => {
    const next = new Set(collapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  /* ── 会话列表的 WinUI 选中指示器(共享 pill)────────────────────────────
   * 与设置分区导航共用 ./selection-pill 的 600ms 拉伸-跳变-收回公式。
   * 会话列表比导航多两类布局扰动,都交给驱动器的静默对位:
   *  - RO 观察列表内容包裹层(增删/折叠动画/字体加载都会改它的高度);
   *  - invalidation 挂 groups memo:15s 轮询换目录对象会按 updated_at 重排,
   *    活动行瞬移时盒子尺寸不变、RO 抓不到,靠这条兜住。 */
  const [groupsEl, setGroupsEl] = createSignal<HTMLElement | undefined>();
  const [sessionPillEl, setSessionPillEl] = createSignal<HTMLElement | undefined>();
  createSelectionPill({
    container: groupsEl,
    pill: sessionPillEl,
    selection: () => props.activeSeed ?? null,
    findTarget: (el) => el.querySelector<HTMLElement>('.message-session-item[aria-current="page"]'),
    observe: (el) => [el.querySelector(".message-sidebar-list") ?? el],
    invalidation: groups,
  });

  return (
    <aside class="message-sidebar" aria-label="会话列表">
      <div class="message-sidebar-head">
        {/* §8.6:侧栏头部叫「会话」;「工作区」只用于下面的分组名,同屏不出现两个「工作区」。 */}
        <span>会话</span>
        <span class="message-sidebar-count">{allSessions().filter((item) => !item.archived).length}</span>
        <Show when={props.onCreate != null}>
          <button type="button" class="message-create" aria-label="新建会话" title="新建会话" disabled={props.creating || props.canCreate === false} onClick={() => props.onCreate?.()}><IconPlus /></button>
        </Show>
      </div>
      <div class="message-sidebar-groups" ref={setGroupsEl}>
        <span class="message-session-pill" aria-hidden="true" ref={setSessionPillEl} />
        <div class="message-sidebar-list">
        <Show when={groups().length > 0} fallback={<div class="message-sidebar-empty">暂无会话</div>}>
          {/* 按 id 做键,不按引用:`pollSessions` 每轮都用 IPC 新解出来的对象
              换掉整个目录(`tabs/store.ts:362`),引用键会让每次轮询把整棵侧栏
              卸载重建——悬停态、焦点、正在播的入场动画全被打断。 */}
          <For each={groups()} keyed={(group) => group.id}>{(group) => (
            <section class="message-workspace-group">
              {/* 工作区行 = 折叠钮 + 「在此工作区新建会话」。动作钮常占位、悬停/聚焦才显形
                  (与会话行的「…」同一条规则,见 sidebar.css):hover 只改表面不改布局,
                  否则目录名会在鼠标经过时整段左右抖。 */}
              <div class="message-workspace-row">
                <button
                  class="message-workspace-toggle"
                  type="button"
                  aria-expanded={collapsed().has(group().id) ? "false" : "true"}
                  onClick={() => toggle(group().id)}
                  title={group().missingDir
                    ? `${group().path || group().title}（目录已不存在）`
                    : group().path || group().title}
                >
                  <IconChevronDown class={{ collapsed: collapsed().has(group().id) }} />
                  <Show when={group().id !== "__ungrouped"}><IconFolder /></Show>
                  <span class="message-workspace-title">{group().title}</span>
                  <span class="message-workspace-count">{group().sessions.length}</span>
                </button>
                <Show when={canCreateIn(group())}>
                  <button
                    type="button"
                    class="message-workspace-create"
                    aria-label={`在 ${group().title} 新建会话`}
                    title={`在 ${group().title} 新建会话${group().sessions.length === 0 ? "（该工作区还没有会话）" : ""}`}
                    disabled={props.creating === true || props.canCreate === false}
                    onClick={() => props.onCreateIn?.(group().path)}
                  >
                    <IconPlus />
                  </button>
                </Show>
              </div>
              {/* 分组收展(motion kit):走共用 Collapse(0fr↔1fr + opacity),
                  播完 out 过渡再卸载——历史会话列表的文本量不小,卸载纪律保留。 */}
              <Collapse open={!collapsed().has(group().id)}>
                <div class="message-workspace-sessions">
                  <For each={group().sessions} keyed={(session) => session.session_id}>{(session) => {
                    const active = () => props.activeSeed === session().session_id;
                    const menuOpen = () => menuSeed() === session().session_id;
                    const [editing, setEditing] = createSignal(false);
                    const [draft, setDraft] = createSignal("");
                    const [confirmDelete, setConfirmDelete] = createSignal(false);
                    const [actionBusy, setActionBusy] = createSignal(false);
                    let renameInput: HTMLInputElement | undefined;
                    const beginRename = (): void => {
                      setDraft(sessionName(session()));
                      setConfirmDelete(false);
                      setEditing(true);
                      requestAnimationFrame(() => {
                        renameInput?.focus();
                        renameInput?.select();
                      });
                    };
                    const closeMenu = (): void => {
                      setMenuSeed(null);
                      setEditing(false);
                      setConfirmDelete(false);
                    };
                    const openMenu = (): void => {
                      setEditing(false);
                      setConfirmDelete(false);
                      setMenuSeed(session().session_id);
                    };
                    const commitRename = async (event: SubmitEvent): Promise<void> => {
                      event.preventDefault();
                      const title = draft().trim();
                      if (!title) {
                        renameInput?.focus();
                        return;
                      }
                      setActionBusy(true);
                      try {
                        await props.onRename?.(session().session_id, title);
                        closeMenu();
                      } finally {
                        setActionBusy(false);
                      }
                    };
                    const removeSession = async (): Promise<void> => {
                      setActionBusy(true);
                      try {
                        await props.onDelete?.(session().session_id);
                        closeMenu();
                      } finally {
                        setActionBusy(false);
                      }
                    };
                    // 活动会话的待审批快轨 (Fast path):若是当前会话且内存已有待审批挑战，优先取第一项
                    const fastApproval = () => (active() ? props.activePending?.()[0] ?? null : null);
                    // 待人响应:整行让位给弹出卡(卡体 pointer-events:none,点击仍落到会话按钮)。
                    const pending = () => pendingPresentation(session(), fastApproval());
                    const isWorking = () => workingOnly(session(), pending() != null);
                    return (
                      <>
                        <div
                          class={{ "message-session-row": true, active: active() }}
                          // 飞箱落点锚(box-fly 按会话 id 找行,见 ui/box-fly.ts)。
                          data-session-id={session().session_id}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (props.onRename != null || props.onDelete != null) {
                              openMenu();
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
                            <Show when={session().tool_mode != null && session().tool_mode !== "standard"}>
                              <span class="message-session-toolmode" title={`工具模式：${session().tool_mode}`}>{session().tool_mode}</span>
                            </Show>
                            {/* fork 交接对话徽标(本地账本现算,理由见 forkLineage)。 */}
                            <Show when={forkLineage(session().session_id, allSessions())}>
                              {(lineage) => <span class="message-session-fork" title={lineage()}>{STR.forkBadge}</span>}
                            </Show>
                            {/* 六态点:蓝=工作中/脉动=等你回应/灰=取消中;终态绿红灰只在
                                本次壳生命周期目击过权威 outcome 时点亮(冷启动无点)。 */}
                            <Show when={sessionDot(session().session_id, session().status)}>
                              {(kind) => <i class={`message-session-dot is-${kind()}`} aria-label={STR.dotTitles[kind()]} title={STR.dotTitles[kind()]} />}
                            </Show>
                            {/* 常驻挂载,不用 <Show> 包:状态一离开待人,父级若把组件
                                从树上摘掉,slide-out 就永远没机会播(卡片会瞬间消失,
                                而不是「原路滑回去」)。进出场由卡内相位机自己管。 */}
                            <SessionPendingCard session={session()} fastApproval={fastApproval()} />
                          </button>
                          <Show when={props.onRename != null || props.onDelete != null}>
                            <button
                              type="button"
                              class="message-session-more"
                              aria-label={`${STR.sessionActions}:${sessionName(session())}`}
                              aria-expanded={menuOpen() ? "true" : "false"}
                              title={STR.sessionActions}
                              onClick={() => menuOpen() ? closeMenu() : openMenu()}
                            >
                              <IconMoreHorizontal />
                            </button>
                          </Show>
                        </div>
                        <Show when={menuOpen()}>
                          <div class="message-session-menu" role="menu">
                            <strong>{STR.sessionActions}</strong>
                            <Show when={editing()} fallback={
                              <Show when={confirmDelete()} fallback={
                                <>
                                  <Show when={props.onRename != null}>
                                    <button type="button" role="menuitem" onClick={beginRename}>{STR.renameSession}</button>
                                  </Show>
                                  <Show when={props.onDelete != null}>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      class="message-session-menu-danger"
                                      onClick={() => setConfirmDelete(true)}
                                    >
                                      {STR.deleteSession}
                                    </button>
                                  </Show>
                                </>
                              }>
                                <div class="message-session-menu-confirm">
                                  <p>{STR.confirmDeleteSession(sessionName(session()))}</p>
                                  <small>{STR.deleteSessionWarning}</small>
                                  <div class="message-session-menu-actions">
                                    <button type="button" disabled={actionBusy()} onClick={closeMenu}>{STR.cancelAction}</button>
                                    <button
                                      type="button"
                                      class="message-session-menu-danger"
                                      disabled={actionBusy()}
                                      onClick={() => void removeSession()}
                                    >
                                      {STR.confirmDeleteAction}
                                    </button>
                                  </div>
                                </div>
                              </Show>
                            }>
                              <form class="message-session-menu-form" onSubmit={(event) => void commitRename(event)}>
                                <input
                                  ref={renameInput}
                                  aria-label={STR.renameSession}
                                  value={draft()}
                                  onInput={(event) => setDraft(event.currentTarget.value)}
                                />
                                <div class="message-session-menu-actions">
                                  <button type="button" disabled={actionBusy()} onClick={closeMenu}>{STR.cancelAction}</button>
                                  <button type="submit" disabled={actionBusy() || !draft().trim()}>{STR.saveAction}</button>
                                </div>
                              </form>
                            </Show>
                          </div>
                        </Show>
                      </>
                    );
                  }}</For>
                </div>
              </Collapse>
            </section>
          )}</For>
        </Show>
        </div>
      </div>
    </aside>
  );
};
