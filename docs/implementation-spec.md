# qaqh-electron 实现规格书（Implementation Spec）

> 版本 v1 · 2026-09-09 · 供实现方（人或模型）零上下文执行
> 交叉验证人：原设计方。实现完成后按 §14 清单逐条核验。
> 关联文档：`docs/ui-design.md`（视觉与布局定稿）、`qaqh-js-sdk/README.md`（SDK 用法）、
> `QAQ-Harness/docs/frontend-contract.md`（协议契约）、`docs/webui-development-standard.md`（§5 SSE/§6 SDK 分层/§7 自检）

---

## 0. 元指令（先读）

1. **真源优先级**：本 spec > `ui-design.md` > SDK 导出的 TS 类型 > 后端文档。
   协议字段**只准**从 `qaqh-js-sdk/src/protocol/bindings/` 导入的类型取用，禁止手写。
2. **SDK 是唯一协议实现**：renderer 不直接写 fetch/URL/SSE 循环，一切经 `QaqhClient`。
   若 SDK 缺能力，先在 spec 的"缺口清单"登记再讨论，不得绕过。
3. **红线（违反即打回）**：
   - token 仅内存流转（main→preload→renderer 各一层），禁入 localStorage/磁盘/日志；
   - renderer 与 UI 永不调用 `/control/v1/stop*`（仅 main 在退出链调用 stop-if-idle）；
   - SSE 只用 fetch+ReadableStream（SDK 已实现），禁 `EventSource`；
   - Solid 2 禁 React/Solid1.x 模式（无 `useState`/`useEffect`/单函数 `createEffect`/
     `<Index>`/`solid-js/web` 导入/props 解构/响应式作用域内写信号）——以
     solidjs-v2 技能 cheatsheet 为准，所有 import 来自 `solid-js` 与 `@solidjs/web`；
   - 禁用 index 作 React-like key：turn 用 `turnId`、block 用 `block_order`、tab 用 `seed`。
4. **不确定就查类型**：`node_modules/qaqh-js-sdk/dist/*.d.ts` 与 `bindings/qaqh/*.ts`
   优先于任何文档描述（预发布期文档会漂移）。

## 1. 技术栈与版本（2026-09-09 核实，勿擅自升级大版本）

| 包 | 版本 | 备注 |
|---|---|---|
| electron | `44.2.0` | |
| vite | `^8.0.10` | Rolldown 内核 |
| vite-plugin-electron | `1.1.2` | peer `vite>=6`；承担 main/preload 构建与 electron 拉起 |
| solid-js | `2.0.0-rc.6`（dist-tag `next`） | |
| @solidjs/web | `next`（2.0.0-rc.x） | JSX 类型与 render 入口所在 |
| @solidjs/vite-plugin | `next`（3.0.0-next.x） | **不是** vite-plugin-solid（那是 1.x 时代） |
| typescript | `7.0.2`；若 RC 类型报错回退 `~5.9.3` | TS6/7 必须显式 `verbatimModuleSyntax` |
| vitest | latest | 单测 |
| qaqh-js-sdk | `file:../qaqh-js-sdk`（0.1.0，双入口 `.`/`./node`） | 发布前本地 file 依赖 |

**明确不用**：electron-vite（peer 只到 vite ^7）、react、zustand、tailwind（本壳用
手写 CSS 令牌，见 §10）。

## 2. 仓库布局

```
qaqh-electron/
├─ package.json            # type: module, main: out/main/index.js
├─ tsconfig.json           # renderer: jsx preserve, jsxImportSource "@solidjs/web",
│                          #   module esnext, moduleResolution bundler, verbatimModuleSyntax
├─ tsconfig.node.json      # main/preload: module nodenext（供 vite-plugin-electron 用 esbuild）
├─ vite.config.ts          # solidPlugin(renderer) + electron([main, preload])
├─ electron/
│  ├─ main/index.ts        # app 生命周期、窗口、IPC 注册
│  ├─ main/daemon.ts       # DaemonManager（发现/拉起/退出链）
│  └─ preload/index.ts     # contextBridge，唯一 bridge 文件
├─ src/
│  ├─ index.tsx            # import { render } from "@solidjs/web"; render(() => <App/>, #root)
│  ├─ App.tsx              # 五区布局骨架 + 连接门控（未连接→Connecting 屏）
│  ├─ lib/bridge.ts        # window.qaqh 的类型化访问器（§5）
│  ├─ lib/client.ts        # createClient(): QaqhClient 单例 + 事件接线（§7）
│  ├─ state/connection.ts  # 连接状态 store（ConnState/ConnInfo/epoch）
│  ├─ state/tabs.ts        # TabsStore：seed-keyed 标签容器（§6.2）
│  ├─ state/session.ts     # Projection→Solid 桥（§6.3）
│  ├─ ui/TabStrip.tsx      # 含窗口控制钮与拖拽区
│  ├─ ui/ContextBar.tsx
│  ├─ ui/Transcript.tsx    # TurnNode/RoundBlock/BlockView 内部子组件
│  ├─ ui/blocks/{MarkdownText,ReasoningPanel,ToolCard,NoticeBar}.tsx
│  ├─ ui/Inspector.tsx     # 工具/diff/事件 三页签
│  ├─ ui/Composer.tsx      # 输入 + plan/code 分段 + 附件
│  ├─ ui/ApprovalCard.tsx  # 120s 倒计时审批卡
│  ├─ ui/AskCard.tsx       # AskQuestion 内联问卷
│  ├─ ui/PlanReviewCard.tsx
│  ├─ ui/StatusLine.tsx
│  └─ ui/CommandPalette.tsx # ⌘K：会话搜索/跳转/归档/新建
├─ styles/tokens.css       # §10 令牌
└─ docs/{ui-design.md, implementation-spec.md}
```

构建产物：`out/main`、`out/preload`、`out/renderer`（**必须**是 `out/renderer`，
daemon `/debug/` 静态托管按此路径定位，双形态复用同一产物）。

## 3. 进程模型与安全边界

| 进程 | 职责 | 禁止 |
|---|---|---|
| main | daemon 发现/拉起/退出链；BrowserWindow；IPC；文件对话框；外链打开 | 持有 token 之外的任何协议逻辑 |
| preload | `contextBridge.exposeInMainWorld('qaqh', …)` 单一桥；内存转发 token | `require` 透传、`ipcRenderer` 裸露 |
| renderer | QaqhClient + 全部 UI | Node/Electron API；localStorage 存 token |

窗口参数：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、
`titleBarStyle: 'hidden'`（Windows 另开 `titleBarOverlay`）、Windows `backgroundMaterial: 'mica'`、
macOS `vibrancy: 'sidebar'`、`webPreferences.preload: out/preload/index.js`。
CSP（index.html meta）：`default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`。
会话 label 与持久化 cookie 一律不需要。`will-navigate` 与 `setWindowOpenHandler` 全部拦截，
外链走 `qaqh.openExternal`（main 侧校验 `https?:` 前缀后 `shell.openExternal`）。

## 4. main 进程

### 4.1 DaemonManager 状态机

```
idle → adopting(读 discovery) → ready(adopted|spawned) → exited
       ↘ spawning(ensureDaemon) ↗
```

- 启动（app ready 后、窗口加载前执行一次）：
  1. `readDiscovery()`（SDK `qaqh-js-sdk/node`）命中且 `isPidAlive(pid)` → **adopted**，
     记录 `spawnedByUs=false`；
  2. 否则 `ensureDaemon({ binPath, timeoutMs: 20000 })` → **spawned**，`spawnedByUs=true`。
- `binPath` 解析顺序：`process.env.QAQH_DAEMON_BIN` → `app.isPackaged ?
  path.join(process.resourcesPath, 'bin/qaqh-daemon') : <repo 约定的 target/release 路径>` →
  PATH 上 `qaqh-daemon`（`which` 探测）。三者皆无 → 向 renderer 发 `daemon:missing`
  （UI 显示引导屏：找不到 daemon 二进制，请填写路径或先启动 daemon）。
- **退出链**（`app 'before-quit'`，仅 `spawnedByUs===true` 时）：
  `stopDaemonIfIdle(discovery, 5000)`；`'busy'` → 直接放行退出（daemon 归属其他客户端，
  留它活着）。adopted 实例退出时**什么都不做**。
- daemon 进程意外退出（spawned 时监听 `child exit` 不适用——ensureDaemon 已 unref；
  改为轮询 discovery pid，10s 间隔）：发现 pid 死亡 → webContents.send(`qaqh:daemonDied`)。
- discovery 文件 mtime 变化且 `server_epoch`/endpoint 变化 → webContents.send(`qaqh:configChanged`)。

### 4.2 IPC 表（`ipcMain.handle`，channel 前缀 `qaqh:`）

| channel | 请求 | 响应 | 说明 |
|---|---|---|---|
| `qaqh:getConnectionConfig` | void | `{endpoint, token, clientInstanceId, adopted: boolean}` | 首次调用时完成 daemon 确保并缓存；`clientInstanceId` 存 `app.getPath('userData')/instance-id`（首次 UUID v4，稳定复用——**唯一允许落盘的标识**，非秘密） |
| `qaqh:daemonStatus` | void | `{running, pid?, spawnedByUs}` | |
| `qaqh:pickAttachments` | `{multiple: boolean}` | `{name, mime, bytes: ArrayBuffer}[]` | `dialog.showOpenDialog` + `fs.readFile`；上限 20MB/个、10 个 |
| `qaqh:openExternal` | `{url}` | void | 仅 `http(s):` |
| `qaqh:win` | `'min'\|'max'\|'close'` | void | frameless 窗口控制 |
| （send 主动推送）`qaqh:daemonDied` / `qaqh:configChanged` | — | `{}` | 见 4.1 |

## 5. preload 契约（唯一桥面）

```ts
export interface QaqhBridge {
  getConnectionConfig(): Promise<{
    endpoint: string; token: string; clientInstanceId: string; adopted: boolean;
  }>;
  daemonStatus(): Promise<{ running: boolean; pid?: number; spawnedByUs: boolean }>;
  pickAttachments(o: { multiple: boolean }): Promise<
    { name: string; mime: string; bytes: ArrayBuffer }[]
  >;
  openExternal(url: string): Promise<void>;
  win(action: 'min' | 'max' | 'close'): Promise<void>;
  onDaemonDied(cb: () => void): () => void;      // 返回退订函数
  onConfigChanged(cb: () => void): () => void;
}
declare global { interface Window { qaqh: QaqhBridge } }
```

实现规则：全部经 `ipcRenderer.invoke`；事件订阅用 `ipcRenderer.on` 包装并返回退订；
**禁止**把 `ipcRenderer`、`process`、`Buffer`、路径等暴露进 bridge。

## 6. renderer 状态架构与接线

### 6.1 连接单例（`lib/client.ts`）

```ts
// 启动序列（App onSettled 内，或顶层 createRoot 一次）：
const cfg = await window.qaqh.getConnectionConfig();
const provider = staticProvider({ endpoint: cfg.endpoint, token: cfg.token });
const client = await QaqhClient.connect({
  provider,
  clientInstanceId: cfg.clientInstanceId,
  onBatch:  (b) => dispatchBatch(b),   // §6.4
  onReset:  (s) => handleReset(s),     // §7
  onState:  (st, info) => connectionStore.set(st, info),
  onParseError: (e, ch, raw) => console.warn('[ringing] parse', ch, e, raw.slice(0, 200)),
});
```

`staticProvider` 从 SDK 导入（`client.providers.staticProvider` 亦可）。
`window.qaqh.onDaemonDied` → connectionStore 标记 `daemonDead`，StatusLine 变红、
所有 tab 点转空心；`onConfigChanged` → 触发 epoch 全量恢复（§7）。

### 6.2 TabsStore（`state/tabs.ts`）

```ts
interface TabItem {
  seed: string;                 // 唯一 key，永不用 index
  title: string;                // meta.title ?? last_summary ?? '未命名会话'
  subtitle: string;             // cwd basename
  activity: 'starting'|'idle'|'working'|'waiting_user'|'disconnected'|null;
  pendingCount: number;         // pendingPermissions + pending ask 数
  streaming: boolean;           // 近 2s 内有 text_delta（时间窗判定，非状态字段）
  attached: boolean;            // 已对本 lease attach（可读 timeline）
  hydrated: boolean;            // 已完成 bootstrap+timeline 全量装载
  archived: boolean;
}
// createStore<{ order: string[]; bySeed: Record<string, TabItem>; activeSeed: string | null }>
```

- 列表来源：`client.service('session.list')`（返回富元数据数组，字段见 bindings
  `SessionSummary*`，含 `running`/`workspace_id`）。过滤：`archived===false` 且
  非 ephemeral。此后靠 control 频道 `session_state_changed` / `session_meta_changed`
  / `session_activity_changed` 增量维护（meta_changed 只带 title，其余变化重拉 list）。
- **新建会话**（WinUI3 D2 教训的 Electron 版）：点 `+` → 先置 `pendingNewSession=true`
  → `client.sendCommand('control', {channel:'control', type:'session_create', close_current:false})`
  → 收到 control 批次里 `session.created`（或 service 轮询兜底，15s 超时提示失败）→
  activeSeed := 新 seed、清标记。禁止"轮询 list 差集猜新 seed"。
- **选中**：所有回调链路传 seed 本身（key 化），任何地方不得出现 `order[index]` 反查。
- 激活 tab（`setActive(seed)`）：`ensureAttached(seed)` → 若 `!hydrated` 执行 §6.5
  装载序列。attach 用 `client.attachSession(seed)`（control `session_resume`），
  401 `lease_required` 前必须先 attach——**包括刚 create 的会话**。

### 6.3 Projection→Solid 桥（`state/session.ts`）

SDK `Projection` 是 subscribe/getSnapshot（revision 递增）的外部存储。桥接：

```ts
const projection = new Projection();
const [snap, setSnap] = createStore<{ rev: number }>({ rev: 0 });
projection.subscribe(() => setSnap({ rev: projection.getSnapshot().revision }));
// 组件内细粒度取值（Solid2：读在 JSX/memo 里，禁组件体顶层裸读）：
const session = createMemo(() => { snap.rev(); return projection.getSnapshot().sessions.get(seed()); });
```

每次 `applyBatch`/`hydrate*` 后 projection 只 touch 一次 revision；组件用 memo 按
`session()` 下钻（turns 按块渲染，Solid 细粒度使全量 memo 调用廉价——不要自行再拆
store 镜像，避免双份真相）。`SessionView` 字段（turns/tools/pendingPermissions/
notices/activity/sessionState）以 SDK d.ts 为准，见 §9 各组件消费点。

### 6.4 事件分发器（`dispatchBatch`）

```ts
function dispatchBatch(batch: RingingEventBatch): void {
  const seeds = new Set(batch.envelopes.map(e => e.seed).filter(Boolean));
  for (const s of seeds) tabsStore.ensureTracked(s);   // 未知 seed → 建懒 tab（未激活不装载）
  projection.applyBatch(batch);                         // 内部按 env.seed 路由
  tabsStore.refreshActivityFrom(projection);            // activity/pendingCount 汇总
}
```

铁律：整 batch 传递（SDK 已保证），不得拆散丢失 batch 上下文；`stream_seq` 跳号
检测由 client 内置（跳号 → client 自行发 reset 信号），UI 不重复实现。

### 6.5 装载序列（tab 激活时，一次）

```
ensureAttached(seed)                       // attachSession；失败→tab 空心+重试钮
→ client.bootstrap(seed)                   // RingingSessionBootstrap（三频道快照+基线 seq）
→ projection.hydrateBootstrap(seed)
→ client.timelineSnapshot(seed, {})        // TimelinePage{snapshot:{watermark,turns}, has_more}
→ projection.hydrateTimeline(seed, page.snapshot)
→ client.subscribeTimeline(seed, msg => applyTimelineMessage(msg))  // 增量轮次流
向上翻页（滚动到顶）：timelineSnapshot(seed, { beforeTurn: 最旧 turnId }) → hydrate 合并
```

`applyTimelineMessage` 的 payload 解析**以 bindings 的 timeline 事件类型为准**
（若与三频道 batch 结构不同，按实际类型写适配函数，禁猜字段）。

## 7. 重置与恢复矩阵

| 信号 | 来源 | 动作 |
|---|---|---|
| `ResetSignal{scope:'channel', channel, seed}` | SSE `ringing.reset_required` 帧 | 仅该 tab 该频道：re-attach → `bootstrap` → 对应投影重建；UI 不闪全局 loading |
| `ResetSignal{scope:'epoch'}` 或 `ConnState==='reconnecting'` 后 info.serverEpoch 变化 | client 自动 re-open | 全量：清 projection、全部 tab `hydrated=false`、重放激活 tab 装载序列、StatusLine 提示"会话已恢复" |
| `ConnState` 断开/重连中 | onState | tab 点转空心；恢复后自动回填；失败 3 次 → StatusLine 常红 + 重试按钮 |
| `qaqh:daemonDied` | main | 同上 + "daemon 已退出"横幅；spawnedByUs 时提供"重新拉起"按钮（调 `qaqh:getConnectionConfig` 重走启动序列） |
| 审批超时（UI 侧 120s 到点） | 本地计时 | 卡片转灰"已过期"，标签徽标 -1；与服务端 Expired 双向幂等（迟到的 respond 会得到 Rejected/Expired 错误，静默吞） |

## 8. 命令流（全部经 `client.sendCommand(channel, command, {seed})`）

ack 只有 accepted/rejected；业务终态以对应事件为准——**命令发出后 UI 一律等事件驱
动渲染，不得本地造终态**。502/504 换 id 重试一次由 SDK 内置。

| UI 动作 | channel | command | 后续事件（驱动 UI） |
|---|---|---|---|
| 发消息 | conversation | `{type:'conversation_send_message', text, images:[], attachments:ContentRef[]}` | `turn_opened→…→turn_sealed` |
| 停止 | conversation | `{type:'conversation_cancel'}` | turn state→cancelled |
| 撤销回合 | conversation | `{type:'conversation_undo_turn'}` | timeline 重建事件 |
| 切 plan/code | conversation | `{type:'conversation_set_mode', mode}` | meta 变化 |
| 压缩 | conversation | `{type:'conversation_compact'}` | `compact_started/progress/finished`（进度条进 ContextBar） |
| 审批 | tool | `{type:'tool_permission_respond', call_id, approved, trust_folder}` | `pendingPermissions` 移除 |
| 新会话 | control | `{type:'session_create', close_current:false}` | `session.created` |
| 归档/关闭 | control | `{type:'session_archive'/'session_close', seed}` | `session_state_changed` |

附件上传：`qaqh.pickAttachments` → 每个文件 `new Blob([bytes], {type: mime})` →
`client.uploadContent(seed, blob, mime, name)` 得 `ContentRef` → 进 composer 的附件
chips → 随 send_message 发出。**命令里禁传本地路径**。
文本输入本地状态：Solid `createSignal`，Enter 发送 / Shift+Enter 换行；发送后清空。

## 9. UI 组件规格（行为级）

**TabStrip**：高 36px；拖拽区（`-webkit-app-region: drag`，tab 与按钮 `no-drag`）；
活动 tab 顶部 2px 强调线；右键菜单：归档/复制 seed/关闭；`+`/⌘T 新建；Ctrl+Tab 轮转；
tab 宽度自适应 max 180px、title 单行截断。窗口控制钮（min/max/close）在最右。
状态视觉见 ui-design §3（绿点呼吸/琥珀徽标/青点/空心/灰底）。

**ContextBar**：24px；`cwd 基名 ▸ 子路径`、mode（plan/code，点击即发 set_mode）、
model 名、compact 进度（运行中显示 %）。数据源：session.list 元数据 + conversation
频道 compact 事件。仅渲染 activeSeed 的数据。

**Transcript**：左轨线 24px（turn 圆点：实心=sealed 正常态、空心绿=running、红=failed、
灰=cancelled）；用户消息全宽无气泡；round 折叠容器（默认展开最后一轮）；
**block 渲染分派**：`reasoning`→ReasoningPanel（折叠，摘要"思考 N.Ns"）、`text`→
MarkdownText、`tool`→ToolCard（横卡：`name · summary`，展开= args JSON 高亮 +
output 终端块 + diff 视图；四态徽标 prepared/running/succeeded/failed，
`backgrounded` 结果常驻指示）、`notice`→NoticeBar。
**双渲染规则**：block `state==='open'` 时纯文本流式追加（pre-wrap，无 markdown 解析）；
`sealed` 后切换 markdown 渲染 + 代码高亮。滚动跟随：距底 <80px 才自动跟随，100ms 节流。

**MarkdownText**：仅 sealed 内容；代码块带语言标签与复制钮；链接走 `qaqh.openExternal`。
实现选型：自写轻量渲染器或 `marked`+`sanitize`/`dompurify`（禁 `innerHTML` 裸插），
M1 可先支持标题/列表/代码/行内/引用/表格七类。

**Inspector**：240px 右抽屉，⌘I 呼出，默认收合；三页签 工具（ToolCallView 流，
按 turnId 分组）/ diff（会话累计 `code_changed` 汇总 + 每工具 diff 查看）/ 事件
（原始 batch 的 JSON 视图，调试用，可暂停滚动）。

**Composer**：min 56px，自动增高至 160px；plan/code 分段（发 set_mode，非本地态）；
附件 chips（上传中/失败态）；disabled 条件：daemonDead || activity==='working' 时
主按钮变"停止"（发 cancel）。占位文案与快捷键提示见 ui-design。

**ApprovalCard**：浮出于 composer 上方，一次只显最早一条（队列在 pendingPermissions）。
内容：risk 徽标（high→红 / medium→琥珀 / low→绿）、工具名 mono、reason、paths、
category chips、consequence、**倒计时环**（从 `created_at`/事件到达时刻起 120s，
最后 20s 变红）。三按钮：拒绝 / 允许一次 / 信任此目录（映射 approved×trust_folder）。
超时→卡片灰化"已过期"，10s 后自动移除。

**AskCard**：`interaction_requested`（AskQuestion{options, allow_custom}）单选组 +
可选自定义输入框 + 提交；batch ask 渲染为问卷组。

**PlanReviewCard**：plan_content 渲染（MarkdownText）+ TodoItem 清单 + 通过/驳回按钮。

**StatusLine**：20px mono；左：daemon 端点 · lease 剩余（由 `lease_ttl_ms` 与
renew 时刻推算）· epoch；右：`N tabs · M 等待用户`。断开态整条变红底。

**CommandPalette**：⌘K；数据源 session.list 全量（含 archived 分区）；支持
fuzzy（title/cwd/seed 前缀）；动作：切换会话/新建/归档/复制 seed；无侧栏，
此面板是历史会话唯一入口。

## 10. 视觉令牌（`styles/tokens.css` 精确值）

```css
:root {
  --bg: #ffffff; --bg-sunken: #f1efe8; --bg-hover: #f8f7f4;
  --text: #2c2c2a; --text-2: #5f5e5a; --text-3: #888780;
  --border: #d3d1c7; --border-strong: #b4b2a9;
  --accent: #0f6e56; --accent-strong: #085041; --accent-soft: #e1f5ee;
  --ok: #3b6d11; --warn: #ba7517; --warn-strong: #ef9f27;
  --danger: #a32d2d; --danger-soft: #fcebeb;
  --radius-ctl: 4px; --radius-card: 8px; --radius-shell: 12px;
  --font-ui: "MiSans VF", system-ui, "Segoe UI", sans-serif;
  --font-mono: "Cascadia Code", "JetBrains Mono", ui-monospace, monospace;
  --dur-fast: 120ms; --dur-slow: 220ms;   /* 仅淡入/上滑；流式文本无动画 */
}
```

暗色：跟随 `nativeTheme`，令牌整体翻转为深底浅字（M2 再做完整校验，M0/M1 先浅色）。
禁：AI 紫渐变、玻璃拟态、box-shadow 阴影堆叠、Inter 默认脸。

## 11. 错误与降级

| 情形 | UI 表现 | 恢复 |
|---|---|---|
| daemon 二进制缺失 | 引导屏（选路径/说明手动启动） | 选定后重走启动序列 |
| open 失败/超时 | Connecting 屏错误态 + 重试 | 指数退避由调用方控制 3 次 |
| lease 续租失败→re-open | 状态线琥珀"重连中" | SDK 自动；成功后 §7 epoch 路径 |
| 409 lease 冲突（他端抢占） | 状态线红色 + "会话在其他窗口打开" | 手动重试 |
| 命令 rejected | toast 显示错误 code/message | 无自动重试 |
| 发送网络失败 | 输入框内容保留 + 红边 | 用户重发（SDK 幂等 fingerprint 保序） |

## 12. 构建配置要点

`vite.config.ts`：`electron({ main: {entry: 'electron/main/index.ts'}, preload: {entry:
'electron/preload/index.ts'} })` + renderer 默认根；renderer 插件 `solidPlugin()`（来自
`@solidjs/vite-plugin`，默认 native compiler）。`build.outDir` 保持默认三目录
（electron 插件约定），renderer 产物落 `out/renderer`。package.json `main: out/main/index.js`，
scripts：`dev`（vite，插件自动拉 electron）、`build`、`typecheck`（tsc --noEmit 双 tsconfig）。
打包（M2）：electron-builder，`extraResources: bin/qaqh-daemon`（可选）；
产物布局须保证 `resources/out/renderer` 存在以兼容 daemon `/debug/` 托管回退路径。

## 13. 里程碑验收

- **M0 连接壳**：`npm run dev` 拉起窗口 → 自动发现/spawn daemon → open 成功 →
  StatusLine 绿；`session.list` 渲染为标签；⌘T 新建会话（事件驱动选中）；
  杀 daemon → 状态线红 + 全部空心；重启 daemon → 自动恢复。**零协议手写**（grep
  不到 `fetch('/ringing` 之类）。
- **M1 会话主环**：发消息→流式渲染（open 纯文本→sealed markdown 切换无抖动）；
  审批卡三按钮闭环 + 120s 过期；cancel；undo；附件上传往返；compact 进度；
  翻页 beforeTurn 正常合并。
- **M2 工作台**：Inspector 三页签、⌘K 面板、归档流转、暗色令牌、
  electron-builder 三平台打包、daemon `/debug/` 能加载同一份 `out/renderer`。

## 14. 交叉验证清单（验证人用，实现完成后逐条勾）

- [ ] `grep -rn "X-QAQH-Client-Session-Id\|/ringing/v1" src/ electron/` 仅出现在对
      SDK 常量的引用（理想为零处手写）
- [ ] token 不出现在任何写盘/日志/localStorage 代码路径
- [ ] 全仓库无 `EventSource`、无 `solid-js/web` 导入、无单函数 `createEffect`、
      无 `<Index>`、无 props 解构、无 `useState/useEffect`
- [ ] tab/turn/block 的 key 分别为 seed/turnId/block_order；无 index-key
- [ ] 选中/激活链路无 `order[index]` 式反查；新建会话走 `session.created` 事件路径
- [ ] 激活 tab 先 `attachSession` 再 `bootstrap/timeline`（对刚创建的会话同样成立）
- [ ] 审批卡倒计时 120s 与三按钮→`tool_permission_respond{approved,trust_folder}` 一一对应
- [ ] open 态 block 无 markdown 渲染；sealed 后才切 markdown
- [ ] `RingingResetRequired` 按 (channel, seed) 精准重建；server_epoch 变化全量重建；
      两者路径不同且有测试
- [ ] UI 代码零处调用 `/control/v1/stop*`；main 仅退出链调 `stopDaemonIfIdle` 且仅在
      `spawnedByUs` 时
- [ ] `out/renderer` 产物可被 daemon `/debug/` 直接托管并完成 open（双形态冒烟）
- [ ] 对真实 daemon 跑通：新建→发消息→流式→审批→归档→重启恢复 全链
