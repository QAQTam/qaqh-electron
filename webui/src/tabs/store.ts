/**
 * 标签页与会话路由(spec §5)。
 *
 * 一个标签 = 一个会话;关闭标签 = 退订宿主事件,不取消运行中的 Turn、不取消
 * 待处理授权(后端常驻,D2:本阶段无法重新打开已关闭标签)。
 * 非活动标签卸载 DOM,仅保留 store 数据(§5.3)。
 *
 * 会话创建(spec §5.1「+」):经控制通道 SessionCreate,轮询 sessions 列表
 * 找出新 seed。宿主模式下 SessionCreate 不要求 active seed,空会话也可创建。
 */
import { createSignal, createStore } from "solid-js";
import type { SessionRunStatus } from "../api/qaqh/SessionRunStatus";
import { withViewTransition } from "../ui/viewTransition";
import { transport } from "../lib/transport";
import { STR } from "../lib/strings";
import { SessionStore } from "../session/store";
import { overlayLocalTitles } from "../session/title-override";
import { toast } from "../ui/toast";
import type { ContentRef } from "../api/qaqh/ContentRef";

export interface Tab {
  id: string;
  seed: string;
  store: SessionStore;
}

const [tabs, setTabs] = createSignal<Tab[]>([]);
const [activeId, setActiveId] = createSignal<string | null>(null);
const [isStartup, setIsStartup] = createSignal(false);
const [bootError, setBootErrorSignal] = createSignal<string | null>(null);
// setBootError 由本模块内部与 App 兜底路径共用;导出名见文件底部。
const [creating, setCreating] = createSignal(false);
/**
 * 侧栏卡片字段 = 宿主 `SidebarSession`(src-tauri/src/commands.rs)的同名镜像:
 * 两边改一边,`commands.rs` 的 sidebar_projection_* 会红。
 */
export type SidebarSession = {
  session_id: string;
  title?: string | null;
  cwd?: string | null;
  updated_at?: number;
  archived?: boolean;
  /**
   * 回合在跑,或卡在用户这一侧(授权/ask/计划评审)。宿主按 `SessionRunStatus`
   * 折算(`commands.rs:session_is_busy`),不再是从前的 `running`(进程存在性)。
   */
  busy?: boolean;
  /**
   * 后端 8 态 `SessionRunStatus` 原样透传(宿主 `commands.rs` 同名镜像)。
   * 待人响应的三态(`waiting_permission` / `waiting_ask` / `waiting_plan`)由
   * 它判出——`busy` 折成 bool 后无法区分「在跑」与「等人」,弹卡必须读这个。
   */
  status?: SessionRunStatus;
  /** 会话轮次数:后台标签状态点用它判断「跑过东西但没在跑」(§5.2)。 */
  turn_count?: number;
  workspace_id?: string | null;
};
export type SidebarWorkspace = { id: string; title: string; path: string; order: number; missing_dir?: boolean };
const [sessionCatalog, setSessionCatalog] = createSignal<SidebarSession[]>([]);
const [workspaceCatalog, setWorkspaceCatalog] = createSignal<SidebarWorkspace[]>([]);
const DRAFT_PREFIX = "qaqh.draft.";
const WORKSPACE_CWD_KEY = "qaqh.workspace.cwd";
const TITLE_PREFIX = "qaqh.session.title.";

function readStoredDrafts(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DRAFT_PREFIX)) {
        const seed = key.slice(DRAFT_PREFIX.length);
        const val = localStorage.getItem(key);
        if (val) result[seed] = val;
      }
    }
  } catch {
    // 隐私模式或无 storage 时退回空对象
  }
  return result;
}

function readStoredCwd(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_CWD_KEY);
  } catch {
    return null;
  }
}

/**
 * 新建会话的目标工作区(`cwd`),null = 未指定 → daemon 默认(未分组)。
 *
 * 只作用于**新建**:已开会话的 cwd 钉在 `SessionMeta.cwd` 上,改它要走
 * `workspace.set`,是另一条路径。选择保持粘性——建完不重置,输入区一直显示
 * 当前目标,免得连开几个会话时猜「这次会落哪」。
 */
const [newSessionCwd, setNewSessionCwdSignal] = createSignal<string | null>(readStoredCwd());
const setNewSessionCwd = (value: string | null): void => {
  setNewSessionCwdSignal(value);
  try {
    if (value != null) localStorage.setItem(WORKSPACE_CWD_KEY, value);
    else localStorage.removeItem(WORKSPACE_CWD_KEY);
  } catch {}
};

const [drafts, setDrafts] = createStore<Record<string, string>>(readStoredDrafts());

/**
 * Startup 页暂存的附件路径(首条消息发出时才上传,见 `submitStartupSession`)。
 *
 * 这份列表原本是 `StartupView` 的组件局部信号,全局快捷键够不着它——于是"还没建
 * 会话时按截图键"要么没反应、要么截了没地方放。提到模块层,和 `newSessionCwd`、
 * 草稿同级:它们本来就是"这一次新会话的输入状态"。
 */
const [startupAttachments, setStartupAttachments] = createSignal<string[]>([]);

/** 去重挂上:同一张截图连按两次不该出现两个 chip(路径就是键)。 */
export const stageStartupAttachments = (paths: readonly string[]): void => {
  if (paths.length === 0) return;
  setStartupAttachments((current) => [...new Set([...current, ...paths])]);
};

export const removeStartupAttachment = (path: string): void => {
  setStartupAttachments((current) => current.filter((item) => item !== path));
};

export const clearStartupAttachments = (): void => {
  setStartupAttachments([]);
};

/**
 * 方案A:后端尚未生成标题时的本地重命名覆盖(存储 + 侧栏投影)。
 * 优先级语义(用户拍板):后端标题恒优先,本地覆盖只在 title_changed 到达前
 * 有效;后端持久化是方案B(Rust `session.rename`),见
 * docs/session-rename-persistence-plan.md。
 */
function readStoredTitles(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(TITLE_PREFIX)) {
        const seed = key.slice(TITLE_PREFIX.length);
        const val = localStorage.getItem(key);
        if (val) result[seed] = val;
      }
    }
  } catch {
    // 隐私模式或无 storage 时退回空对象
  }
  return result;
}

const [localTitles, setLocalTitles] = createSignal<Record<string, string>>(readStoredTitles());
const setLocalTitleOf = (seed: string, value: string): void => {
  setLocalTitles((map) => {
    const next = { ...map };
    if (value.trim()) next[seed] = value;
    else delete next[seed];
    return next;
  });
  try {
    if (value.trim()) localStorage.setItem(`${TITLE_PREFIX}${seed}`, value);
    else localStorage.removeItem(`${TITLE_PREFIX}${seed}`);
  } catch {}
};
export const localTitleOf = (seed: string): string => localTitles()[seed] ?? "";

/**
 * 本地重命名落两处:覆盖表(localStorage 持久化)+ 侧栏目录
 * (仅当后端还没给标题;后端标题到达时 onSessionTitleChanged 会清掉覆盖)。
 */
export const renameLocalSession = (seed: string, title: string): void => {
  setLocalTitleOf(seed, title);
  setSessionCatalog((list) => list.map((item) =>
    String(item.session_id) === seed && !String(item.title ?? "").trim() ? { ...item, title } : item,
  ));
};

/** 侧栏目录投影:后端标题优先,后端缺标题时叠本地覆盖;顺带清理陈旧覆盖条目。 */
function applySessionList(list: SidebarSession[]): void {
  const { merged, staleSeeds } = overlayLocalTitles(list, localTitles());
  setSessionCatalog(merged);
  for (const seed of staleSeeds) setLocalTitleOf(seed, "");
}
/** 焦点令牌:切标签/新建时 +1,Composer 响应后聚焦。 */
const [focusToken, setFocusToken] = createSignal(0);
/** Serialize singleton-host attach calls; rapid tab changes must settle on the latest tab. */
let activationQueue: Promise<void> = Promise.resolve();
/**
 * 最近一次请求激活的标签 id,`null` = 回到启动页。
 *
 * 必须同步写入而不是读 `activeId()`:`withViewTransition` 的 View Transition 回调
 * 是**异步**的(排到下一帧),`setActiveId` 要到那时才生效;而排队中的 activation
 * 在微任务里就跑,读 `activeId()` 会拿到旧值,把「刚点开的标签」误判成「被后来的
 * 点击取代」而整段 return —— 结果标签高亮但 store 从不 activate(不 attach、不订阅)。
 */
let activationTargetId: string | null = null;

export {
  tabs,
  activeId,
  isStartup,
  setIsStartup,
  bootError,
  creating,
  focusToken,
  sessionCatalog,
  workspaceCatalog,
  newSessionCwd,
  setNewSessionCwd,
  startupAttachments,
};
export const setBootError = (value: string | null): void => {
  setBootErrorSignal(value);
};
export const activeTab = (): Tab | null => tabs().find((tab) => tab.id === activeId()) ?? null;
export const draftOf = (seed: string): string => drafts[seed] ?? "";
export const setDraftOf = (seed: string, value: string): void => {
  setDrafts((draft) => { draft[seed] = value; });
  try {
    if (value.trim()) localStorage.setItem(`${DRAFT_PREFIX}${seed}`, value);
    else localStorage.removeItem(`${DRAFT_PREFIX}${seed}`);
  } catch {}
};

export function openStartup(): void {
  // 回到启动页 = 取消在飞的激活:让排队中的 activation 不再 proceed。
  activationTargetId = null;
  withViewTransition(() => {
    setIsStartup(true);
    setActiveId(null);
    for (const other of tabs()) {
      other.store.deactivate();
    }
  });
  setFocusToken(focusToken() + 1);
}

function addTab(seed: string): Tab {
  const existing = tabs().find((tab) => tab.seed === seed);
  if (existing != null) return existing;
  const tab: Tab = { id: `tab-${seed}`, seed, store: new SessionStore(seed) };
  // 会话元数据变更接给标签层:store 只有已 attach 的那条流,所以这里只管活动
  // 会话的即时刷新,后台会话仍靠 pollSessions 的列表重拉兜底。
  tab.store.onSessionsChanged = () => { void pollSessions(); };
  tab.store.onSessionTitleChanged = (title) => {
    // 后端标题已生成(title_changed):本地覆盖退场(后端优先语义)。
    if (title.trim()) setLocalTitleOf(seed, "");
    setSessionCatalog((list) => list.map((item) =>
      String(item.session_id) === seed ? { ...item, title } : item,
    ));
  };
  tab.store.onSessionDeleted = () => { void dropSession(seed); };
  setTabs((list) => [...list, tab]);
  return tab;
}

/** 激活标签:宿主 attach 切 active seed + 重建流 → 该 store 订阅,其余退订。 */
export async function activateTab(tab: Tab): Promise<void> {
  // 先同步记下「要激活谁」——见 activationTargetId 的说明,不能读被 VT 推迟的 activeId。
  activationTargetId = tab.id;
  // 只包同步的「内容换血」信号写入;attach/RPC 留在外面,别把旧快照冻屏。
  withViewTransition(() => {
    setIsStartup(false);
    setActiveId(tab.id);
    for (const other of tabs()) {
      if (other.id !== tab.id) other.store.deactivate();
    }
  });
  setFocusToken(focusToken() + 1);
  const activation = activationQueue.catch(() => {}).then(async () => {
    // A rapid later click supersedes queued work before it can attach.
    if (activationTargetId !== tab.id) return;
    try {
      await tab.store.activate();
      if (activationTargetId !== tab.id) {
        tab.store.deactivate();
        return;
      }
      setBootError(null);
    } catch (error) {
      if (activationTargetId === tab.id) setBootError(String(error instanceof Error ? error.message : error));
    }
  });
  activationQueue = activation;
  await activation;
}

export async function openSession(seed: string): Promise<Tab | null> {
  const tab = addTab(seed);
  await activateTab(tab);
  // 直接返回目标 tab,不走 activeId():那是 withViewTransition 异步回调才写入的,
  // 紧随其后的调用者(启动页原子提交)会在夹具/快速时序下读到 null。
  return tabs().some((item) => item.id === tab.id) ? tab : null;
}

export async function closeTab(tabId: string): Promise<void> {
  const list = tabs();
  const index = list.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  const tab = list[index]!;
  const wasActive = activeId() === tabId;
  setTabs(list.filter((item) => item.id !== tabId));
  setDrafts((draft) => { delete draft[tab.seed]; });
  tab.store.dispose();
  if (wasActive) {
    const next = list[index - 1] ?? list[index + 1] ?? null;
    if (next != null) await activateTab(next);
    else openStartup();
  }
}

/**
 * 依据指定 cwd 创建新会话并返回新分配的 session_id。
 */
export async function createSessionWithCwd(cwd?: string | null): Promise<string> {
  const before = new Set((await transport.sessions()).map((item) => String(item.session_id)));
  await transport.command("control", {
    channel: "control",
    type: "session_create",
    close_current: false,
    cwd: cwd ?? null,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const list = await transport.sessions();
    applySessionList(list as SidebarSession[]);
    const fresh = list.map((item) => String(item.session_id)).find((id) => !before.has(id));
    if (fresh != null) {
      return fresh;
    }
  }
  throw new Error("会话创建超时");
}

/**
 * 新建会话:控制通道 SessionCreate → 轮询 sessions 找新 seed(≤6s)。
 *
 * `cwd` 取输入区的目标工作区(`newSessionCwd`);daemon 透传给 `session.new`,
 * 落 `SessionMeta.cwd` 并触发 workspace 自动归属。
 */
export async function createSession(cwd?: string | null): Promise<void> {
  if (creating()) return;
  setCreating(true);
  try {
    const fresh = await createSessionWithCwd(cwd ?? newSessionCwd());
    await openSession(fresh);
  } catch (error) {
    setBootError(String(error instanceof Error ? error.message : error));
  } finally {
    setCreating(false);
  }
}

export interface StartupSubmitOptions {
  cwd: string | null;
  profile?: string | null;
  text: string;
  attachmentPaths?: string[];
}

/**
 * Startup 首页延迟创建会话与首包发送事务:
 * 1. 带目标 cwd 创建会话
 * 2. 绑定 profile (若指定)
 * 3. 上传本地暂存的附件 (若有)
 * 4. 打开会话并发送第一条用户消息
 */
/** 返回是否成功提交;false = 创建/发送失败(调用方据此保留草稿)。 */
export async function submitStartupSession(options: StartupSubmitOptions): Promise<boolean> {
  if (creating()) return false;
  setCreating(true);
  try {
    const fresh = await createSessionWithCwd(options.cwd);
    if (options.profile) {
      try {
        await transport.rpc("session.set_profile", { name: options.profile }, fresh);
      } catch (err) {
        console.warn("set_profile failed on new session", err);
      }
    }
    const uploadedRefs: ContentRef[] = [];
    if (options.attachmentPaths && options.attachmentPaths.length > 0) {
      for (const path of options.attachmentPaths) {
        try {
          const uploaded = await transport.uploadAttachment(fresh, path);
          uploadedRefs.push({
            content_id: uploaded.content_id,
            media_type: uploaded.media_type,
            sha256: uploaded.sha256,
            truncated: uploaded.truncated,
          });
        } catch (err) {
          toast(`附件上传失败: ${path}`, "err");
        }
      }
    }
    const tab = await openSession(fresh);
    if (tab != null) {
      await tab.store.sendMessageWithAttachments(options.text, uploadedRefs);
    }
    setIsStartup(false);
    return true;
  } catch (error) {
    toast(`创建会话失败：${error instanceof Error ? error.message : String(error)}`, "err");
    setBootError(String(error instanceof Error ? error.message : error));
    return false;
  } finally {
    setCreating(false);
  }
}

/**
 * 注册目录为工作区(`workspace.create`)。后端按 canonical 路径查重,重复注册
 * 返回既有条目,所以「再选一次同一个文件夹」是幂等的。
 */
export async function registerWorkspace(path: string): Promise<SidebarWorkspace | null> {
  try {
    const created = await transport.rpc<SidebarWorkspace>("workspace.create", { path });
    await pollSessions();
    return created;
  } catch (error) {
    toast(`${STR.workspaceRegisterFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
    return null;
  }
}

/**
 * 原生选目录 → 注册 → 设为新建会话的目标。
 *
 * 取消(null)静默返回:浏览器预览没有原生对话框,固定回 null,不该在这里弹错。
 * 注册失败仍把选中路径设为目标——目录被删之类的注册失败,不该连「按这个目录
 * 开会话」一起否掉,那种会话只是落进「未分组」。
 */
export async function chooseNewSessionFolder(): Promise<void> {
  let picked: string | null = null;
  try {
    picked = await transport.pickDirectory();
  } catch (error) {
    toast(`${STR.workspacePickerFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
    return;
  }
  if (picked == null) return;
  const workspace = await registerWorkspace(picked);
  setNewSessionCwd(workspace?.path ?? picked);
}

/**
 * 把会话移入指定工作区(`workspace.move_session`):只改组织归属,不碰会话的
 * `SessionMeta.cwd`——运行目录归 `workspace.set`,是另一条路径。
 *
 * seed 由参数显式给(不靠宿主注入的活动会话):侧栏能对任意一条会话操作。
 */
export async function moveSessionToWorkspace(seed: string, workspaceId: string): Promise<void> {
  try {
    await transport.rpc("workspace.move_session", { session_id: seed, workspace_id: workspaceId });
    await pollSessions();
  } catch (error) {
    toast(`${STR.moveSessionFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
  }
}

/** 把会话移出工作区 → 未分组(`workspace.detach`)。 */
export async function detachSessionFromWorkspace(seed: string): Promise<void> {
  try {
    await transport.rpc("workspace.detach", { session_id: seed });
    await pollSessions();
  } catch (error) {
    toast(`${STR.detachSessionFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
  }
}

/**
 * 轮询 sessions 列表:标题/turn_count 驱动后台状态点(§5.2)。
 *
 * in-flight 合并:15s 定时器、窗口聚焦、meta 频道事件会同时来敲,同一时刻只留
 * 一条 `session.list` 在飞,其余调用复用同一个 promise。
 */
let sessionsFlight: Promise<void> | null = null;

export function pollSessions(): Promise<void> {
  sessionsFlight ??= pullSessions().finally(() => { sessionsFlight = null; });
  return sessionsFlight;
}

async function pullSessions(): Promise<void> {
  try {
    const [list, workspaces] = await Promise.all([
      transport.sessions() as Promise<SidebarSession[]>,
      transport.rpc<SidebarWorkspace[]>("workspace.list").catch(() => []),
    ]);
    applySessionList(list);
    setWorkspaceCatalog(workspaces);
    for (const item of list) {
      const tab = tabs().find((candidate) => candidate.seed === String(item.session_id));
      if (tab == null) continue;
      tab.store.applySessionMeta({
        title: typeof item.title === "string" ? item.title : null,
        turn_count: typeof item.turn_count === "number" ? item.turn_count : undefined,
      });
    }
  } catch {
    // 轮询失败静默,下一轮再取。
  }
}

/**
 * 会话被 daemon 判了终态(`MetaDelta::Deleted`):目录项立刻摘除,标签一并关掉。
 * 留着它只会让下一次点击变成「快照拉不到」的错误屏。
 */
async function dropSession(seed: string): Promise<void> {
  setSessionCatalog(sessionCatalog().filter((item) => String(item.session_id) !== seed));
  const tab = tabs().find((candidate) => candidate.seed === seed);
  if (tab != null) await closeTab(tab.id);
}

/** 启动:选一个非归档会话(优先运行中)作为第一个标签。 */
export async function boot(): Promise<void> {
  const [list, workspaces] = await Promise.all([
    transport.sessions() as Promise<SidebarSession[]>,
    transport.rpc<SidebarWorkspace[]>("workspace.list").catch(() => []),
  ]);
  applySessionList(list);
  setWorkspaceCatalog(workspaces);
  const live = list.find((item) => !item.archived && item.busy) ?? list.find((item) => !item.archived) ?? list[0];
  if (live?.session_id == null) {
    setBootError(null);
    openStartup();
    return;
  }
  await openSession(String(live.session_id));
}

