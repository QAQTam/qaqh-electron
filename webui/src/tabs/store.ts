/**
 * 标签页与会话路由(spec §5)。
 *
 * 一个标签 = 一个会话;关闭标签 = 退订宿主事件,不取消运行中的 Turn、不取消
 * 待处理授权(后端常驻,D2:本阶段无法重新打开已关闭标签)。
 * 非活动标签卸载 DOM,仅保留 store 数据(§5.3)。
 *
 * 会话创建(spec §5.1「+」):`session.create` 原子返回新 seed。
 */
import { createSignal, createStore } from "solid-js";
import type { SessionRunStatus } from "../api/qaqh/SessionRunStatus";
import type { TurnOutcome } from "../api/qaqh/TurnOutcome";
import { withViewTransition } from "../ui/viewTransition";
import { sessionTarget, transport } from "../lib/transport";
import { notifyConfigChanged } from "../lib/config-events";
import { STR } from "../lib/strings";
import { SessionStore, attachmentName, type PendingAttachment } from "../session/store";
import { overlayLocalTitles } from "../session/title-override";
import { forkRecordOfFact, markHandoffDelivered, recordHandoffFork } from "../session/handoff-journal";
import type { HandoffFact } from "../session/handoff";
import { toast } from "../ui/toast";
import type { ModelSelection } from "../api/qaqh/ModelSelection";
import type { SessionContentRef } from "../api/qaqh/SessionContentRef";
import type { WorkspaceEntry } from "../api/qaqh/WorkspaceEntry";
import {
  EMPTY_PREFLIGHT,
  readPreflight,
  writePreflight,
  type StartupPreflight,
} from "../composer/startup-preflight";

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
 * 侧栏卡片字段 = 宿主 `SidebarSession`(qaqh-electron/src/main/ipc-handlers.ts)的同名镜像:
 * 两边改一边,`ipc-handlers.ts` 的 sidebar_projection_* 会红。
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
   * 后端 `SessionRunStatus` 原样透传(宿主 `commands.rs` 同名镜像)。
   * `waiting_user` 标记等待交互;交互类型由活动 approval 快照提供。
   */
  status?: SessionRunStatus;
  /** 会话轮次数:后台标签状态点用它判断「跑过东西但没在跑」(§5.2)。 */
  turn_count?: number;
  workspace_id?: string | null;
  /** 会话工具模式(standard、minimal 家族、custom);空串/缺省 = standard,侧栏不显示 badge。 */
  tool_mode?: string | null;
};
export type SidebarWorkspace = { id: string; title: string; path: string; order: number; missing_dir?: boolean };
function workspaceEntryToSidebar(entry: WorkspaceEntry): SidebarWorkspace {
  return { id: entry.id, path: entry.path, title: entry.title, order: entry.order, missing_dir: entry.missing_dir };
}
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

/**
 * 启动页预检态(阶段B):下一条会话的模型/强度/工具模式草稿。与 `newSessionCwd`、
 * `startupAttachments` 同级——它们本来就是「这一次新会话的输入状态」三件套。
 *
 * 这里只放**信号与落存**;叶子判合(换模型清叶子、无整对时以存档默认为底)全在
 * `composer/startup-preflight.ts` 的纯函数里,写口由启动页把 registry() 快照递进去。
 * 语义与发送组装见该文件头注释;`null`/`""` 都是「跟随存档」,不是「未加载」。
 */
function storedPreflight(): StartupPreflight {
  try {
    return readPreflight(localStorage);
  } catch {
    return EMPTY_PREFLIGHT;
  }
}
const [startupPreflight, setStartupPreflightSignal] = createSignal<StartupPreflight>(storedPreflight());
export const setStartupPreflight = (value: StartupPreflight): void => {
  setStartupPreflightSignal(value);
  try {
    writePreflight(localStorage, value);
  } catch {
    // 引用 localStorage 本身可能在无 storage 的环境抛错;内存态照常。
  }
};

const [drafts, setDrafts] = createStore<Record<string, string>>(readStoredDrafts());

/**
 * 草稿持久化节流(2026-11-10 性能修复):打字管线以 store 为唯一权威写口;
 * `localStorage` 不再每键写全串(实测每键全量序列化的成本随草稿长度线性增长,
 * 是 O(n²) 打字总成本的一层),改为尾沿合并:挂一个计时器,到点写「当下最新值」。
 * pagehide/beforeunload 立即冲刷,窗口关闭不丢最后一段草稿。
 */
const DRAFT_PERSIST_DELAY_MS = 500;
const draftPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const draftPersistLatest = new Map<string, string>();

function persistDraftNow(seed: string): void {
  const timer = draftPersistTimers.get(seed);
  if (timer !== undefined) { clearTimeout(timer); draftPersistTimers.delete(seed); }
  if (!draftPersistLatest.has(seed)) return;
  const value = draftPersistLatest.get(seed) ?? "";
  draftPersistLatest.delete(seed);
  try {
    if (value.trim()) localStorage.setItem(`${DRAFT_PREFIX}${seed}`, value);
    else localStorage.removeItem(`${DRAFT_PREFIX}${seed}`);
  } catch {}
}

/** 标签/会话消失:撤销在写计划,并**无条件**清掉存储里的旧草稿(修泄漏:此前删 tab 只清了 store)。 */
function dropDraftPersistence(seed: string): void {
  const timer = draftPersistTimers.get(seed);
  if (timer !== undefined) { clearTimeout(timer); draftPersistTimers.delete(seed); }
  draftPersistLatest.delete(seed);
  try { localStorage.removeItem(`${DRAFT_PREFIX}${seed}`); } catch {}
}

if (typeof window !== "undefined") {
  const flushDrafts = (): void => {
    for (const seed of [...draftPersistLatest.keys()]) persistDraftNow(seed);
  };
  window.addEventListener("pagehide", flushDrafts);
  window.addEventListener("beforeunload", flushDrafts);
}

/**
 * Startup 页暂存的附件(首条消息发出时才上传,见 `submitStartupSession`)。
 *
 * 这份列表原本是 `StartupView` 的组件局部信号,全局快捷键够不着它——于是"还没建
 * 会话时按截图键"要么没反应、要么截了没地方放。提到模块层,和 `newSessionCwd`、
 * 草稿同级:它们本来就是"这一次新会话的输入状态"。
 *
 * 阶段B 起改为 `PendingAttachment[]`:启动页的输入区就是会话页那份 `Composer`,
 * chip 状态机只有一套。这里的 `ready` 与**已上传**是两回事——还没有 seed 可传,
 * `reference` 恒 null,上传发生在发送那一刻、按 `id`(本机路径)逐个进行。
 */
const [startupAttachments, setStartupAttachments] = createSignal<PendingAttachment[]>([]);

/** 去重挂上:同一张截图连按两次不该出现两个 chip(路径就是键)。 */
export const stageStartupAttachments = (paths: readonly string[]): void => {
  if (paths.length === 0) return;
  setStartupAttachments((current) => {
    const known = new Set(current.map((item) => item.id));
    const added: PendingAttachment[] = [];
    for (const path of paths) {
      if (known.has(path)) continue;
      known.add(path);
      added.push({
        id: path,
        name: attachmentName(path),
        size: 0,
        mediaType: "",
        state: "ready",
        reference: null,
        error: null,
      });
    }
    return added.length === 0 ? current : [...current, ...added];
  });
};

export const removeStartupAttachment = (id: string): void => {
  setStartupAttachments((current) => current.filter((item) => item.id !== id));
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

/** 侧栏与标题栏共用 RingingV2 的持久化重命名命令。 */
export async function renameSession(seed: string, title: string): Promise<void> {
  const next = title.trim();
  if (!next) return;
  renameLocalSession(seed, next);
  try {
    await transport.command({ type: "session.rename", title: next }, sessionTarget(seed));
    await pollSessions();
  } catch (error) {
    toast(STR.renameSessionFailed + "：" + (error instanceof Error ? error.message : String(error)), "err");
  }
}

/** 侧栏目录投影:后端标题优先,后端缺标题时叠本地覆盖;顺带清理陈旧覆盖条目。 */
function applySessionList(list: SidebarSession[]): void {
  const { merged, staleSeeds } = overlayLocalTitles(list, localTitles());
  setSessionCatalog(merged);
  for (const seed of staleSeeds) setLocalTitleOf(seed, "");
  observeSessionStatuses(merged);
}

/* ── 会话状态点(前端启发式 v1,用户口径 2026-11-11)──────────────────────────
 * 后端 session.list 只给运行词表(not_running/idle/running/waiting_user/cancelling),
 * "本轮怎么结束的"(绿/红/灰)不在其中——绿红灰需要 TurnView.outcome,权威来源是
 * bootstrap 快照。裁决:
 *  · 蓝/等待/取消中 = list 的 status 直读(daemon 权威,SSE 断流不影响:
 *    断流时 daemon 仍在跑 → 依旧蓝,天然不会"误认为结束");
 *  · 本次壳生命周期里**目击到** running系→idle 迁移的会话,补一发一次性
 *    bootstrap 探针读末回合 outcome → 绿(完成)/红(error/超限终态)/灰(cancel);
 *    探针失败或无终态 → 保持无点。宁可缺点,不可猜错点。
 *  · 冷启动/从未工作过的会话:prevStatus 未建立 → 无点;新回合开始(running 再现)
 *    → 旧终态立即作废。状态全部驻内存,不落盘——这正是"重置为无点"的语义。 */
export type SessionDotKind = "working" | "waiting" | "cancelling" | "done" | "failed" | "cancelled";
const DOT_LIVE: Record<string, SessionDotKind> = { running: "working", waiting_user: "waiting", cancelling: "cancelling" };
const dotTerminals = new Map<string, SessionDotKind>();
const dotPrevStatus = new Map<string, SessionRunStatus>();
const dotProbing = new Set<string>();
const [dotVersion, bumpDotVersion] = createSignal(0, { equals: false });

function dotFromOutcome(outcome: TurnOutcome | null | undefined): SessionDotKind | null {
  if (outcome == null) return null;
  if (outcome.kind === "finished") return outcome.data.error != null ? "failed" : "done";
  return "cancelled";
}

function observeSessionStatuses(entries: SidebarSession[]): void {
  let changed = false;
  for (const entry of entries) {
    const prev = dotPrevStatus.get(entry.session_id);
    const st = entry.status;
    if (st == null) continue; // 无状态字段的历史条目不参与判定,也不污染 prev 基线。
    dotPrevStatus.set(entry.session_id, st);
    if (DOT_LIVE[st] != null) {
      // 新一轮开始了:上一轮的终态点作废(工作中不显示历史颜色)。
      if (dotTerminals.delete(entry.session_id)) changed = true;
      continue;
    }
    const wasLive = prev != null && DOT_LIVE[prev] != null;
    if (wasLive && !dotTerminals.has(entry.session_id) && !dotProbing.has(entry.session_id)) {
      dotProbing.add(entry.session_id);
      void transport.sessionBootstrap(entry.session_id).then((boot) => {
        const turns = boot.state.turns;
        const kind = dotFromOutcome(turns.length > 0 ? turns[turns.length - 1]?.outcome : null);
        if (kind != null) {
          dotTerminals.set(entry.session_id, kind);
          bumpDotVersion((v) => v + 1);
        }
      }).catch(() => { /* 探针失败=不知道=不画点 */ }).finally(() => { dotProbing.delete(entry.session_id); });
    }
  }
  if (changed) bumpDotVersion((v) => v + 1);
}

/** 行渲染入口:活状态优先直读 list;终态点仅来自本次目击的权威 outcome。 */
export function sessionDot(id: string, status: SessionRunStatus | null | undefined): SessionDotKind | null {
  dotVersion();
  return (status != null ? DOT_LIVE[status] : null) ?? dotTerminals.get(id) ?? null;
}
/** 焦点令牌:切标签/新建时 +1,Composer 响应后聚焦。 */
const [focusToken, setFocusToken] = createSignal(0);
/**
 * 最近一次请求激活的标签 id,`null` = 回到启动页。
 *
 * 必须同步写入而不是读 `activeId()`:`withViewTransition` 的 View Transition 回调
 * 是**异步**的(排到下一帧),`setActiveId` 要到那时才生效;而排队中的 activation
 * 在微任务里就跑,读 `activeId()` 会拿到旧值,把「刚点开的标签」误判成「被后来的
 * 点击取代」而整段 return —— 结果标签高亮但 store 从不 activate(不 attach、不订阅)。
 */
let activationTargetId: string | null = null;
let lastActivatedSeed: string | null = null;
let recentBackgroundSeeds: string[] = [];

function retainRecentBackground(seed: string, preserveSeed: string | null = null): void {
  recentBackgroundSeeds = [seed, ...recentBackgroundSeeds.filter((item) => item !== seed)].slice(0, 2);
  for (const tab of tabs()) {
    if (tab.seed !== seed && tab.seed !== preserveSeed && !recentBackgroundSeeds.includes(tab.seed) && tab.seed !== lastActivatedSeed) tab.store.evictView();
  }
}

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
  startupPreflight,
  startupAttachments,
};
export const setBootError = (value: string | null): void => {
  setBootErrorSignal(value);
};
export const activeTab = (): Tab | null => tabs().find((tab) => tab.id === activeId()) ?? null;
export const draftOf = (seed: string): string => drafts[seed] ?? "";
export const setDraftOf = (seed: string, value: string): void => {
  setDrafts((draft) => { draft[seed] = value; });
  // 持久化走尾沿节流(见 DRAFT_PERSIST_DELAY_MS 注释):每键只做 O(1) 的 Map 记账。
  draftPersistLatest.set(seed, value);
  if (!draftPersistTimers.has(seed)) {
    const timer = setTimeout(() => {
      draftPersistTimers.delete(seed);
      persistDraftNow(seed);
    }, DRAFT_PERSIST_DELAY_MS);
    draftPersistTimers.set(seed, timer);
  }
};

export function openStartup(): void {
  if (lastActivatedSeed) retainRecentBackground(lastActivatedSeed);
  lastActivatedSeed = null;
  // 回到启动页 = 取消在飞的激活:让排队中的 activation 不再 proceed。
  activationTargetId = null;
  // VT 回调只做视觉信号写入;store 退订(deactivate)留在外头同步做 —— 回调会被
  // 排到下一帧,迟到时若还带着退订循环,会把「刚激活的当前 store」的订阅拆掉
  // (headless/节流下实测发生过,timeline 全空)。旧快照在 startViewTransition 调用
  // 的当下已同步捕获,随后的退订不会进画面。
  withViewTransition(() => {
    // 迟到的旧回调:激活目标已被后来者取代,不得再写入任何视觉信号。
    if (activationTargetId !== null) return;
    setIsStartup(true);
    setActiveId(null);
  });
  for (const other of tabs()) {
    other.store.deactivate();
  }
  setFocusToken(focusToken() + 1);
}

function addTab(seed: string): Tab {
  const existing = tabs().find((tab) => tab.seed === seed);
  if (existing != null) return existing;
  const tab: Tab = { id: `tab-${seed}`, seed, store: new SessionStore(seed) };
  // 会话元数据变更接给标签层:store 只有已 attach 的那条流,所以这里只管活动
  // 会话的即时刷新,后台会话仍靠 pollSessions 的列表重拉兜底。
  tab.store.onSessionsChanged = () => { void pollSessions(); };
  tab.store.onConnectionRestored = () => {
    void refreshWorkspaces();
    notifyConfigChanged();
  };
  tab.store.onSessionTitleChanged = (title) => {
    // 后端标题已生成(title_changed):本地覆盖退场(后端优先语义)。
    if (title.trim()) setLocalTitleOf(seed, "");
    setSessionCatalog((list) => list.map((item) =>
      String(item.session_id) === seed ? { ...item, title } : item,
    ));
  };
  tab.store.onSessionDeleted = () => { void dropSession(seed); };
  // 封箱成功 = 立刻 fork(实时封箱与断线窗口结算都走这条回调,见 session/store
  // 的 settleHandoffFacts)。判据是 `handed_off:true` 那份工具结果(不是 turn 终态、
  // 不是阈值),只有**当前活动**的 store 会收到事件流。已建且已投的交接不再自动把
  // 用户拽到 B(重开卡死的旧回合时,重复激活会反复触发结算,此时安静留在卡片上,
  // 「打开交接会话」仍是入口);未投递的照常走 fork(它会补投)。去重与血缘都在
  // 交接账本里。
  tab.store.onHandoffDetected = (fact) => {
    if (forkRecordOfFact(fact)?.delivered) return;
    void forkHandoffSession(seed, fact);
  };
  setTabs((list) => [...list, tab]);
  return tab;
}

/** 激活标签:宿主 attach 切 active seed + 重建流 → 该 store 订阅,其余退订。 */
export async function activateTab(tab: Tab): Promise<void> {
  // 先同步记下「要激活谁」——见 activationTargetId 的说明,不能读被 VT 推迟的 activeId。
  activationTargetId = tab.id;
  if (lastActivatedSeed && lastActivatedSeed !== tab.seed) retainRecentBackground(lastActivatedSeed, tab.seed);
  recentBackgroundSeeds = recentBackgroundSeeds.filter((seed) => seed !== tab.seed);
  lastActivatedSeed = tab.seed;
  // 只包同步的「内容换血」视觉信号写入;attach/RPC 留在外面,别把旧快照冻屏。
  // 其余 store 的退订同样留在外面:VT 回调排到下一帧,节流下旧回调可能迟到,
  // 在回调里 deactivate 会拆掉刚激活 store 的订阅(见 openStartup 内注释)。
  withViewTransition(() => {
    // 迟到的旧回调:激活目标已被后来者取代,不得回写旧 activeId。
    if (activationTargetId !== tab.id) return;
    setIsStartup(false);
    setActiveId(tab.id);
  });
  for (const other of tabs()) {
    if (other.id !== tab.id) other.store.deactivate();
  }
  setFocusToken(focusToken() + 1);
  const activation = (async () => {
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
  })();
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
  recentBackgroundSeeds = recentBackgroundSeeds.filter((seed) => seed !== tab.seed);
  if (lastActivatedSeed === tab.seed) lastActivatedSeed = null;
  setTabs(list.filter((item) => item.id !== tabId));
  setDrafts((draft) => { delete draft[tab.seed]; });
  dropDraftPersistence(tab.seed);
  tab.store.dispose();
  if (wasActive) {
    const next = list[index - 1] ?? list[index + 1] ?? null;
    if (next != null) await activateTab(next);
    else openStartup();
  }
}

export interface CreateSessionOptions {
  cwd?: string | null;
  modelSelection?: ModelSelection | null;
  title?: string | null;
  /** 会话工具模式;null/空 = 不写列(后端默认 standard,零迁移语义)。 */
  toolMode?: string | null;
  /** 仅 toolMode === "custom" 时随之发送;其余档位后端不收白名单。 */
  customTools?: string[] | null;
}

/** 依据指定选项原子创建新会话并返回新分配的 session_id。 */
export async function createSessionWithCwd(
  cwdOrOptions?: string | null | CreateSessionOptions,
): Promise<string> {
  const options: CreateSessionOptions =
    typeof cwdOrOptions === "string" || cwdOrOptions === null || cwdOrOptions === undefined
      ? { cwd: cwdOrOptions ?? null }
      : cwdOrOptions;

  const ack = await transport.command({
    type: "session.create",
    cwd: options.cwd ?? null,
    model_selection: options.modelSelection ?? null,
    title: options.title ?? null,
    tool_mode: options.toolMode ?? null,
    custom_tools: options.customTools ?? null,
  });
  const result = ack.result;
  const sessionId = result != null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>).session_id
    : undefined;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("session.create 未返回 session_id");
  }
  invalidateWorkspaceRefresh();
  void refreshWorkspaces();
  // 会话已经建出来了：侧栏刷新失败不能再走一次创建，否则会多出一个会话。
  try {
    const list = await transport.sessions();
    applySessionList(list as SidebarSession[]);
  } catch (err) {
    console.warn("session.create 已成功，但会话列表刷新失败：", err);
  }
  return sessionId;
}

/**
 * 新建会话：可选地换目标工作区，然后回启动页。真正的 `session.create` 在首条
 * 消息发出时才发生（`submitStartupSession`）。
 *
 * 两条纪律都写在这里，别再分头实现：
 * 1. **不在这里建会话**。后端 `session.create` 末尾无条件 `registry.spawn_new`
 *    （`service/handlers/session.rs:205-209`），先建后不说话的会话等于白拉一个
 *    agent worker，还会以零轮次会话漏进 `sessions()` 列表。
 * 2. **必须走 `openStartup()`**。它负责取消在飞激活、退订其余 store、bump 焦点
 *    令牌；只写 `setIsStartup(true)` 会留下一批已 attach 却无人退订的会话——
 *    此前 Ctrl+N 与侧栏「+」行为不一致正是这个原因。
 *
 * 不传 `cwd` = 保持当前粘性目标（「换个地方接着写」），传了就改目标；两者都
 * 落 localStorage，连开几个会话时不必反复选目录。
 */
export function createSession(cwd?: string | null): void {
  if (cwd != null) setNewSessionCwd(cwd);
  openStartup();
}

export interface StartupSubmitOptions {
  cwd: string | null;
  /** null = 跟随存档默认(省略 model_selection,后端回落 default_model_selection)。 */
  modelSelection?: ModelSelection | null;
  toolMode?: string | null;
  customTools?: string[] | null;
  text: string;
  attachments?: PendingAttachment[];
}

/**
 * Startup 首页原子创建会话与首包发送事务:
 * 1. 按预检态创建会话(cwd / model_selection / tool_mode / custom_tools)
 * 2. 上传本地暂存的附件 (若有;只有 ready 态参与——这里 ready = 已暂存待传,
 *    与会话页"已上传"的 ready 不是一个阶段,见 `stageStartupAttachments`)
 * 3. 打开会话并发送第一条用户消息
 */
/** 返回是否成功提交;false = 创建/发送失败(调用方据此保留草稿)。 */
export async function submitStartupSession(options: StartupSubmitOptions): Promise<boolean> {
  if (creating()) return false;
  setCreating(true);
  try {
    const fresh = await createSessionWithCwd({
      cwd: options.cwd,
      modelSelection: options.modelSelection ?? null,
      toolMode: options.toolMode ?? null,
      customTools: options.customTools ?? null,
    });
      const uploadedRefs: SessionContentRef[] = [];
    const staged = (options.attachments ?? []).filter((item) => item.state === "ready");
    if (staged.length > 0) {
      for (const item of staged) {
        try {
          const uploaded = await transport.uploadAttachment(fresh, item.id);
          uploadedRefs.push(uploaded.content_ref);
        } catch (err) {
          toast(`附件上传失败: ${item.id}`, "err");
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
 * 交接 fork —— 三条现成命令,零新 API(施工单 §一·2)。
 *
 * 1. `session.create { cwd, model_selection, tool_mode, custom_tools, title }`
 *    四项全部抄 A 的 `session.meta`(都是导出字段);`title` 直接用 `work_summary`,
 *    新 tab 一出生就可读——自动标题是死代码,不等后端。
 * 2. `conversation.send_message { text = handoff_doc, input_purpose = "trigger_turn" }`
 *    交接文档就是 B 的第一条 user 角色消息;后端不拼位置,位置由这条输入天然决定
 *    (落在 `[Project instructions](AGENTS.md)` 之下)。
 * 3. 会话接管:走本仓现有流程——`openSession` → `SessionStore.activate()` →
 *    宿主 `attach`(`session.resume`)。daemon 的会话面命令鉴权看的是 **lease 归属**
 *    (`commands.rs` 的 `owns_session`),attach 已经把归属建立了;`driver.claim`
 *    的 payload 里 `client_session_id` 由 daemon 从信封取(`DriverClaim { client_session_id: _, ... }`
 *    显式忽略),renderer 也拿不到租约 id(它在主进程),所以这里不另发一条只会
 *    被忽略的 claim。接管语义与"用户点开一个既有会话"完全一致。
 *
 * **只在封箱结果到达后 fork**:`tool_declared{tool_name:"handoff"}` 用来识别与展示
 * (标签/图标),但 `handoff_invalid_args` / `handoff_write_failed` 之后模型可以改参数
 * 重试——按 declare 就 fork 会把一份没写成的文档投进 B。判据因此是 `handed_off:true`
 * 那份 `tool_finished.output`;同回合重复调用后端只回一句人话、不再给 `handed_off`,
 * 天然不会二次 fork。
 */

/** 在飞的 fork(fact.key):并发触发(事件重放/双击)只跑一次。 */
const handoffForkFlights = new Set<string>();

/** 新会话标题:后端按此持久化;过长截断,可读性优先于行宽。 */
export function handoffTitle(fact: { workSummary: string; handoffDoc: string }): string {
  const summary = fact.workSummary.replace(/\s+/g, " ").trim();
  if (summary !== "") return summary.length > 72 ? `${summary.slice(0, 71)}…` : summary;
  const firstLine = fact.handoffDoc.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
}

/** 把交接文档投成 B 的第一条输入(`input_purpose = "trigger_turn"`)。 */
async function deliverHandoffDoc(childSeed: string, fact: HandoffFact): Promise<boolean> {
  try {
    const tab = await openSession(childSeed);
    if (tab != null) await tab.store.sendMessageWithAttachments(fact.handoffDoc, []);
    else {
      // 激活被更晚的点击取代:命令照发,别让 B 停成零轮次会话。
      await transport.command(
        { type: "conversation.send_message", text: fact.handoffDoc, attachments: [], input_purpose: "trigger_turn" },
        sessionTarget(childSeed),
      );
    }
    markHandoffDelivered(fact.key);
    void pollSessions();
    return true;
  } catch (error) {
    toast(STR.handoffForkFailed(error instanceof Error ? error.message : String(error)), "err");
    return false;
  }
}

/**
 * fork 一条交接。返回 B 的 session_id(null = 失败,状态都留在 toast 与账本里)。
 *
 * 幂等性:同一 `from_session_id + turn_id` 只会有一条会话被开出来。已经 fork 过
 * 就直接打开那条;若「会话已建、文档没投出去」,只补投递,绝不再开第二条。
 */
export async function forkHandoffSession(sourceSeed: string, fact: HandoffFact): Promise<string | null> {
  const recorded = forkRecordOfFact(fact);
  if (recorded != null) {
    if (recorded.delivered) {
      await openSession(recorded.childSessionId);
      return recorded.childSessionId;
    }
    const retried = await deliverHandoffDoc(recorded.childSessionId, fact);
    return retried ? recorded.childSessionId : null;
  }
  if (handoffForkFlights.has(fact.key)) return null;
  handoffForkFlights.add(fact.key);
  try {
    const meta = await transport.query("session.meta", { session_id: sourceSeed || fact.fromSessionId }).catch(() => null);
    const toolMode = typeof meta?.tool_mode === "string" && meta.tool_mode !== "" ? meta.tool_mode : null;
    const child = await createSessionWithCwd({
      cwd: meta?.cwd ?? null,
      modelSelection: meta?.model_selection ?? null,
      toolMode,
      customTools: toolMode === "custom" && Array.isArray(meta?.custom_tools) ? meta.custom_tools : null,
      title: handoffTitle(fact),
    });
    // 先记账再投递:投递失败也不能让下一次点击变成"第二条会话"。
    recordHandoffFork(fact, child, false);
    const delivered = await deliverHandoffDoc(child, fact);
    if (delivered) toast(STR.handoffForked(handoffTitle(fact)), "ok");
    else toast(STR.handoffDeliveredPartial, "err");
    return child;
  } catch (error) {
    toast(STR.handoffForkFailed(error instanceof Error ? error.message : String(error)), "err");
    return null;
  } finally {
    handoffForkFlights.delete(fact.key);
  }
}

/**
 * 注册目录为工作区(`workspace.create`)。后端按 canonical 路径查重,重复注册
 * 返回既有条目,所以「再选一次同一个文件夹」是幂等的。
 */
export async function registerWorkspace(path: string): Promise<SidebarWorkspace | null> {
  try {
    const ack = await transport.command({ type: "workspace.create", path });
    const value = ack.result;
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("workspace.create 未返回工作区信息");
    }
    const entry = value as unknown as WorkspaceEntry;
    if (typeof entry.id !== "string" || typeof entry.path !== "string" || typeof entry.title !== "string") {
      throw new Error("workspace.create 返回了无效工作区信息");
    }
    const created: SidebarWorkspace = { id: entry.id, path: entry.path, title: entry.title, order: entry.order, missing_dir: false };
    invalidateWorkspaceRefresh();
    await refreshWorkspaces();
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
    await transport.command({ type: "workspace.move_session", workspace_id: workspaceId }, sessionTarget(seed));
    await pollSessions();
  } catch (error) {
    toast(`${STR.moveSessionFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
  }
}

/** 把会话移出工作区 → 未分组(`workspace.detach`)。 */
export async function detachSessionFromWorkspace(seed: string): Promise<void> {
  try {
    await transport.command({ type: "workspace.detach" }, sessionTarget(seed));
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
    const list = await transport.sessions() as SidebarSession[];
    applySessionList(list);
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

let workspaceFlight: Promise<void> | null = null;
let workspaceGeneration = 0;
function invalidateWorkspaceRefresh(): void {
  workspaceGeneration += 1;
  workspaceFlight = null;
}

/** Workspaces change independently of the periodically refreshed session list. */
export function refreshWorkspaces(): Promise<void> {
  if (workspaceFlight != null) return workspaceFlight;
  const generation = workspaceGeneration;
  const request = transport.query("workspace.list", {}).then((entries) => {
    if (generation === workspaceGeneration) setWorkspaceCatalog(entries.map(workspaceEntryToSidebar));
  }).catch(() => { /* Keep the last known catalog until the next refresh. */ });
  workspaceFlight = request;
  void request.finally(() => { if (workspaceFlight === request) workspaceFlight = null; });
  return request;
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

/** 删除会话并同步关闭本地标签；daemon 同时会广播终态删除事件。 */
export async function deleteSession(seed: string): Promise<void> {
  try {
    await transport.command({ type: "session.delete" }, sessionTarget(seed));
    await dropSession(seed);
    await pollSessions();
  } catch (error) {
    toast(STR.deleteSessionFailed + "：" + (error instanceof Error ? error.message : String(error)), "err");
  }
}

/** 启动:选一个非归档会话(优先运行中)作为第一个标签。 */
export async function boot(): Promise<void> {
  const [list] = await Promise.all([
    transport.sessions() as Promise<SidebarSession[]>,
    refreshWorkspaces(),
  ]);
  applySessionList(list);
  const live = list.find((item) => !item.archived && item.busy) ?? list.find((item) => !item.archived) ?? list[0];
  if (live?.session_id == null) {
    setBootError(null);
    openStartup();
    return;
  }
  await openSession(String(live.session_id));
}

