/**
 * 合成压力夹具(只给 dev 用:`pnpm exec vite` 起服务后打开 /stress.html)。
 *
 * 目的:在没有 daemon、没有 TUI 的情况下验证分页与窗口淘汰 churn,以及大文本 +
 * 重 Markdown 下的 DOM 规模。走真组件与真 store；事件帧交给 v3 reducer,只有
 * `transport.timelinePage` 使用内存假页,不写后端、不发命令。
 */
import { render } from "@solidjs/web";
import { markPlatform } from "./lib/platform";
import { invoke } from "./lib/host";
import { createSignal, Show, untrack } from "solid-js";
import { SessionStore } from "./session/store";
import type { SessionRunStatus } from "./api/qaqh/SessionRunStatus";
import { SessionView } from "./session/SessionView";
import { WorkspacePanel } from "./workspace/WorkspacePanel";
import { Composer } from "./composer/Composer";
import { ApprovalStack } from "./approval/ApprovalCards";
import { DiffReviewDrawer } from "./diff/DiffReviewDrawer";
import { Sidebar } from "./app/Sidebar";
import { observeShellCols } from "./lib/shell-cols";
import { buildContextMenu, ContextMenuHost, openContextMenu } from "./ui/contextMenu";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconMenu from "~icons/lucide/menu";
import IconMoreHorizontal from "~icons/lucide/more-horizontal";
import { ToolsPage } from "./app/ToolsPage";
import { TeamPage } from "./app/TeamPage";
import { OAuthPage } from "./oauth/OAuthPage";
import { SettingsView } from "./settings/SettingsView";
import { simMemorySnapshot } from "./lib/memwatch-sim";
import { shouldCollapseSidebar } from "./lib/sidebar-resize";
import { openDevConsole } from "./lib/devmode";
import { reload as reloadSettings } from "./settings/store";
// Session capsule is reserved for Goal, matching the production shell.
import { setSessionMaterial, type SessionMaterial } from "./lib/visual";
import { applyTheme, type ResolvedTheme } from "./lib/theme";
import { transport, type Ack, type ServiceMethod, type ServiceParams, type ServiceResult } from "./lib/transport";
import type { SessionBootstrap } from "./api/qaqh/SessionBootstrap";
import type { SessionEventFrame } from "./api/qaqh/SessionEventFrame";
import { applySessionEvent, recomputeDerived } from "./session/reducer";
import type { ToolStep } from "./session/types";
import { pollSessions, refreshWorkspaces, setNewSessionCwd, stageStartupAttachments } from "./tabs/store";
import { StartupView } from "./session/StartupView";
import type { ConfigDto } from "./api/qaqh/ConfigDto";
import type { ApprovalView } from "./lib/transport";
import type { Tab } from "./tabs/store";
import type { SidebarSession, SidebarWorkspace } from "./tabs/store";
import "./styles/app.css";

markPlatform();

/** 会话总回合数(权威 total_turns)。 */
const previewParams = new URLSearchParams(window.location.search);
const previewView = previewParams.get("view");
const isVisualPreview = previewView === "messages" || previewView === "settings" || previewView === "approval" || previewView === "tools" || previewView === "oauth" || previewView === "startup";
/** 侧栏待响应卡的预览开关(§6.2):见 `previewSessions` 的注释。 */
const pendingPreview = previewParams.get("pending") === "1";
const [currentView, setCurrentView] = createSignal<"messages" | "tools" | "team" | "oauth" | "settings">(
  previewView === "settings" || previewView === "tools" || previewView === "team" || previewView === "oauth" ? previewView : "messages",
);
/**
 * 阶段B 视觉评审:`view=startup` 把主区换成**真·启动页**(StartupView 渲染共用
 * Composer)。Sidebar 的 section 仍是 messages——生产中启动页就是消息栏的子态,
 * 这里复刻同一句话。`currentView` 的联合类型刻意不动:切去设置页的行为与它一致。
 */
const [startupMode] = createSignal(previewView === "startup");
/** 与 App 同位:汉堡收展侧栏(48px 图标栏),夹具不做 localStorage 记忆。 */
const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
/* 拖拽调宽(与 App 同位,无记忆):松手提交,< 阈值等效汉堡收回。 */
const [fixtureSidebarWidth, setFixtureSidebarWidth] = createSignal<number | null>(null);
const commitFixtureSidebarWidth = (width: number | null): void => {
  setFixtureSidebarWidth(width);
  if (width == null) setSidebarCollapsed(false);
  else if (shouldCollapseSidebar(width)) setSidebarCollapsed(true);
};
/** 阶段5:列态由 #app 实宽 ResizeObserver 驱动;抽屉可由 URL 参数预设(截图场景用)。 */
const [fixtureCols, setFixtureCols] = createSignal<1 | 2 | 3>(3);
const [previewSettingsSection, setPreviewSettingsSection] = createSignal<string | undefined>(undefined);
const [previewSettingsNonce, setPreviewSettingsNonce] = createSignal(0);
const sidebarDrawerPreview = previewParams.get("sidebarDrawer") === "1";
const railDrawerPreview = previewParams.get("railDrawer") === "1";
const TOTAL = isVisualPreview ? 4 : 200;
let fixtureIdSeq = 2001;
let wireSeq = 0;
type SessionEventPayload = SessionEventFrame extends infer Frame
  ? Frame extends { seq: number } ? Omit<Frame, "seq"> : never
  : never;
/** 翻页请求记录(测分页是否真在跑)。 */
let pageRequests: Array<{ limit: number; beforeIndex: number | null }> = [];

/** 确定性伪随机:同一 index 每次生成同样的内容,重对齐才比得出 churn。 */
function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SENTENCES = [
  "系统把这条时间线按 seq 单调追加，前端只做归约不做推断。",
  "水位一旦缺口就整表校正一次，校正按两秒防抖，不连环拉。",
  "折叠容器收起后要卸载子树，常驻内存才不会只增不减。",
  "列表按稳定 key 挂载，权威重对齐才不会把整屏连滚动位置一起丢掉。",
  "回合的耗时是前端时钟采样的，后端条目不带 epoch-ms。",
];

function prose(rand: () => number, chars: number): string {
  const lines: string[] = [];
  let size = 0;
  while (size < chars) {
    const line = SENTENCES[Math.floor(rand() * SENTENCES.length)]!;
    lines.push(line);
    size += line.length;
  }
  return lines.join("\n");
}

/** 重 Markdown:标题/段落/有序无序列表/表格/引用/两种语言围栏/行内混排。 */
function markdownOf(rand: () => number, index: number, chars: number): string {
  const parts: string[] = [
    `## 第 ${index} 答：结论与依据`,
    "",
    prose(rand, Math.floor(chars * 0.3)),
    "",
    "- 要点一：窗口淘汰只换占位不删数据的话，翻页越深攒下的全量文本越多",
    "- 要点二：`Object.values(turns)` 挂在 UI 热路径上会让整条链每帧重算",
    "  - 子项：派生答案要倒排成按 id 取键的单值",
    "",
    "1. 先测再改",
    "2. 再测一次对账",
    "3. 把结论钉成回归门",
    "",
    "| 指标 | 修复前 | 修复后 | 口径 |",
    "| --- | ---: | ---: | --- |",
    "| DOM 节点 | 17213 | 1263 | DEV |",
    "| 挂载字符 | 804220 | 118080 | DEV |",
    "| 每帧工作量 | 24ms | 0.2ms | 长任务 0 |",
    "| JS 堆 | 223MB | 27MB | usedJSHeap |",
    "",
    "> 注意：`.turn` 带 `content-visibility: auto`，离屏回合按估算高计入滚动范围，",
    "> 一次 `scrollTop = scrollHeight` 会被夹住，贴底要按帧推进。",
    "",
    "```ts",
    "const keyed = (slot: Slot): string => slot.key;",
    "for (const raw of page.snapshot?.turns ?? []) {",
    "  const turn = buildTurn(raw, ts); // 结构与顺序事实只来自后端",
    "  installTurns(draft, [turn]);",
    "}",
    "```",
    "",
    "```rust",
    "pub fn page_plan(before_index: Option<u64>, limit: usize, total: usize, window_base: usize) -> PagePlan {",
    "    let end = before_index.unwrap_or(total).min(total);",
    "    PagePlan { start: end.saturating_sub(limit), end, from_archive: end < window_base + limit }",
    "}",
    "```",
    "",
    "内联代码 `draft.turns = {}` 与链接 [reducer](https://example.com/session/reducer.ts) 混排，",
    "粗体 **保住原对象**、斜体 *内容变了才换*、删除线 ~~整表重建~~ 都要走到。",
    "",
    "---",
    "",
    prose(rand, Math.floor(chars * 0.4)),
    "",
  ];
  return parts.join("\n");
}

function ansiLog(rand: () => number, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const color = rand() < 0.25 ? "\u001b[32m" : rand() < 0.4 ? "\u001b[31m" : "\u001b[0m";
    out.push(`${color}   ${String(i).padStart(4, "0")} | running test ${i} … ${rand() < 0.5 ? "ok" : "FAILED"}`);
  }
  return out.join("\n");
}

// 假挂载点:store 只通过 transport.sessionBootstrap 取权威快照
(transport as any).sessionBootstrap = async (_seed: string): Promise<SessionBootstrap> => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  const turns = Array.from({ length: TOTAL }, (_, i) => ({
    turn_id: `t${i + 1}`,
    input_id: `in${i + 1}`,
    mode: "normal" as const,
    outcome: { kind: "finished" as const, data: { terminal: "completed" as const, usage: null, error: null } },
  }));
  const timeline = Array.from({ length: TOTAL }, (_, i) => {
    const turnId = `t${i + 1}`;
    return [
      {
        kind: "input" as const,
        data: {
          block_id: `input-${i + 1}`,
          turn_id: turnId,
          purpose: "trigger_turn" as const,
          content: { kind: "inline" as const, data: { text: `Question ${i + 1}` } },
          attachments: [],
          actor: { kind: "user" as const, id: "visual-fixture" },
        },
      },
      {
        kind: "assistant_block" as const,
        data: {
          block_id: `answer-${i + 1}`,
          turn_id: turnId,
          ord: i * 2 + 2,
          block_kind: "answer" as const,
          content: { kind: "inline" as const, data: { text: `Turn ${i + 1} answer` } },
          model: "claude",
          usage: null,
        },
      },
    ];
  }).flat();
  return {
    schema: "qaqh.Ringing",
    version: 2,
    session_contract_revision: "ringing-session-2",
    server_epoch: "visual-fixture",
    session_id: "stress",
    state: {
      session_id: "stress",
      seq: TOTAL * 2,
      activity: "idle",
      current_turn_id: null,
      title: "Visual fixture",
      turns,
      timeline,
      tools: [],
      interactions: [],
      subagents: [],
      driver: null,
      exec_sessions: [],
    },
  };
};

const store = new SessionStore("stress");
const tab: Tab = { id: "tab-stress", seed: "stress", store };
const fixtureTabs: Tab[] = [tab];
for (let index = 2; index <= 20; index += 1) {
  const extraStore = new SessionStore(`stress-${index}`);
  extraStore.title[1](`会话 ${index}`);
  if (index % 6 === 0) extraStore.hasNewReply[1](true);
  if (index % 7 === 0) extraStore.activity[1]("working");
  fixtureTabs.push({ id: `tab-stress-${index}`, seed: `stress-${index}`, store: extraStore });
}
const previewWorkspaces: SidebarWorkspace[] = [
  { id: "ws-web", title: "qaqh-desktop-app", path: "E:/qaqh-desktop-app", order: 0 },
  { id: "ws-backend", title: "qaqh-backend", path: "E:/qaqh-backend", order: 1 },
  // 零会话的工作区:侧栏必须列出并给出「+」——「给这个工作区起第一条对话」的入口。
  { id: "ws-fresh", title: "qaqh-telegram", path: "E:/qaqh-telegram", order: 2, missing_dir: false },
  // 目录已不存在且一条会话都没有:不该占一行(有历史的死目录仍会列出,见单测)。
  { id: "ws-gone", title: "gone-and-empty", path: "E:/gone-and-empty", order: 3, missing_dir: true },
];
const previewSessions: SidebarSession[] = fixtureTabs.map((item, index) => {
  const working = item.store.activity[0]() === "working";
  // 等待态只在 `?pending=1` 时铺,保留默认视觉基线。
  const status: SessionRunStatus | undefined = pendingPreview
    ? index >= 1 && index <= 3 ? "waiting_user" : working ? "running" : "idle"
    : working ? "running" : "idle";
  return {
    session_id: item.seed,
    title: item.store.title[0]() ?? `会话 ${index + 1}`,
    cwd: index < 8 ? "E:/qaqh-desktop-app" : index < 14 ? "E:/qaqh-backend" : null,
    workspace_id: index < 8 ? "ws-web" : index < 14 ? "ws-backend" : null,
    status,
    busy: status === "running" || status === "waiting_user",
    updated_at: 100 - index,
  };
});
const [previewActiveSeed, setPreviewActiveSeed] = createSignal(tab.seed);
const previewActiveTab = (): Tab => fixtureTabs.find((item) => item.seed === previewActiveSeed()) ?? tab;
const [draft, setDraft] = createSignal("");
/* 输入区那颗「新建会话的工作区」chip 在产线是恒传的(App 一直给 workspaces/
   onWorkspace),夹具此前完全没传——于是这张菜单从来没被视觉评审覆盖过。
   这里补上,并把「+」的落点做成「改目标目录」这种可观察的最小语义。 */
const [fixtureWorkspacePath, setFixtureWorkspacePath] = createSignal<string | null>("E:/qaqh-backend");

if (isVisualPreview) {
  const previewConfig: ConfigDto = {
    autoCompactThreshold: 0.82,
    permissionLevel: 2,
    lang: "zh-CN",
    fontFamily: "",
    theme: previewParams.get("theme") === "dark" ? "dark" : "light",
    notificationsEnabled: true,
    exec: { defaultShell: "pwsh" },
    sessionIdleUnloadSecs: 1800,
    sandbox: { enabled: true },
    toolAllowlistEnabled: false,
    toolAllowlist: [],
    goals: { enabled: true, maxTokenBudget: null },
    subagent: {
      timeoutSecs: 120,
      defaultTools: ["read", "write"],
      maxDepth: 3,
      messageInFlightPerPair: 0,
      messageOutboundPerSender: 0,
    },
    mcp: {
      enabled: true,
      idleShutdownSecs: 300,
      servers: [
        {
          name: "context7",
          transport: "stdio",
          command: "npx",
          args: ["-y", "ctx7"],
          env: { KEY: "${secret:ctx7}" },
          url: "",
          headers: {},
          tools: null,
          resourcesEnabled: false,
          defaultTimeoutSecs: 30,
          maxConcurrentCalls: 8,
          cwd: "",
        },
      ],
    },
    lsp: { enabled: false, idleShutdownSecs: 300, servers: [] },
    tokenizerPath: null,
  };
  // skills 视觉夹具直接复用 daemon `skills.catalog` 的输出形状；发现、解析和遮蔽
  // 由 catalog 负责，浏览器夹具只提供可展示的条目元数据。
  const previewWorkspaceRoot = "E:/fixtures/demo-repo";
  const previewSkillsCatalog = {
    skills: [
      {
        name: "skill-creator",
        description: "Create or update a skill with appropriately scoped instructions. (visual fixture)",
        scope: "project",
        origin: "project",
        path: `${previewWorkspaceRoot}/skills/skill-creator/SKILL.md`,
      },
      {
        name: "mc-bug-audit",
        description: "独立审计：从源码边界出发复现问题。(visual fixture)",
        scope: "user",
        origin: "user",
        path: "C:/Users/fixture/.agents/skills/mc-bug-audit/SKILL.md",
      },
    ],
    diagnostics: [
      {
        severity: "warning",
        path: `${previewWorkspaceRoot}/skills/broken-skill/SKILL.md`,
        message: "技能目录中的 SKILL.md 缺少有效 frontmatter。",
      },
    ],
  };
  const previewProviderCatalog = {
    revision: 1,
    default_model_selection: {
      provider_id: "visual-provider",
      model_id: "qaqh-visual-preview",
      options: { max_output_tokens: 8192, reasoning_effort: "medium" },
    },
    providers: {
      "visual-provider": {
        name: "Preview",
        base_url: "https://api.example.test/v1",
        wire: "responses",
        credential: "api_key",
        api_key: "****",
        headers: {},
        compat: null,
        models: {
          "qaqh-visual-preview": {
            enabled: true,
            display_name: "Visual Preview",
            context_window: 128000,
            max_output_tokens: 8192,
            reasoning_levels: ["low", "medium", "high"],
            capabilities: { tool_calls: true, image_input: true, native_web_search: false, reasoning: true },
            defaults: { max_output_tokens: 8192, reasoning_effort: "medium", native_web_search: false },
          },
        },
      },
      "local-provider": {
        name: "Local",
        base_url: "http://127.0.0.1:11434/v1",
        wire: "chat",
        credential: "api_key",
        api_key: null,
        headers: {},
        compat: null,
        models: {
          "qaqh-local-preview": {
            enabled: true,
            display_name: "Local Preview",
            context_window: 32768,
            max_output_tokens: 4096,
            reasoning_levels: [],
            capabilities: { tool_calls: true, image_input: false, native_web_search: false, reasoning: false },
            defaults: { max_output_tokens: 4096, reasoning_effort: null, native_web_search: false },
          },
        },
      },
    },
  };
  const mockQuery = async <K extends ServiceMethod>(method: K, params?: ServiceParams<K>): Promise<ServiceResult<K>> => {
    // OAuth 截图使用启动脚本注入的宿主夹具，覆盖服务读取以验证真实切换流程。
    if (previewView === "oauth" && previewParams.has("oauthState") && window.qaqhHost != null) {
      return await invoke<ServiceResult<K>>("service_query", { method, params: params ?? {} });
    }
    let result: unknown;
    if (method === "config.load") result = structuredClone(previewConfig);
    else if (method === "skills.catalog") result = structuredClone(previewSkillsCatalog);
    else if (method === "diagnostics.memory.snapshot") result = simMemorySnapshot();
    else if (method === "daemon.version") result = "0.0.0-visual-fixture";
    else if (method === "session.list" || method === "session.activity") result = [];
    else if (method === "session.meta") result = null;
    else if (method === "todo.list") result = { items: [] };
    else if (method === "workspace.list") result = [
      { id: "w1", title: "演示仓库", path: previewWorkspaceRoot, order: 0, session_ids: [], missing_dir: false },
    ];
    else throw new Error(`visual preview does not mock service ${method}`);
    return result as ServiceResult<K>;
  };
  transport.query = mockQuery;
  transport.command = async (command, target, preconditions) => {
    if (previewView === "oauth" && previewParams.has("oauthState") && window.qaqhHost != null) {
      return await invoke<Ack>("command", { command, target, preconditions });
    }
    if (command.type !== "provider.list") {
      return { status: "accepted", command_id: "visual-fixture" } as Ack;
    }
    return {
      status: "accepted",
      command_id: "visual-fixture",
      operation: "provider.list",
      result: structuredClone(previewProviderCatalog),
      revision: previewProviderCatalog.revision,
    } as Ack;
  };
}

if (previewView === "approval") {
  const approval: ApprovalView = {
    challenge_id: "visual-approval-high-risk",
    kind: "tool_permission",
    expires_in: 120,
    details: {
      tool_name: "exec_command",
      action_summary: "执行具有外部影响的命令",
      reason: "此操作会访问工作区以外的路径，并可能触发网络请求。请核对路径与命令内容。",
      paths: ["E:/workspace/project/dist/release/package.exe", "C:/workspace/cache/"],
      risk: "high",
      level: 1,
      level_name: "read-only",
      category: "filesystem + network",
      consequence: "允许后只对本次请求生效；信任会放行后续同类工具调用。",
    },
  };
  store.pending[1]([approval, { ...approval, challenge_id: "visual-approval-next", details: { tool_name: "read", risk: "low" } }]);
}

function messagesEl(): HTMLElement {
  return document.getElementById("messages") as HTMLElement;
}

// ── 测量 ─────────────────────────────────────────────────────────────────────

const longTasks: number[] = [];
try {
  new PerformanceObserver((list) => {
    for (const item of list.getEntries()) longTasks.push(Math.round(item.duration));
  }).observe({ type: "longtask", buffered: true });
} catch {
  /* 不支持 longtask 的浏览器:留空 */
}

let churnAdded = 0;
let churnRemoved = 0;
let churnObserver: MutationObserver | null = null;

function churnReset(): void {
  churnObserver?.disconnect();
  churnAdded = 0;
  churnRemoved = 0;
  churnObserver = new MutationObserver((records) => {
    for (const record of records) {
      churnAdded += record.addedNodes.length;
      churnRemoved += record.removedNodes.length;
    }
  });
  churnObserver.observe(messagesEl(), { childList: true, subtree: true });
}

function retainedChars(): number {
  return untrack(() => {
    const state = store.state[0];
    let total = 0;
    for (const key of Object.keys(state.turns)) {
      const turn = state.turns[key]!;
      total += turn.user.text.length + (turn.answer?.text.length ?? 0);
      for (const step of turn.steps) {
        if ("text" in step) total += step.text.length;
        if (step.kind === "tool") total += step.output?.text?.length ?? 0;
      }
    }
    return total;
  });
}

function metrics(): Record<string, unknown> {
  const el = messagesEl();
  const state = store.state[0];
  return untrack(() => ({
    slots: state.slots.length,
    loadedTurns: Object.keys(state.turns).length,
    runningTurns: state.runningTurns,
    failedTurns: state.failedTurns,
    activeTurnKey: state.activeTurnKey,
    oldestIndex: state.oldestIndex,
    hasMore: state.hasMore,
    structureVersion: state.structureVersion,
    retainedChars: retainedChars(),
    domNodes: el.querySelectorAll("*").length,
    mountedChars: el.textContent?.length ?? 0,
    turns: el.querySelectorAll(".turn").length,
    placeholders: el.querySelectorAll(".turn-placeholder").length,
    toolHeads: el.querySelectorAll(".tool-head").length,
    toolDetails: el.querySelectorAll(".tool-detail").length,
    timelines: el.querySelectorAll(".timeline").length,
    codeBlocks: el.querySelectorAll("pre").length,
    tables: el.querySelectorAll("table").length,
    diffNodes: el.querySelectorAll("[class*='diff']").length,
    scrollHeight: el.scrollHeight,
    scrollTop: Math.round(el.scrollTop),
    clientHeight: el.clientHeight,
    distToBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    horizontalOverflow: el.scrollWidth - el.clientWidth,
    longTasks,
    churn: { added: churnAdded, removed: churnRemoved },
    pageRequests: pageRequests.length,
  }));
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const frames = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

/** 帧间隔采样:p50/p95/max + 掉帧数(>50ms 算一次卡顿)。 */
interface FrameCadence {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  janks: number;
}

async function sampleFrames(ms: number, work: () => Promise<void>): Promise<FrameCadence> {
  const gaps: number[] = [];
  let last = performance.now();
  let stop = false;
  const tick = (): void => {
    if (stop) return;
    const now = performance.now();
    gaps.push(Math.round((now - last) * 10) / 10);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await work();
  await wait(ms);
  stop = true;
  gaps.shift();
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    frames: gaps.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    janks: gaps.filter((gap) => gap > 50).length,
  };
}

function feed(event: SessionEventPayload): void {
  const frame = { ...event, seq: ++wireSeq } as SessionEventFrame;
  store.state[1]((draft) => { applySessionEvent(draft, frame); });
}

function startTurn(turnId: string, userText: string): void {
  feed({ type: "turn_started", turn_id: turnId, input_id: null });
  feed({ type: "timeline_appended", entry: {
    kind: "input",
    data: {
      block_id: `input-${turnId}`,
      turn_id: turnId,
      purpose: "trigger_turn",
      content: { kind: "inline", data: { text: userText } },
      attachments: [],
      actor: { kind: "user", id: "stress-fixture" },
    },
  } });
}

/** v3 无 block-open 帧；stress 夹具只为渲染场景初始化活动文本块投影。 */
function seedAssistantBlock(turnId: string, blockId: string, kind: "reasoning" | "answer"): void {
  store.state[1]((draft) => {
    const turn = draft.turns[turnId];
    if (!turn) throw new Error(`missing fixture turn ${turnId}`);
    const startedAt = Date.now();
    if (kind === "reasoning") {
      turn.steps.push({ kind: "thinking", id: blockId, seq: turn.steps.length, startedAt, text: "" });
    } else {
      turn.steps.push({ kind: "text", id: blockId, seq: turn.steps.length, startedAt, text: "" });
      turn.answer = { text: "", startedAt };
      turn.answerStepId = blockId;
    }
    recomputeDerived(draft);
  });
}

const streamedText = new Map<string, string>();
function messageDelta(turnId: string, blockId: string, text: string, replace = false, blockKind: "reasoning" | "answer" = "answer"): void {
  const key = `${turnId}\0${blockId}`;
  const fullText = replace ? text : (streamedText.get(key) ?? "") + text;
  streamedText.set(key, fullText);
  feed({ type: "message_delta", turn_id: turnId, block_id: blockId, block_kind: blockKind, text: fullText });
}

function sealBlock(turnId: string, blockId: string): void {
  store.state[1]((draft) => {
    const turn = draft.turns[turnId];
    const step = turn?.steps.find((item) => item.id === blockId);
    if (step && step.kind !== "tool") step.endedAt = Date.now();
    recomputeDerived(draft);
  });
}

function seedToolCall(turnId: string, callId: string, name: string, args = "{}"): void {
  store.state[1]((draft) => {
    const turn = draft.turns[turnId];
    if (!turn) throw new Error(`missing fixture turn ${turnId}`);
    const step: ToolStep = { kind: "tool", id: callId, seq: turn.steps.length, name, argsJson: args, status: "declared", startedAt: Date.now() };
    turn.steps.push(step);
    recomputeDerived(draft);
  });
  feed({ type: "tool_arguments_delta", call_id: callId, turn_id: turnId, tool_name: name, text: args });
  feed({ type: "tool_state_changed", call_id: callId, turn_id: turnId, state: { kind: "running" } });
}

function toolOutputDelta(callId: string, text: string, stream: "stdout" | "stderr" = "stdout"): void {
  feed({ type: "tool_output_delta", call_id: callId, stream, text });
}

function finishTool(callId: string, rawOutput: string, codeDelta?: ToolStep["codeDelta"]): void {
  feed({
    type: "tool_finished",
    call_id: callId,
    outcome: { kind: "completed" },
    output: { kind: "inline", data: { text: rawOutput } },
    output_truncated: false,
    metrics: null,
    ...(codeDelta != null ? { code_delta: codeDelta } : {}),
  });
}

function finishTurn(turnId: string): void {
  feed({ type: "turn_ended", turn_id: turnId, outcome: { kind: "finished", data: { terminal: "completed", usage: null, error: null } } });
}

const report: Array<Record<string, unknown>> = [];

const scenarios = {
  /** 真 TurnView：assistant 文本边界动画、卸载与回复节点稳定性。 */
  async workCollapse(): Promise<Record<string, unknown>> {
    const id = `collapse-${fixtureIdSeq++}`;
    startTurn(id, "工作段回收动画验收");
    seedToolCall(id, "command", "exec");
    finishTool("command", JSON.stringify({ output: "检查完成\n结果已就绪", exit_code: 0 }));
    await frames(10);
    const slot = document.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(id)}"]`)!;
    const group = slot.querySelector<HTMLElement>(".work-group")!;
    const collapse = group.querySelector<HTMLElement>(":scope > .collapse")!;
    const initialHeight = collapse.getBoundingClientRect().height;
    if (initialHeight <= 0) throw new Error("工作段未展开");
    seedAssistantBlock(id, "reply", "answer");
    messageDelta(id, "reply", "已完成检查，以下是结果。");
    const heights: number[] = [];
    for (let i = 0; i < 24; i++) {
      await frames(1);
      heights.push(Math.round(collapse.getBoundingClientRect().height * 100) / 100);
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animated = heights.some((height) => height > 1 && height < initialHeight - 1);
    if (!reduced && !animated) throw new Error(`自动回收未出现中间帧: ${JSON.stringify(heights)}`);
    if (collapse.querySelector(".tool-head")) throw new Error("动画后工具子树未卸载");
    if (collapse.getBoundingClientRect().height > 1) throw new Error("工作段未收起");
    const reply = slot.querySelector("[data-text-id='reply'] .md-host");
    if (!reply) throw new Error("回复未挂载");
    messageDelta(id, "reply", " 回复继续流式更新。");
    await frames(10);
    if (slot.querySelector("[data-text-id='reply'] .md-host") !== reply) throw new Error("流式回复被重挂");
    group.querySelector<HTMLButtonElement>(".collapsed-row")!.click();
    await frames(18);
    if (!collapse.querySelector(".tool-head")) throw new Error("用户无法重新展开工作段");
    finishTurn(id);
    await frames(10);
    if (group.querySelector(".collapsed-row")?.getAttribute("aria-expanded") !== "true") throw new Error("完成事件重置用户展开态");
    return { initialHeight, heights, animated, reduced, unloaded: true, replyStable: true, manualReopen: true, ...metrics() };
  },
  /** Theme switcher for visual review of the Web/Electron surface. */
  theme(mode: ResolvedTheme): { theme: ResolvedTheme; owner: "web" } {
    applyTheme(mode);
    return { theme: mode, owner: "web" };
  },
  async thinking(): Promise<Record<string, unknown>> {
    const id = `thinking-${fixtureIdSeq++}`;
    startTurn(id, "长思考尾随行为验收");
    seedAssistantBlock(id, id, "reasoning");
    const cadence = await sampleFrames(120, async () => {
      for (let tick = 0; tick < 300; tick += 1) {
        messageDelta(id, id, "思考".repeat(150));
        await wait(10);
      }
    });
    await frames(3);
    const scroller = document.querySelector<HTMLElement>(".thinking-full");
    const textChars = scroller?.textContent?.length ?? 0;
    const lineHeight = scroller == null ? 0 : parseFloat(getComputedStyle(scroller).lineHeight);
    const bounded = scroller != null && scroller.clientHeight <= lineHeight * 4 + 1;
    const following = scroller != null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
    sealBlock(id, id);
    seedAssistantBlock(id, `${id}-new`, "reasoning");
    await frames(3);
    const reset = document.querySelector(".thinking-full")?.textContent === "";
    finishTurn(id);
    await frames(3);
    return { textChars, bounded, following, reset, correct: textChars === 90_000 && bounded && following && reset, cadence, m: metrics() };
  },
  /** 合成 token 是 4 个中文字符,每 10ms 到一批;测试真实 store/组件,不模拟响应式。 */
  async highRate(rate = 300, seconds = 6): Promise<Record<string, unknown>> {
    const id = `rate-${rate}-${fixtureIdSeq++}`;
    const token = "持续输出";
    const expected = new Map<string, string>();
    let block = `${id}-text-0`;
    let fedTokens = 0;
    let textIdentityLost = false;
    let stableText: Element | null = null;
    const tasksBefore = longTasks.length;
    startTurn(id, `持续 ${rate} 合成 token/s`);
    seedAssistantBlock(id, `${id}-reason`, "reasoning");
    messageDelta(id, `${id}-reason`, "思考末尾必须保留");
    sealBlock(id, `${id}-reason`);
    seedAssistantBlock(id, block, "answer");
    await frames(2);
    churnReset();
    const plainChurn = { added: 0, removed: 0 };
    for (let frame = 0; frame < 12 && messagesEl().querySelector(`[data-text-id="${block}"]`) == null; frame += 1) await frames(1);
    const observedText = messagesEl().querySelector(`[data-text-id="${block}"]`);
    if (observedText == null) throw new Error("流式文本容器未挂载");
    const watch = new MutationObserver((records) => {
      for (const record of records) { plainChurn.added += record.addedNodes.length; plainChurn.removed += record.removedNodes.length; }
    });
    watch.observe(observedText, { childList: true, subtree: true });
    const startedAt = performance.now();
    const cadence = await sampleFrames(180, async () => {
      const ticks = Math.round(seconds * 100);
      for (let tick = 0; tick < ticks; tick += 1) {
        // 每两秒进入下一个工作段,同一任务内混合中途回复与工具。
        if (tick > 0 && tick % 200 === 0) {
          sealBlock(id, block);
          const tool = `${id}-tool-${tick}`;
          seedToolCall(id, tool, "exec");
          toolOutputDelta(tool, "工具末尾必须保留");
          finishTool(tool, JSON.stringify({ output: "工具末尾必须保留" }));
          block = `${id}-text-${tick}`;
          seedAssistantBlock(id, block, "answer");
        }
        for (let n = 0; n < rate / 100; n += 1) {
          messageDelta(id, block, token);
          expected.set(block, (expected.get(block) ?? "") + token);
          fedTokens += 1;
        }
        if (stableText == null) stableText = messagesEl().querySelector(`[data-text-id="${id}-text-0"]`);
        else if (messagesEl().querySelector(`[data-text-id="${id}-text-0"]`) !== stableText) textIdentityLost = true;
        await wait(Math.max(0, startedAt + (tick + 1) * 10 - performance.now()));
      }
      // 最后几个 message_delta 与 turn_ended 刻意落在同一帧。
      finishTurn(id);
    });
    await frames(30);
    watch.disconnect();
    const turn = untrack(() => store.state[0].turns[id]!);
    const lostChars = untrack(() => [...expected].reduce((sum, [key, text]) => {
      const step = turn.steps.find((item) => item.id === key);
      return sum + Math.max(0, text.length - (step != null && "text" in step ? step.text.length : 0));
    }, 0));
    const renderedCorrect = [...expected].every(([key, text]) => messagesEl().querySelector(`[data-text-id="${key}"]`)?.textContent === text);
    const work = messagesEl().querySelector(`[data-text-id="${id}-text-0"]`)?.previousElementSibling;
    const remainedCollapsed = work?.querySelector(".collapsed-row")?.getAttribute("aria-expanded") === "false";
    return { rate, seconds, fedTokens, elapsedMs: Math.round(performance.now() - startedAt), cadence, lostChars, renderedCorrect, textIdentityLost, remainedCollapsed, plainChurn, streamLongTasks: longTasks.slice(tasksBefore), m: metrics() };
  },
  async checkpoint(): Promise<Record<string, unknown>> {
    const id = `checkpoint-${fixtureIdSeq++}`;
    startTurn(id, "message delta checkpoint replacement");
    seedAssistantBlock(id, id, "answer");
    messageDelta(id, id, "OLD paragraph\n\nTAIL");
    await frames(30);
    messageDelta(id, id, "NEW paragraph\n\nTAIL", true);
    await frames(3);
    const rewritten = messagesEl().querySelector(`[data-text-id="${id}"]`)?.textContent ?? "";
    messageDelta(id, id, "", true);
    await frames(3);
    const cleared = messagesEl().querySelector(`[data-text-id="${id}"]`)?.textContent === "";
    return { rewritten, cleared, correct: rewritten.includes("NEW") && !rewritten.includes("OLD") && cleared, m: metrics() };
  },
  /** 流式一个新回合:思考 + 工具 + 大段 Markdown 作答,测每帧工作量。 */
  async stream(): Promise<Record<string, unknown>> {
    const id = "t200";
    churnReset();
    const requestsAtStart = pageRequests.length;
    let fedAnswerChars = 0;
    let fedThinkingChars = 0;
    startTurn(id, "第 200 问：接着刚才的继续说");
    seedAssistantBlock(id, "r200", "reasoning");
    const cadence = await sampleFrames(120, async () => {
      for (let i = 0; i < 40; i += 1) {
        const delta = prose(mulberry32(i), 60);
        fedThinkingChars += delta.length;
        messageDelta(id, "r200", delta);
        await wait(8);
      }
    });
    sealBlock(id, "r200");
    seedToolCall(id, "e200", "exec");
    await wait(60);
    finishTool("e200", JSON.stringify({ output: ansiLog(mulberry32(200), 120), exit_code: 0 }));
    seedAssistantBlock(id, "x200", "answer");
    // 视觉更新节奏:尾块(.md-tail)每被写一次 DOM 就是一次「用户看到文字变多」。
    const paintAt: number[] = [];
    let seenRecords = 0;
    const paintWatch = new MutationObserver((records) => {
      seenRecords += records.length;
      if (records.some((record) => (record.target as HTMLElement).classList?.contains("md-tail"))) paintAt.push(performance.now());
    });
    paintWatch.observe(messagesEl(), { childList: true, subtree: true, characterData: true });
    const answerCadence = await sampleFrames(150, async () => {
      const text = markdownOf(mulberry32(700), 200, 9_000);
      for (let i = 0; i < text.length; i += 240) {
        fedAnswerChars += Math.min(240, text.length - i);
        messageDelta(id, "x200", text.slice(i, i + 240));
        await wait(6);
      }
    });
    paintWatch.disconnect();
    const gaps = paintAt.slice(1).map((at, i) => Math.round(at - paintAt[i]!));
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const paintCadence = {
      paints: paintAt.length,
      seenRecords,
      tailNodes: messagesEl().querySelectorAll(".md-tail").length,
      // store 侧真相 vs 喂进去的字符数:差额就是被「缺口判定」丢掉的帧。
      resnapshotsDuringStream: pageRequests.length - requestsAtStart,
      fedThinkingChars,
      fedAnswerChars,
      ...untrack(() => {
        const turn = store.state[0].turns[id];
        const thinking = turn?.steps.find((step) => step.id === "r200");
        const answer = turn?.steps.find((step) => step.id === "x200");
        return {
          steps: turn?.steps.length ?? -1,
          storedThinkingChars: thinking != null && "text" in thinking ? thinking.text.length : -1,
          storedAnswerChars: answer != null && "text" in answer ? answer.text.length : -1,
          structureVersion: store.state[0].structureVersion,
          fixtureIdSeqUsed: fixtureIdSeq,
        };
      }),
      p50Ms: sortedGaps[Math.floor(sortedGaps.length * 0.5)] ?? 0,
      p95Ms: sortedGaps[Math.floor(sortedGaps.length * 0.95)] ?? 0,
      maxMs: sortedGaps[sortedGaps.length - 1] ?? 0,
    };
    await frames(20); // 等 reveal 与贴底循环都收敛,再量 dist
    const out = { name: "stream", thinkingCadence: cadence, answerCadence, paintCadence, settledChurn: { added: churnAdded, removed: churnRemoved }, ...metrics() };
    report.push(out);
    return out;
  },

  /** 大流之后等待布局与假分页状态稳定,测页面重排 churn。 */
  async realign(): Promise<Record<string, unknown>> {
    churnReset();
    const before = metrics();
    messageDelta("t200", "x200", "");
    await wait(400);
    await frames(6);
    const after = metrics();
    const out = {
      name: "realign",
      churn: { added: churnAdded, removed: churnRemoved },
      before: { slots: before.slots, domNodes: before.domNodes, mountedChars: before.mountedChars, loadedTurns: before.loadedTurns },
      after,
    };
    report.push(out);
    return out;
  },

  /** 展开时间线与工具详情(顺带验 turn.key 在重对齐之后仍然可用)。 */
  async expand(): Promise<Record<string, unknown>> {
    const el = messagesEl();
    const before = el.scrollTop;
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".collapsed-row")).slice(0, 3);
    for (const row of rows) row.click();
    await frames(20);
    const timelinesAfterRows = el.querySelectorAll(".timeline").length;
    const heads = Array.from(el.querySelectorAll<HTMLElement>(".tool-head")).slice(0, 6);
    for (const head of heads) head.click();
    await frames(20);
    const out = {
      name: "expand",
      clickedRows: rows.length,
      timelinesAfterRows,
      clickedHeads: heads.length,
      scrollDeltaFromExpand: Math.round(el.scrollTop - before),
      ...metrics(),
    };
    report.push(out);
    return out;
  },

  /** 触顶翻页:滚轮到顶 → 每轮 loadOlder 一页;测滚动补偿(spec §14.2)。 */
  async toTop(): Promise<Record<string, unknown>> {
    const el = messagesEl();
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1_200, bubbles: true }));
    pageRequests = [];
    const rounds: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 8; i += 1) {
      // 位置不变就不会有 scroll 事件(测试里必须自己制造一次变化)。
      el.scrollTop = Math.min(60, Math.max(1, el.scrollTop));
      await frames(2);
      el.scrollTop = 0;
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1_200, bubbles: true }));
      // 锚点取「触顶这一刻视口里的行」——等这一页落地后再比,才等于用户体感:
      // 前插不该把正在看的内容从视口里挪走。
      const box = el.getBoundingClientRect();
      const anchor = Array.from(el.querySelectorAll<HTMLElement>("[data-slot-key]")).find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > box.top + 4 && rect.top < box.bottom - 4;
      });
      const key = anchor?.dataset.slotKey ?? "";
      const topBefore = anchor?.getBoundingClientRect().top ?? 0;
      await wait(260);
      await frames(12);
      const moved = el.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(key)}"]`);
      rounds.push({
        round: i,
        requests: pageRequests.length,
        slots: store.state[0].slots.length,
        oldestIndex: store.state[0].oldestIndex,
        anchorKey: key,
        anchorMovedPx: moved == null ? "anchor-gone" : Math.round(moved.getBoundingClientRect().top - topBefore),
        scrollTopAfter: Math.round(el.scrollTop),
      });
      if (pageRequests.length >= 5) break;
    }
    await wait(400);
    await frames(12);
    const out = { name: "toTop", rounds, ...metrics() };
    report.push(out);
    return out;
  },

  /** 回到底部:自动跟随是否收敛 + 窗口淘汰是否生效。 */
  async toBottom(): Promise<Record<string, unknown>> {
    const el = messagesEl();
    const steps: Array<Record<string, number>> = [];
    for (let i = 0; i < 40; i += 1) {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 3_000, bubbles: true }));
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 120);
      await frames(2);
      el.scrollTop = el.scrollHeight;
      await wait(50);
      const dist = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
      steps.push({ i, dist });
      if (dist < 60) break;
    }
    const settled = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
    await wait(600); // 给 requestIdleCallback 的 refit(窗口淘汰)时间
    await frames(20);
    const out = { name: "toBottom", distAfterScroll: settled, scrollSteps: steps.length, buttonVisible: document.querySelector(".back-bottom") != null, ...metrics() };
    report.push(out);
    return out;
  },

  /**
   * 尾块重绘代价:模拟「每帧重解析未闭合尾块」这条路径(Markdown.tsx 只在单帧
   * 超出 PAINT_BUDGET_MS=4 时才退回 THROTTLE_MS=120 限频,并非恒定 8fps),量
   * 它在不同尾块长度下单帧要多久 —— 120Hz 预算 8.3ms/帧,90Hz 是 11.1ms/帧。
   */
  async markdownCost(): Promise<Record<string, unknown>> {
    const split = await import("./markdown/split");
    const render = await import("./markdown/render");
    const rand = mulberry32(4242);
    const results: Array<Record<string, unknown>> = [];
    for (const [label, make] of [
      ["段落(CJK,每 240 字增长)", () => prose(rand, 240)],
      ["代码围栏(未闭合,持续增长)", () => "for (let i = 0; i < n; i += 1) { await flush(delta[" + Math.floor(rand() * 99) + "]); }\n"],
      ["表格(未闭合,每帧一行)", () => `| w-${Math.floor(rand() * 999)} | ${Math.floor(rand() * 977)}ms | ${Math.floor(rand() * 260)}px | auto | ok |\n`],
      ["单段无换行 150KB(病态)", () => "字".repeat(1000)],
      ["未闭合代码围栏 150KB(病态)", () => "let x = " + Math.floor(rand() * 999) + "; // 注释\n".repeat(40)],
    ] as Array<[string, () => string]>) {
      let text = "";
      const per: number[] = [];
      for (let step = 0; step < (label.includes("病态") ? 150 : 120); step += 1) {
        text += make();
        const t0 = performance.now();
        const blocks = split.splitBlocks(text);
        const html = render.renderMarkdownHtml(blocks[blocks.length - 1]!.content);
        const host = document.createElement("div");
        host.innerHTML = html;
        per.push(Math.round((performance.now() - t0) * 100) / 100);
      }
      const sorted = [...per].sort((a, b) => a - b);
      results.push({
        shape: label,
        tailChars: text.length,
        paintP50Ms: sorted[Math.floor(sorted.length * 0.5)],
        paintP95Ms: sorted[Math.floor(sorted.length * 0.95)],
        paintMaxMs: sorted[sorted.length - 1],
        totalMs: Math.round(per.reduce((sum, ms) => sum + ms, 0)),
        overBudget120: per.filter((ms) => ms > 8.3).length,
      });
    }
    const out = { name: "markdownCost", results };
    report.push(out);
    return out;
  },

  /**
   * 昂贵形状:持续流一张 200 行的表格(实测这种尾块单帧重解析 p50 5.9ms、
   * max 15.5ms,超 120Hz 的 8.3ms 预算)。用来验 Markdown 的预算自适应确实会
   * 从「每帧画」退回「限频画」——即绘制间隔应出现 ~120ms 的档位。
   */
  async tableStream(): Promise<Record<string, unknown>> {
    const id = "t201";
    const el = messagesEl();
    const paintAt: number[] = [];
    const watch = new MutationObserver((records) => {
      if (records.some((record) => (record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement)?.closest(".md-tail"))) paintAt.push(performance.now());
    });
    startTurn(id, "第 201 问：把窗口逐行列出来");
    seedAssistantBlock(id, "x201", "answer");
    messageDelta(id, "x201", "| item | time | width | policy | result |\n| --- | --- | --- | --- | --- |\n");
    await frames(2);
    watch.observe(el, { childList: true, characterData: true, subtree: true });
    const cadence = await sampleFrames(200, async () => {
      for (let row = 0; row < 200; row += 1) {
        messageDelta(id, "x201", `| w-${row} | ${(row * 7919) % 977}ms | ${(row * 31) % 260}px | ${row % 2 ? "auto" : "content"} | ok |\n`);
        await wait(8);
      }
    });
    watch.disconnect();
    finishTurn(id);
    await frames(20);
    const gaps = paintAt.slice(1).map((at, i) => Math.round(at - paintAt[i]!));
    const sorted = [...gaps].sort((a, b) => a - b);
    const out = {
      name: "tableStream",
      frameCadence: cadence,
      paints: paintAt.length,
      paintGapP50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      paintGapP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      throttledPaints: gaps.filter((gap) => gap > 60).length,
      frameRatePaints: gaps.filter((gap) => gap <= 40).length,
      tableRows: el.querySelector('[data-text-id="x201"]')?.querySelectorAll("table tr").length ?? 0,
      ...metrics(),
    };
    report.push(out);
    return out;
  },

  /**
   * 只做动画、不做测量:驱动那边用 CDP Performance.getMetrics 取累计
   * Layout/RecalcStyle/Script 时长与 FrameCount,算出每帧成本
   * (`long-animation-frame` 只报 >50ms 的帧,量不出 8.3ms 预算)。
   */
  async animate(target: "collapse" | "tool" | "dock", times: number): Promise<Record<string, unknown>> {
    const el = messagesEl();
    const settle = async (frames: number): Promise<void> => {
      for (let i = 0; i < frames; i += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    let acted = 0;
    if (target === "dock") {
      const head = document.querySelector<HTMLElement>(".rail-trigger");
      for (let i = 0; i < times && head != null; i += 1) {
        head.click();
        await settle(20); // 260ms 过渡 @60Hz ≈ 16 帧
        acted += 1;
      }
    } else {
      const selector = target === "collapse" ? ".collapsed-row" : ".tool-head";
      const rows = Array.from(el.querySelectorAll<HTMLElement>(selector)).slice(0, times);
      for (const row of rows) {
        row.click();
        await settle(16); // 180ms 展开过渡
        acted += 1;
      }
      for (const row of rows.slice().reverse()) {
        row.click();
        await settle(14); // 140ms 收起过渡
      }
    }
    return { name: "animate", target, acted, ...metrics() };
  },

  /** 回归闸:exec 进度帧(`tool_output_delta`)对消息区必须零成本——
   *  不留尾窗、不 bump renderVersion、DOM 里没有 `.tool-progress` 渲染点。
   *  正文唯一渲染位在后台执行抽屉。mode/linesPerChunk 保留旧调用面。 */
  async progressStream(mode: "merged" | "direct" = "merged", linesPerChunk = 3): Promise<Record<string, unknown>> {
    const id = mode === "merged" ? "t202" : "t203";
    const blockId = mode === "merged" ? "p202" : "p203";
    // 先造好数据:排除夹具自己的字符串生成开销。
    const chunks = Array.from({ length: 150 }, (_, i) => ansiLog(mulberry32(i), linesPerChunk));
    startTurn(id, `第 ${id.slice(1)} 问：跑个长任务`);
    seedToolCall(id, blockId, "exec_command");
    await frames(4);
    const el = messagesEl();
    const row = el.querySelector<HTMLElement>(`[data-tool-call-id="${blockId}"]`);
    let progressWrites = 0;
    const watch = new MutationObserver((records) => {
      // characterData 记录的 target 是文本节点,没有 closest —— 先归一到元素。
      const hit = records.some((record) => {
        const raw = record.target as Node;
        const node = raw.nodeType === 1 ? (raw as HTMLElement) : raw.parentElement;
        return node != null && row != null && (node === row || row.contains(node));
      });
      if (hit) progressWrites += 1;
    });
    churnReset();
    const renderVersionBefore = untrack(() => store.state[0].turns[id]?.renderVersion ?? 0);
    const t0 = performance.now();
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    const cadence = await sampleFrames(150, async () => {
      for (const chunk of chunks) {
        toolOutputDelta(blockId, chunk);
        await wait(2);
      }
    });
    watch.disconnect();
    const elapsedMs = Math.round(performance.now() - t0);
    const renderVersionAfter = untrack(() => store.state[0].turns[id]?.renderVersion ?? 0);
    if (renderVersionAfter !== renderVersionBefore) {
      throw new Error(`tool_output_delta 仍在推动转录重渲染: renderVersion ${renderVersionBefore} → ${renderVersionAfter}`);
    }
    if (document.querySelector(".tool-progress") != null) throw new Error("`.tool-progress` 渲染位未退役干净");
    const tailChars = untrack(() => {
      const step = store.state[0].turns[id]?.steps.find((item) => item.id === blockId);
      return step != null && step.kind === "tool" ? step.output?.text?.length ?? 0 : -1;
    });
    finishTool(blockId, JSON.stringify({ output: "done\n", exit_code: 0 }));
    await frames(10);
    const out = { name: `progressStream:${mode}`, mode, linesPerChunk, cadence, elapsedMs, tailChars, fedChunks: chunks.length, progressWrites, churn: { added: churnAdded, removed: churnRemoved }, ...metrics() };
    report.push(out);
    return out;
  },

  /** 版式:横向溢出与表格/代码块/长行的表现。 */
  layout(): Record<string, unknown> {
    const el = messagesEl();
    const offenders: string[] = [];
    for (const node of Array.from(el.querySelectorAll<HTMLElement>(".turn, table, pre, .tool-text, .bubble, .thinking-full"))) {
      if (node.scrollWidth - node.clientWidth > 2) offenders.push(`${node.className}|+${node.scrollWidth - node.clientWidth}`);
    }
    const out = {
      name: "layout",
      innerWidth: window.innerWidth,
      offenders: offenders.slice(0, 10),
      turnWidths: Array.from(el.querySelectorAll<HTMLElement>(".turn")).slice(0, 3).map((node) => Math.round(node.getBoundingClientRect().width)),
      zeroHeightTurns: Array.from(el.querySelectorAll<HTMLElement>(".turn")).filter((node) => node.getBoundingClientRect().height < 40).length,
      ...metrics(),
    };
    report.push(out);
    return out;
  },
  /**
   * Diff 审查抽屉:验证「过大只降级、不藏行」这条契约。
   * 1. 走 v3 tool_finished 的原始输出与 code_delta,顺带守住 reducer 的原始 diff 解析;
   * 2. 3000 行文件远超富渲染门槛(1200 行),行集必须仍全量可达——中段滚过去要看得见;
   * 3. DOM 只挂可见行 ±overscan,滚动帧间隔不许出现长任务。
   */
  async diffDrawer(): Promise<Record<string, unknown>> {
    const id = "t900";
    const total = 3000;
    const line = (index: number): string => `+  const drawerRow${index} = compute(${index}, "diff 抽屉压力夹具");`;
    const bigDiff = `--- a/src/drawer_big.ts\n+++ b/src/drawer_big.ts\n@@ -0,0 +1,${total} @@\n${Array.from({ length: total }, (_, i) => line(i)).join("\n")}\n`;
    const smallDiff = `--- a/src/drawer_small.ts\n+++ b/src/drawer_small.ts\n@@ -0,0 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+  const small${i} = ${i};`).join("\n")}\n`;

    const feedWrite = (blockId: string, diff: string): void => {
      seedToolCall(id, blockId, "write", JSON.stringify({ path: blockId }));
      const linesAdded = blockId === "drawer-big" ? total : 40;
      finishTool(blockId, JSON.stringify({ output: `[OK] ${blockId} — written`, diff }), {
        lines_added: linesAdded, lines_removed: 0, files_created: 0, files_deleted: 0, file: null,
      });
    };

    startTurn(id, "第 900 问：把抽屉撑爆试试");
    feedWrite("drawer-small", smallDiff);
    feedWrite("drawer-big", bigDiff);
    finishTurn(id);
    await frames(20);

    // 别的夹具也往同一个 store 里塞过带写入的回合,所以整页首个卡片未必是本次的——按槽位取。
    const slot = document.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(id)}"]`);
    if (slot == null) throw new Error("回合未落到时间线槽位");
    const card = slot.querySelector<HTMLElement>(".turn-deliverables-card");
    if (card == null) throw new Error("回合密封后交付卡未挂载");
    const collapsedRows = card.querySelectorAll(".deliverables-file-item").length;
    if (collapsedRows > 3) throw new Error(`交付卡折叠态应只留 3 行,实测 ${collapsedRows}`);

    card.querySelector<HTMLElement>(".deliverables-file-item")!.click();
    await wait(400); // 抽屉滑入 200ms 后才挂载虚拟视图
    await frames(10);
    const panel = document.querySelector<HTMLElement>(".diff-drawer-panel");
    if (panel == null) throw new Error("点击文件行未唤起审查抽屉");

    // 侧栏里选中那个 3000 行的文件(按路径认,不按下标)。
    const bigRow = [...panel.querySelectorAll<HTMLElement>(".diff-drawer-file-row")]
      .find((row) => row.textContent?.includes("drawer_big.ts"));
    if (bigRow == null) throw new Error("侧栏未列出超限文件");
    bigRow.click();
    await frames(10);
    if (panel.querySelector<HTMLElement>(".diff-scroll") != null) throw new Error("3000 行文件默认就该折叠(BIG_DIFF_LINES=400)");
    panel.querySelector<HTMLElement>(".diff-file-head")!.click();
    await frames(10);
    const scroll = panel.querySelector<HTMLElement>(".diff-scroll");
    if (scroll == null) throw new Error("展开后未挂载虚拟滚动容器");
    const windowEl = scroll.querySelector<HTMLElement>(".diff-rows-window")!;
    const domRowsAt = (): number => windowEl.querySelectorAll(".diff-row").length;
    const mounted = domRowsAt();
    if (mounted > 140) throw new Error(`虚拟开窗未收束 DOM:可见 ${mounted} 行 / 总 ${total + 1} 行`);

    // 滚到正中:截断版这里会是「省略 N 行」占位,全量版必须交出第 1500 行原文。
    // 速度取人类快速滚动量级(16ms 走 120px ≈ 每帧换 6 行)。刻意「每帧换掉整个
    // 视口」的量级(240px/6ms)测的是 For 的回收上限,不是真实交互,会把 p50 顶到
    // 40ms 却说明不了任何事——对照组 tableStream 在同一环境是 16.7ms / 0 jank。
    const middleTop = Math.floor((total / 2) * 21);
    const walk = 2400;
    scroll.scrollTop = middleTop - walk;
    scroll.dispatchEvent(new Event("scroll"));
    await frames(4);
    const cadence = await sampleFrames(360, async () => {
      for (let offset = 0; offset <= walk; offset += 120) {
        scroll.scrollTop = middleTop - walk + offset;
        scroll.dispatchEvent(new Event("scroll"));
        await wait(16);
      }
      await frames(4);
    });
    const middleText = windowEl.textContent ?? "";
    if (!middleText.includes("drawerRow1500")) {
      throw new Error(`超限文件的中段行被藏掉了(截断未取消):${middleText.slice(0, 80)}`);
    }
    if (cadence.janks > 0) throw new Error(`人工滚动速度下出现 ${cadence.janks} 个 >50ms 长帧(p50 ${cadence.p50}ms)`);
    const omittedMarkers = windowEl.querySelectorAll(".diff-row.omit").length;

    scroll.scrollTop = total * 21;
    scroll.dispatchEvent(new Event("scroll"));
    await frames(6);
    const tailVisible = (windowEl.textContent ?? "").includes(`drawerRow${total - 1}`);
    const drawerDomNodes = panel.querySelectorAll("*").length;

    panel.querySelector<HTMLElement>(".diff-drawer-close-btn")!.click();
    await frames(6);
    if (document.querySelector(".diff-drawer-panel") != null) throw new Error("关闭抽屉后子树未物理卸载");

    // 监听器泄漏闸:effect 的 apply 作用域里 onCleanup 是惰性的,曾经每开一次抽屉
    // 就多挂一个 keydown。数两轮开/关的 add 与 remove 是否配平。
    type ListenerArgs = Parameters<typeof window.addEventListener>;
    const addRef = window.addEventListener;
    const removeRef = window.removeEventListener;
    let keydownAdds = 0;
    let keydownRemoves = 0;
    window.addEventListener = (...args: ListenerArgs): void => {
      if (args[0] === "keydown") keydownAdds += 1;
      (addRef as (...items: ListenerArgs) => void)(...args);
    };
    window.removeEventListener = (...args: ListenerArgs): void => {
      if (args[0] === "keydown") keydownRemoves += 1;
      (removeRef as (...items: ListenerArgs) => void)(...args);
    };
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      card.querySelector<HTMLElement>(".deliverables-file-item")!.click();
      await frames(8);
      if (document.querySelector(".diff-drawer-panel") == null) throw new Error(`第 ${cycle} 轮未能重开抽屉`);
      document.querySelector<HTMLElement>(".diff-drawer-close-btn")!.click();
      await frames(8);
      if (document.querySelector(".diff-drawer-panel") != null) throw new Error(`第 ${cycle} 轮关闭后未卸载`);
    }
    window.addEventListener = addRef;
    window.removeEventListener = removeRef;
    if (keydownAdds !== keydownRemoves) throw new Error(`keydown 监听泄漏: add ${keydownAdds} / remove ${keydownRemoves}`);
    if (keydownAdds < 2) throw new Error(`两轮开关只挂了 ${keydownAdds} 个监听,计数本身不可信`);

    const out = {
      name: "diffDrawer",
      diffLines: total,
      collapsedCardRows: collapsedRows,
      virtualDomRows: mounted,
      scrollCadence: cadence,
      middleRowReachable: true,
      tailVisible,
      omittedMarkers,
      keydownAdds,
      keydownRemoves,
      drawerDomNodes,
      retainedDiffChars: bigDiff.length + smallDiff.length,
      ...metrics(),
    };
    report.push(out);
    return out;
  },
  material(mode: SessionMaterial): Record<string, unknown> {
    setSessionMaterial(mode);
    return { name: "material", mode, dataset: document.documentElement.dataset.material };
  },
  /** 400 回合长时间线:窗口化 + content-visibility + 逐帧贴底的复现床
   *  (安装版「下半空白」问题的定点压测;CDP 驱动:await __stress.scenarios.flood())。 */
  async flood(count = 400): Promise<Record<string, unknown>> {
    const words = ["布局", "渲染", "合成器", "光栅", "滚动", "分页", "占位", "窗口", "队列", "缓存"];
    for (let i = 0; i < count; i++) {
      const id = `flood-${fixtureIdSeq++}`;
      startTurn(id, `压测回合 ${i + 1} / ${count}`);
      seedAssistantBlock(id, "reply", "answer");
      let md = `## 第 ${i + 1} 段输出\n\n`;
      for (let j = 0; j < 6; j++) md += Array.from({ length: 40 }, (_, k) => words[(i + j + k) % words.length]).join("") + "\n\n";
      md += "```js\n" + Array.from({ length: 8 }, (_, k) => `const x${k} = ${i * k};`).join("\n") + "\n```\n";
      messageDelta(id, "reply", md, true);
      if (i % 50 === 0) await frames(2);
    }
    await frames(30);
    return {
      name: "flood", turns: count,
      scrollerH: document.getElementById("messages")?.scrollHeight ?? 0,
      slots: document.querySelectorAll("[data-slot-key]").length,
    };
  },
};

// URL switches make visual review reproducible without changing production preferences.
const previewTheme = previewParams.get("theme");
if (previewTheme === "light" || previewTheme === "dark") applyTheme(previewTheme, false);
const previewMaterial = previewParams.get("material");
if (previewMaterial === "glass" || previewMaterial === "solid") setSessionMaterial(previewMaterial);

/** `?attach=` → 待发附件的确定性夹具态(ready|uploading|failed)。 */
const previewAttach = previewParams.get("attach");
const fixtureMetrics = {
  tokensPerSecond: 46.2,
  contextPercent: 34,
  contextWindow: 200_000,
  cacheHitPercent: 88,
  extras: { completion_thinking_tokens: 32, credit: 4 },
};

/**
 * 夹具的会话级 profile 视图(§1.5)。推导规则和真实 store 一致:选了本会话专属
 * 的 profile 就拿不到它的 model(`ConfigDto` 只下发活跃 profile 的),于是看得出
 * 「model 未公开」那一档长什么样。
 */
const [previewProfile, setPreviewProfile] = createSignal<string | null>(null);
const fixtureProfileView = (): import("./session/store").SessionProfileView => {
  const selected = previewProfile();
  return {
    effective: selected ?? "视觉验收",
    model: selected == null ? "qaqh-visual-preview" : null,
    providerKind: "byok",
  };
};

/** `?attach=` → 夹具的确定性附件态(与生产同一套 chip 类,只是不走真上传)。 */
function fixtureAttachments(): import("./session/store").PendingAttachment[] {
  const ref = (id: string): string => id;
  if (previewAttach === "ready") {
    return [
      { id: "E:/shots/approval-dark.png", name: "approval-dark.png", size: 284512, mediaType: "image/png", state: "ready", reference: ref("sha256:9f2c1a"), error: null },
      { id: "E:/qaqh-desktop-app/docs/ui-visual-spec.md", name: "ui-visual-spec.md", size: 18432, mediaType: "text/markdown", state: "ready", reference: ref("sha256:41abe7"), error: null },
    ];
  }
  if (previewAttach === "uploading") {
    return [{ id: "E:/shots/uploading.png", name: "uploading.png", size: 0, mediaType: "", state: "uploading", reference: null, error: null }];
  }
  if (previewAttach === "failed") {
    return [{ id: "E:/missing/archive.zip", name: "archive.zip", size: 0, mediaType: "", state: "failed", reference: null, error: "上传失败:413 payload too large" }];
  }
  return [];
}

/**
 * `+` 按钮的演示:推一个 uploading chip,再翻成 ready——生产的这一段是宿主
 * 「读盘 + POST /ringing/v2/content」,夹具用定时器替掉往返。
 */
function simulateAttach(): void {
  const target = previewActiveTab().store;
  const id = "E:/shots/pasted-clipboard.png";
  if (target.pendingAttachments[0]().some((item) => item.id === id)) return;
  target.pendingAttachments[1]((current) => [...current, { id, name: "pasted-clipboard.png", size: 0, mediaType: "", state: "uploading", reference: null, error: null }]);
  setTimeout(() => {
    target.pendingAttachments[1]((current) => current.map((item) => item.id === id
      ? { ...item, size: 155648, mediaType: "image/png", state: "ready", reference: "sha256:be71d0" }
      : item));
  }, 600);
}

/**
 * 相机按钮的演示:与 `simulateAttach` 同一套 chip 状态机,只是来源换成系统截图
 * (生产的这一段是宿主 `capture_screenshot` 写临时文件 → `upload_attachment` 换引用,
 * 夹具用定时器替掉这两次往返)。
 *
 * 刻意复用同一个 id 前缀 `E:/shots/`:这样点两次能当场看出**去重**在不在
 * ——截图键被连按时不该叠出两个一样的 chip。
 */
function simulateScreenshot(): void {
  const target = previewActiveTab().store;
  const id = "E:/shots/qaqh-shot-1728000000000.png";
  if (target.pendingAttachments[0]().some((item) => item.id === id)) return;
  target.pendingAttachments[1]((current) => [...current, { id, name: "qaqh-shot-1728000000000.png", size: 0, mediaType: "", state: "uploading", reference: null, error: null }]);
  setTimeout(() => {
    target.pendingAttachments[1]((current) => current.map((item) => item.id === id
      ? { ...item, size: 98_304, mediaType: "image/png", state: "ready", reference: "sha256:c0ffee" }
      : item));
  }, 600);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    /** 供 CDP/console 驱动的夹具入口。 */
    __stress: Record<string, unknown>;
  }
}

const bootStart = performance.now();
const navigatePreview = (next: "messages" | "tools" | "team" | "oauth" | "settings"): void => {
  setCurrentView(next);
  if (next === "settings") void reloadSettings();
  if (next === "messages" && previewView === "settings") void store.loadBootstrap();
};
// 与 App 同位:全局右键菜单(编辑类动作)。visual-capture 的菜单回归场景依赖这条监听。
window.addEventListener("contextmenu", (event: MouseEvent) => {
  const menu = buildContextMenu(event);
  if (menu == null) return;
  event.preventDefault();
  openContextMenu(menu);
});
// 与 App 同位:壳层 ⋯ 菜单(spec §5.5 阶段1)。夹具里动作是占位的,只验菜单壳。
const openShellMenuPreview = (anchor: HTMLElement): void => {
  const rect = anchor.getBoundingClientRect();
  openContextMenu({
    x: rect.right - 220,
    y: rect.bottom + 6,
    items: [
      { kind: "action", label: "选择新会话默认模型…", hint: "Ctrl+Shift+M", onSelect: () => {} },
      { kind: "action", label: "更改当前会话模型…", onSelect: () => {} },
      { kind: "separator" },
      { kind: "action", label: "设置…", hint: "Ctrl+,", onSelect: () => navigatePreview("settings") },
      { kind: "action", label: "关于 QAQ-Harness", onSelect: () => navigatePreview("settings") },
      { kind: "separator" },
      { kind: "action", label: "退出…", hint: "Ctrl+Q", onSelect: () => {} },
    ],
  });
};
// 复刻 App 的标题栏、全局导航、顶部 session tabs 与消息／工具内容区。
render(
  () => (
    <div id="app" class={{ "sidebar-collapsed": sidebarCollapsed() }}
      style={{ "--sidebar-width": fixtureCols() > 1 && fixtureSidebarWidth() != null ? `${fixtureSidebarWidth()}px` : undefined }}>
      <header id="top" role="banner">
        <div class="topbar-left">
          <button type="button" class="titlebar-menu" aria-label={sidebarCollapsed() ? "展开侧栏" : "收起侧栏"} aria-expanded={sidebarCollapsed() ? "false" : "true"} aria-controls="app-sidebar" title={sidebarCollapsed() ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((v) => !v)}>
            <IconMenu />
          </button>
          <Show when={currentView() !== "messages"}>
            <button type="button" class="titlebar-back" aria-label="返回消息" title="返回消息" onClick={() => navigatePreview("messages")}>
              <IconArrowLeft />
            </button>
          </Show>
          <span class="titlebar-brand">QAQH</span>
        </div>
        <div class="topbar-center">
          <span class="titlebar-session-title">{currentView() === "settings" ? "设置" : currentView() === "tools" ? "工具" : currentView() === "oauth" ? "接入" : "新会话"}</span>
        </div>
        <div class="topbar-right">
          <button type="button" class="titlebar-menu titlebar-more" aria-label="更多应用菜单" aria-haspopup="menu" title="更多应用菜单" onClick={(e) => openShellMenuPreview(e.currentTarget)}>
            <IconMoreHorizontal />
          </button>
        </div>
      </header>
      <Sidebar
        section={currentView()}
        onNavigate={navigatePreview}
        settingsSection={previewSettingsSection()}
        onSettingsSection={(id) => { setPreviewSettingsSection(id); setPreviewSettingsNonce((value) => value + 1); }}
        collapsed={sidebarCollapsed()}
        drawer={fixtureCols() === 1}
        drawerOpen={fixtureCols() === 1 && sidebarDrawerPreview}
        width={fixtureSidebarWidth()}
        onWidthCommit={commitFixtureSidebarWidth}
        sessions={previewSessions}
        workspaces={previewWorkspaces}
        activeSeed={previewActiveSeed()}
        onSelect={setPreviewActiveSeed}
        /* 「+」两颗在夹具里是空动作:视觉评审要看的是它们**在不在、位置对不对、
           禁用态长什么样**,真正的落点由 tests/workspace-*.test.ts 断言。 */
        onCreate={() => {}}
        onCreateIn={() => {}}
      />
      <div class={currentView() === "settings" ? "workspace workspace-settings" : "workspace"}>
        <Show when={currentView() === "settings"} fallback={
          <>
        <div class="workspace-content">
        {/* Future Goal capsule; no session tabs in the current shell.
        <div class="session-tabs-region">
          <TabBar tabs={fixtureTabs} activeId={previewActiveTab().id} creating={false} canCreate={false} onSelect={(id) => { const selected = fixtureTabs.find((item) => item.id === id); if (selected) setPreviewActiveSeed(selected.seed); }} onClose={() => {}} onCreate={() => {}} />
        </div>
        */}
        <main id="main">
          <Show when={currentView() === "tools"}>
            <ToolsPage />
            {/* Keep the shared stress metrics target available in this shell-only fixture. */}
            <div id="messages" hidden />
          </Show>
          <Show when={currentView() === "team"}><TeamPage /></Show>
          <Show when={currentView() === "oauth"}><OAuthPage onOpenSettings={() => navigatePreview("settings")} /></Show>
          <Show when={startupMode()}>
            {/* 真·启动页:hero/配置条/建议卡/共用 Composer 全在组件里,夹具只负责
                把 tabs/store 的信号喂好(工作区目录、粘性目标、暂存附件)。 */}
            <div class="session-column" role="region" aria-label="启动页">
              <StartupView onManageProfiles={() => navigatePreview("settings")} />
            </div>
          </Show>
          <Show when={currentView() === "messages" && !startupMode()}>
            <div class="session-column" id={`panel-${previewActiveTab().id}`} role="region" aria-label="当前会话">
              <SessionView tab={previewActiveTab()} />
              <Show when={previewActiveTab().store.pending[0]().length > 0}>
                <ApprovalStack pending={previewActiveTab().store.pending[0]()} respond={async () => { previewActiveTab().store.pending[1]([]); }} refresh={async () => { previewActiveTab().store.pending[1]([]); }} />
              </Show>
              {/* 与 App 同位:抽屉是全局单例,不挂在消息列里,否则测不到它的物理卸载。 */}
              <DiffReviewDrawer />
              <Composer
                draft={draft}
                onDraft={setDraft}
                blocked={() => null}
                running={() => false}
                onSend={() => { setDraft(""); }}
                onStop={() => {}}
                focusToken={0}
                metrics={() => fixtureMetrics}
                onPickAttachments={simulateAttach}
                onScreenshot={simulateScreenshot}
                attachments={() => previewActiveTab().store.pendingAttachments[0]()}
                onRemoveAttachment={(id) => previewActiveTab().store.removeAttachment(id)}
                profileView={fixtureProfileView}
                onSelection={(_provider, model) => setPreviewProfile(model)}
                workspaces={() => previewWorkspaces}
                workspacePath={fixtureWorkspacePath}
                onWorkspace={setFixtureWorkspacePath}
                onCreateInWorkspace={setFixtureWorkspacePath}
                onBrowseWorkspace={() => {}}
                sessionWorkspace={() => "qaqh"}
                lanActive={() => false}
              />
            </div>
          </Show>
        </main>
        </div>
          </>
        }>
          <SettingsView initialSection={previewSettingsSection()} sectionNonce={previewSettingsNonce()} onSectionChange={setPreviewSettingsSection} showSectionPicker={fixtureCols() === 1 || sidebarCollapsed()} />
        </Show>
      </div>
      {/* 与 App 同位(spec §6.3):任务右栏 ≥1280 为第三列,<1280 抽屉按参数预设。 */}
      <Show when={currentView() === "messages" && !startupMode()}>
        <WorkspacePanel store={previewActiveTab().store} drawer={fixtureCols() < 3} drawerOpen={railDrawerPreview} />
      </Show>
      <ContextMenuHost />
    </div>
  ),
  document.getElementById("root") as HTMLElement,
);

{
  const appEl = document.getElementById("app");
  if (appEl != null) observeShellCols(appEl, { onChange: (cols) => setFixtureCols(cols) });
}

if (document.getElementById("messages") != null) churnReset();
void (async () => {
  // 接入页没有消息树，不能启动消息压力夹具的 observer、resnapshot 与 metrics。
  if (previewView === "oauth") return;
  if (previewView === "settings") {
    await reloadSettings();
    // 视觉验收要拍到控制台本身,而不是只拍到「关于」里那个后门入口。
    if (previewParams.get("dev") === "1") openDevConsole();
    return;
  }
  if (previewView === "startup") {
    /* 启动页不发消息树泵:把真 tabs/store 的三件输入态喂好——注册目录(菜单
       要有的选)、粘性目标(按钮上显示的就是发送将用的 cwd)、暂存附件
       (PendingAttachment chip 在启动页 Composer 里的真实呈现)。 */
    void refreshWorkspaces();
    setNewSessionCwd("E:/fixtures/demo-repo");
    stageStartupAttachments(["E:/fixtures/demo-repo/docs/visual-fixture.md"]);
    return;
  }
  // tools 视图:把夹具 workspace.list 灌进 tabs store 的注册表信号,
  // ToolsPage 的 skills 扫描才看得到演示工作区。
  if (previewView === "tools") {
    await pollSessions();
    // 展开一条 skill:截图要拍得到卡片的展开态(正文 + 路径),否则这一层视觉
    // 只能靠 DOM 断言,评审看不到实际排版。
    for (let attempt = 0; attempt < 60; attempt++) {
      const head = document.querySelector<HTMLElement>(".skill-card-head");
      if (head != null) {
        head.click();
        break;
      }
      await frames(1);
    }
  }
  await store.loadBootstrap();
  if (previewView === "approval") store.todos[1]([]);
  previewActiveTab().store.pendingAttachments[1](fixtureAttachments());
  await frames(2);
  const mountMs = Math.round(performance.now() - bootStart);
  await frames(30);
  report.push({ name: "boot", mountMs, bootChurn: { added: churnAdded, removed: churnRemoved }, ...metrics() });
})();

window.__stress = {
  store,
  metrics,
  report,
  scenarios,
  churnReset,
  retainedChars,
  resetRequests: () => {
    pageRequests = [];
  },
};
