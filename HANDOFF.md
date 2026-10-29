# Electron 迁移交接

## 目标与工作原则

目标是让 Electron 桌面端达到接近原 Tauri 桌面端的功能，必要时修正原实现中不符合当前后端契约的行为。用户明确要求：**不要继续以 Tauri 实现做逐行审计；从 Git 历史识别功能需求，再使用 Electron 原生方式实现。不要派生 subagent。**

涉及仓库：
- 本仓：`qaqh-electron`，Electron 主进程、preload、打包。
- `../qaqh-desktop-app`：SolidJS renderer。其工作区保留大量迁移中的修改，原 `src-tauri/` 文件在工作区被删除，但仍可只读 `git show HEAD:src-tauri/src/...` 获取功能参考。不要恢复、覆盖或清理这些未提交修改。
- `../qaqh-sdk`：Ringing v2 TypeScript SDK，不是桌面宿主；原生窗口、截图等由 Electron 负责。
- `../qaqh-backend`：daemon 和服务契约。服务语义以现有后端实现及实际运行测试为准，不要将旧 Tauri 的限制直接当作正确契约。

本仓及其他仓库均存在既有未提交修改，不要重置、清理或擅自覆盖。完整构建脚本可能安装依赖、编译后端、覆盖构建产物并在成功时替换 release，执行前先了解 `scripts/build-all.mjs`。

## 本轮已完成（截至交接）

### 2026-10-29 BUG-2026-10-29-A timeline 流 journal_gap 1 秒重连死循环（用户实机反馈）

- **症状**：前后端一起重启后，「网络波动，正在重连（第 1 次，1 秒后）」横幅每秒弹出/消失一次，timeline 流无限重连；daemon 侧无任何 4xx（`[http]` 日志在抖动窗口为空）。
- **根因**（引入于 qaqh-backend `18a89dc` 2026-10-28 14:35 +0800，B1.3 失覆盖契约）：`handle_timeline_events` 对**空 cursor** 连接也执行 `replay 空 && after<watermark` 判据。daemon 重启后空闲历史会话的 journal 已被 `prune_sealed_timeline_journal` 裁空而 watermark 巨大（实机 watermark=114685）→ 每次建流几毫秒内即发 `journal_gap` 终止帧；TS SDK `watchTimeline` 的恢复契约是「清 Last-Event-ID 重连」，对本来就为空的 cursor 无任何增量，而每次 open 都把退避 attempt 归零 → 退避恒为 initialMs(1s)，闭环成秒级风暴；宿主双流合成状态随之 open↔reconnecting 每秒翻转，横幅跟着闪。实机探针（带 lease 直连 SSE）7ms 内复现终止帧，projection 流不受影响。`18a89dc` 自带单测恰好漏了 `(after=0, watermark>0, replay=0)` 用例。Rust client 走 `recover_gap` 快照重基线，不受影响。
- **修复**：
  - 后端（`qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/sse.rs`）：`timeline_replay_lost_coverage` 增加 `has_cursor`（Last-Event-ID 非空）前提——空 cursor 是「从 live 开始」，没有可丢失的位置，历史由 attach 的 timelinePage 首页 + projection bootstrap 覆盖、前端按 timeline_seq 幂等去重；带旧 cursor 的连接仍一次性 reset，重基线契约闭环。补回归单测 `fresh_connection_without_cursor_is_not_lost_coverage`。
  - SDK（`qaqh-sdk/src/core/index.ts` watchTimeline）：journal_gap 恢复加固——无 cursor 的 gap 没有恢复增量，连续 2 次即 paused（不再按 initialMs 无限重连），交由上层限频重建；有 cursor 的一次性重基线路径计数归零，行为不变。
- **验证**：qaqh-daemon `cargo test --bins` 全绿（含 2 个 sse 判据用例）；SDK `pnpm test` 39/39（新回归「误伤空 cursor → 暂停封顶」+ 既有「journal_gap 重基线不暂停」均通过）。
- **生效条件**：判据在服务端，**必须重建并重启 daemon 症状才消失**；壳经 `link:../qaqh-sdk` 构建打包，SDK 加固随下次壳构建生效。

### 2026-10-29 托盘图标消失修复(用户实机反馈)

- **根因**:新增的 `qaqh:relaunch` 用了 `app.exit(0)`——它**跳过 `before-quit`**,而 `tray.destroy()`(StatusNotifier 反注册)与 `client.destroy()` 都在那里(`index.ts` before-quit)。旧进程留下注册在已死 pid 上的僵尸托盘项,面板上新实例的图标被顶掉 → 托盘消失。全仓唯一一处绕过正常退出路径的调用,已改。
- **修复**(`index.ts`):relaunch = `app.relaunch()` → 显式 `tray.destroy()` → `app.quit()`(走 before-quit 完整清理)。已核查全仓再无 `app.exit` 调用。
- **遗留现场**:用户机上那个僵尸 StatusNotifier 项可能要等面板回收(通常随死进程 socket 关闭自清,必要时刷新面板/重登一次)。
- 验证:根 typecheck + 62/62。主进程改动需重启壳生效。

### 2026-10-29 壳 GPU 加速开关接入「渲染性能模式」(用户需求,复用既有档位)

- **约束**:GPU 禁用是命令行开关(`disable-3d-apis/disable-webgl/disable-webgl2`),只能在进程启动前生效——**不能运行时切换,改档须重启壳**。
- **实现**:
  - 主进程(`src/main/index.ts`):偏好存 `userData/shell-prefs.json`(`{gpuDisabled}`);缺省 = 禁用(历史行为不变),启动时按偏好决定是否追加禁用开关。纯内存约束(V8 堆 256MB/进程数/缓存)与开关解耦,恒定不动。新通道 `qaqh:gpu-pref-state/-set`、`qaqh:relaunch`(均 canControlWindow 守卫;daemon 是 detached 子进程,壳重启不影响)。
  - renderer(`lib/visual.ts`):档位是事实源——`isLowSpecActive()`(Performance/auto-低配→禁 GPU;Quality→启用)在 `setPerformanceMode` 与 GPU 探针落定(`noteGpuStatus`,auto 档结论依赖探针)两条路推给壳;`gpuRestartPending` 信号对比"本次启动 vs 下次启动"。
  - 设置页(`SettingsView.tsx`):渲染性能模式 hint 注明 GPU 联动;出现"GPU 偏好待生效"字段 + 「重启壳并生效」按钮(调 `qaqh:relaunch`)。
  - preload `gpuPref`/`relaunch`;`DesktopHostBridge` 加 `gpuPref?/relaunch?`(旧壳/纯浏览器可选,安全降级)。
- **auto 档自洽性**:GPU 禁用 → 探针报软渲染 → auto 解析为 low → 保持禁用,不抖动;Quality 在真硬 GPU 上稳定启用,在无驱动机器上会被 auto/探针拉回 low(一次重启收敛)。
- 验证:根 typecheck + 62/62;webui typecheck + 548/548;build 通过。实际启用 GPU 后的显存/稳定性影响未实测,默认档保持禁用。

### 2026-10-29 Diff 预览抽屉动画修复(实测驱动) + TopBar 任务面板主动展开钮(用户实机反馈)

- **抽屉"无动画"根因(实测)**:CSS 动画一直存在且在干净环境正常触发(CDP 探针 `animationstart` 都 fire),但壳为省内存禁了 3D/GPU(`src/main/index.ts` `--disable-3d-apis` 等)→ 动画走**软件光栅化**,而 `.diff-drawer-backdrop` 的 `backdrop-filter: blur(4px)` 每帧都要对整窗做 CPU 高斯模糊——**实测 320ms 重开窗口只画 6 帧、p95 帧间隔 100ms**,220ms 滑入只剩 3-4 个可见帧,观感即"闪现"。
- **修复**(`deliverables.css`):背板去掉 blur,改 55% 纯色 tint(软件渲染下无逐帧重算);时长接 motion-kit token(`--dur-drawer`,低配自动 0.1s)。**复测:14 帧、p95 33ms**,滑入满帧流畅。注意 performance.css 里 `.diff-drawer` 选择器与实际类名(`.diff-drawer-backdrop`)不匹配,属既有死规则,未动。
- **TopBar 任务面板主动展开钮**(用户提案,采纳):`rail-trigger` 全列态可见——cols<3 唤起抽屉(原行为),**cols≥3 直接开合 docked 右栏**。面板手动态提升到 App(`railManual`,localStorage `qaqh.rail.manual` 持久化,null=回自动),`WorkspacePanel` 加 `manualOpen/onManualToggle` 受控口(不传走内部信号,夹具兼容);按钮 `active` 态同步点亮(`.rail-trigger.active`),`aria-pressed` 表达 docked 开合。
- 验证:webui typecheck 通过;vitest **548/548**;build 通过。抽屉动画帧率数据来自一次性 CDP 探针(用完即删);真实观感待实机复验。

### 2026-10-29 消息引导线(turn-navigator)对齐参考设计语言(用户实机反馈)

- 两处跑偏:① tick 是 `flex: 1 1 3px`,几条消息也均匀撑满整条 320px 导轨(参考设计是 ~4px 紧凑堆叠);② 基态 mark 是 `width:3px; height:100%` 的**纵向长条**(参考是横向小短横)。
- 修复(`timeline.css`):tick 改 `flex: 0 1 6px; min-height: 3px` + 容器 `justify-content: center`——少时居中成紧凑一簇,多时均匀压缩(不设 gap,6px 格内 2px 刻度自然呼吸);基态 mark 6×2 横向短横,hover 9×2,active 14×3。无其他引用需要同步;build 通过,真实观感待实机复验。

### 2026-10-29 BUG-2026-10-29-B 消息堆积/卡顿下"后端已答完、前端不刷新" + 后台标签内存过载(用户实机反馈)

- **根因分析**(三条链叠加):
  1. 活跃会话的更新完全依赖 SSE 增量按 `timeline_seq` 严格续播:卡顿期 IPC 事件积压→缺口(`seq > known+1`)事件整批**丢弃**,全靠 2s 防抖 resnapshot 整窗重建(50 回合全量 diff)兜底→重建本身又加剧主线程饱和→更多缺口,恶性循环;若 `turn_sealed` 落在缺口里被丢,只剩投影流 `turn_finished` 的 forceSealTurn 兜底,而投影流自身也可能 paused(resync 3 次失败即 reportError 停摆)——此后前端再无任何对账。
  2. 非活动标签 store 的**全量转录常驻**:deactivate 只退订事件,turns 的文本/工具输出、fragments、审批/待办列表全部驻留,每开一个会话内存只增不减(宿主本就只给 active seed 建流,后台不推流——过载是前端自己攒的)。
  3. 宿主逐条 `webContents.send` 转发 timeline entry,高吞吐下渲染进程事件队列排队,UI 落后后端事实数十秒(本轮未改,见残留)。
- **修复(前端,`webui/src/session/store.ts`)**:
  - `deactivate()` 即**卸载转录**:`unloadForBackground()` 把 state 重置回 `emptySession()`(turns 嵌套 store 整体换血)、清 fragments/rAF/定时器/审批/待办/压缩态;只保留轻量生命周期(title/connection/activity/hasNewReply)。dispose 复用同一份 `releaseBuffers()`。
  - 新增 `hydrated` 信号:activate 置 false,权威快照(`timeline://snapshot`/`resnapshot`)到达置 true。**open 但未 hydrate 时 `applyTimelineStatus` 主动按后端分页口径补拉一次首页**——这是"卡顿丢事件后不再对账"的兜底。
  - 待授权/待回答等生命周期状态由 sessions 列表轮询(15s/窗口聚焦)驱动,后台标签不订阅流,符合"非视觉激活只收状态不收数据"。
- **切换会话加载态**(`SessionView.tsx` + `strings.ts` `syncingMessages` + `composer.css` `.sync-note`):未 hydrate 时渲染「消息同步中…」转圈条,替代空态闪烁;快照落地即被真实内容替换。
- 活跃会话的分页/窗口纪律不变:SNAPSHOT_LIMIT=50 首页 + `has_more`/`before_index` 上翻 + TURN_WINDOW=50 视口外淘汰(既有实现即"严格跟随后端分页")。
- 验证:webui typecheck 通过;vitest **543/543**(新增 `tests/background-unload.test.ts` 2 例:卸载即清 + 重激活 hydrate 生命周期、open 先于快照时的单次兜底补拉);`pnpm run build` 通过。
- **残留(主进程,未改)**:宿主对 timeline entry 逐条 IPC 转发。若实机复验仍见高吞吐卡顿,下一步在 `RingingClient.eventSender` 按 seed 做 50–100ms 合帧(`timeline://entries` 数组帧),preload 白名单与 `StreamHandlers` 相应加数组分支——注意 journal_gap/epoch 帧**不能**被合并吞掉语义。
- **风险提示**:后台标签的运行中回合不再实时积累转录,切回时以权威快照重建(快照只含最近 50 条,更早的走「上翻加载」)——这是设计内取舍,不是丢数据,daemon 落盘是全量的。

### 2026-10-29 zen 主题修正:双激活条/工具行双点 + 状态栏彗星(用户实机反馈)

- **双激活条**:zen 给选中会话行加了 `border-left 2px accent`,但基础主题 `.message-session-item.active::before` 的 3px 激活条仍在 → 一行两条。zen 里 `::before` 整体 `display:none`(pending 卡的 inset 语义条是独立元素,不受影响)。
- **工具行双点**:zen 给运行中的工具行在两处追加了 `●`(`.tool-elapsed::before` 与 `.text-shimmer[data-active]::after`)→ 一行两个点。两处都删:`[RUN]` 徽标(显式文本)、loader 图标与实时耗时承担运行态;`composer-live-dot` 也一并隐藏。
- **状态栏彗星(TUI comet tail,本主题唯一存活动画)**:`.composer-identity` 右端新增 `.composer-comet`(turn 运行中挂载,其他主题 `display:none`)——亮块领飞 + 2 个渐暗尾块,40px 轨道 2.4s 往返;调头点恰在 ease-in-out 拐点(速度为 0),用 `steps(1)` 把尾巴 `scaleX(-1)` 瞬时镜像,亮块永远朝运动方向且镜像不可见。纯 transform/opacity 合成器动画;低性能模式停为静态,reduced-motion 全局规则兜底。
- 验证:typecheck ✅、vitest 548/548 ✅。zen 主题观感(彗星节奏、调头镜像)待实机复验。

### 2026-10-29 侧栏拖拽调宽(用户侧需求):右缘把手 + 阈值等效收回

- 交互:侧栏右缘 5px 把手(`role="separator"`,dock 展开态可见,收起/抽屉态 CSS 隐藏);范围 [200,440]px;双击恢复默认 288;键盘 ←/→ ±16px(走轨道过渡,天然动画)、Home 回默认;宽度记忆 `localStorage["qaqh.app-sidebar.width"]`(`restoreSidebarWidth` 对脏数据回默认)。
- **阈值等效汉堡**:松手 < 224px(`SIDEBAR_COLLAPSE_BELOW`,刻意 > MIN=200,拖到最窄必收回不停"半开")→ `setSidebarCollapsed(true)`,48px 收拢动画由既有 220ms 轨道过渡播出(磁吸感);汉堡再展开恢复记忆宽度。
- **卡顿防线(motion kit)**:① 拖拽路径零框架参与——pointermove 不进 signal、不重渲染,rAF 合帧直写 `#app` 的 `--sidebar-width` 内联变量,唯一成本是浏览器 relayout(会话行全 ellipsis 文本);② 拖拽中 `html.sidebar-resizing` 关掉 #app/#top/标签/列表的全部过渡——220ms 过渡拖住光标才是橡皮筋感的来源,松手后恢复、snap 由既有轨道过渡接管;③ 拖拽不改变 #app 总宽,observeShellCols 的 ResizeObserver 不触发。
- 实现:`lib/sidebar-resize.ts` 纯逻辑(clamp/drag/阈值/restore,5 单测)+ `Sidebar.tsx` 指针接线(setPointerCapture,lostpointercapture 幂等兜底,onCleanup 清 class)+ App 持久化/收回判定 + `#app` 内联变量(cols>1 才写,防抽屉宽度被带偏)。
- 回归:新 capture 场景 `sidebar-resize-1280`(真实 CDP 鼠标拖拽:288→388 生效;拖到 218 阈值下 → 收回 48;汉堡展开 → 恢复 218),stress 夹具同位(无记忆)。全量 32 场景绿。
- 备注:第一版场景断言 188px 是我算错了——拖拽宽度先被 MIN=200 夹持(388−200→200),功能无误,断言改 −170/218。

### 2026-10-29 前端动效(motion kit):壳层收展/抽屉/折叠统一动画

- **kit 原则**:全部复用既有节奏 token(`--dur-fast 120/--dur 180/--dur-layout 220ms` + `--ease cubic-bezier(.2,0,0,1)`),新增 `--dur-drawer: 240ms`(覆盖层滑入滑出)。transform/opacity/grid-track 过渡,无逐帧 JS。
- **汉堡收展(288↔48)**:`#app`/`#top` 的 `grid-template-columns` 加轨道过渡(第三轨 `auto` 两端相等仍可插值;cols-N 换轨数离散瞬切,符合断点语义);导航标签 `display:none` → `max-width→0 + opacity→0`(height 钉 1.2em,图标不跳位);会话列表原地淡出,`visibility` 延迟到淡出播完(焦点/无障碍树同步离场)。
- **侧栏抽屉(cols=1)滑入滑出**:transform ±102% + `display` 走 `allow-discrete` 过渡 + `@starting-style`(Chromium 117+,Electron 45 OK)——退出动画播完才真正 `display:none`。**顺带修 bug**:旧规则 `#app.cols-1 .app-sidebar { display:none }` 以 ID 优先级压掉 `.drawer.open { display:grid }`,产线抽屉根本打不开(夹具没挂 cols-N,capture 一直没暴露);规则已删。
- **任务右栏抽屉(cols<3)**:同款滑入滑出;面板改为常驻挂载(`Show` 条件去掉 `(cols===3 || railDrawerOpen())`),新增 `drawerOpen` prop 驱动 `.open` class;`collapsed` class 只描述列态收窄,不与抽屉出画叠效果。
- **抽屉遮罩**:常驻 DOM,App 只切 `.open`;opacity 淡入淡出 + `visibility` 延迟,不再 Show 硬切。
- **侧栏工作区分组收展**:会话列表容器从 `<Show>` 硬切改走共用 `Collapse`(0fr↔1fr + opacity,播完卸载,卸载纪律保留);箭头旋转本来就有过渡。
- **任务面板列态收窄**:头部标题/箭头同样 `max-width→0` 退场(原来是 display:none);todo 卡片时间线入场加 4px 上浮淡入(`todo-card-in`,一次性)。
- **降级链**:`prefers-reduced-motion` 全局 .01ms 规则照旧覆盖;低性能模式把 `--dur-layout/--dur-drawer` 压到 0.1s;zen-console 主题把新过渡全部 `transition: none`。
- 验证:`pnpm --dir webui run typecheck`、vitest 全绿;`visual-capture.mjs` 全量 31 场景待跑(QAQH_EDGE)——注意 dock 推挤断言、`rail-drawer-1024`/`sidebar-drawer-640` 覆盖层断言语义未变。

### 2026-10-29 BUG-2026-10-29 重连横幅滞留(用户实机反馈)

- 症状:daemon 重启后,右下角「网络波动,正在重连」横幅一直挂着,直到用户发出首个请求才消失。
- 根因:渲染层 connection 只由宿主推的 `timeline://status` 事件驱动;重启窗口期发出的 open 事件可被错过,且宿主侧一条流 paused(如离线期 bootstrap 失败,SDK `watchSession` 初始 resync 失败即 paused,永不重试)后 combined 永不回 open——前端没有任何对账查询,状态就无限期卡在 reconnecting。发消息之所以"治好"它,是命令路径的 `ensureReady()`/turn 事件间接触发了宿主状态翻转。
- 修复(`webui/src/session/store.ts`):新增连接状态看门狗——非 connected 期间每 2.5s 调 `timeline_status`(宿主缓存,纯 IPC 无网络)对账一次,恢复 open 即自愈并停表;宿主回报 closed(wedged 流)时以 ≥10s 限频自动 `streams_retry` 重建双流。deactivate/dispose 停表。
- 顺带(`webui/src/app/App.tsx`):倒计时不再冻结在调度值——按 `conn://reconnect` 的 `at`+`delayMs` 与本机钟每秒老化(`types.ts` 注释本来就是这意图);心跳仅在 reconnecting 期间运转。
- 验证:webui typecheck 通过;vitest 541/541(新增 `tests/status-watchdog.test.ts` 2 例:错过 open 事件的自愈与 connected 后停表、closed 流限频自动重建);`pnpm run build` 通过。真实 daemon 重启场景待实机复验。
- 已知残留(SDK 层,未改):`@qaqh-sdk` watch 的 pump 重连循环直接用 `this.endpoint/credentials`,不查 `refreshCredentials`;daemon 重启若换端口/换 token 且 lease 恢复链失败一次,SSE 会停在 reconnecting 直至某次命令触发 client 级重连。前端看门狗的 closed 兜底覆盖了 paused 一支,这一支若实机复现,应修 SDK pump 的凭据刷新。

### 2026-10-28 壳层改造阶段 2+3（shell-layout-spec §11）

- 阶段 3：删除 64px `GlobalNav` 图标栏（组件已删，回退走 git 历史）；新增 `webui/src/app/Sidebar.tsx`（Nav 2×2 + 会话列表同列），`#app` 改 `var(--sidebar-width, 288px) + 1fr`；≤720px 侧栏降 160px，不再有底部导航第 3 行（`utilities.css` 旧规则按 §4.6 删除）。主题/性能/forced-colors/fluent 的选择器已同步到 `.app-sidebar`/`.sidebar-nav-item`。§8.6 命名：侧栏头「会话」。
- 阶段 2：`WorkspacePanel` 从 `.session-column` 第二列提升为 `#app` 第三列（`aside#right-rail`，spec §6.3），`.session-column` 拍平单列；`NARROW_RAIL_MAX` 改为量「`#app` 总宽 − 侧栏宽」——**不要**改成量 `#main`：右栏开合推挤 #main 会形成展开↔收起的反馈振荡（实测 transform/opacity 永动）。§8.6 命名：右栏改「任务」（`STR.workspacePanelTitle`）。
- 验证：`pnpm --dir webui run typecheck`、vitest 528/528、`visual-capture.mjs` 全量 31 场景（QAQH_EDGE=/usr/bin/microsoft-edge）几何断言与截图全绿。
- 侧栏汉堡收展：`#top` 左缘 `.titlebar-menu` 切换 `#app.sidebar-collapsed`（288px ↔ 48px 仅图标导航，会话列表隐藏），状态记忆在 `localStorage["qaqh.app-sidebar.collapsed"]`；<720px 的 160px 窄列同被收起规则覆盖。夹具 `stress.tsx` 同位（无记忆）。
- BUG-2026-10-28（用户反馈）：流输出时右键旧消息菜单被频繁刷掉。根因 `contextMenu.tsx` 的 `window scroll(capture) dismiss`——流式「跟随尾部」是程序化滚动，每次都触发。**修复：滚动不再关闭菜单**（菜单位于视口坐标，与原生菜单一致）；resize/blur/外点/Escape 仍关闭。回归场景 `context-menu-stream-scroll` 已进 `visual-capture.mjs`（stress 夹具补了与 App 同位的全局 contextmenu 接线 + ContextMenuHost）。
- 阶段 4（第一刀，隔离优先）：`src/main/index.ts` 窗口改 `titleBarStyle: hidden`（macOS `hiddenInset`）+ `titleBarOverlay`（WCO，color/symbolColor 深色初值、height 40 与 #top 同高）——**窗口控制由原生层绘制，renderer panic 后仍可关窗**；`autoHideMenuBar: true` 让「模型」菜单不再占一行（阶段1迁移完成前 Alt 仍可呼出，动作不丢）。renderer 侧 `#top` 成为全平台唯一拖拽区（不再 macOS-only）：drag 区显式 `no-drag` 所有按钮/输入，`user-select:none`，`env(titlebar-area-width)` 预留 WCO 安全区。
- BUG-2026-10-28（用户实机反馈三则）：① 汉堡飘到右上角——App.tsx 里按钮被放在 `#app` 与 `#top` 之间，成了壳 grid 的自动放置子项，启动页右栏缺席时掉进第 2 行第 3 列；**已挪进 `#top` 首位**（左上），教训：壳 grid 的直系子元素必须显式定位或放进 pane。② Composer 右键菜单英文（Undo/Cut/Paste）——主进程 `webContents context-menu` 的 role 文案跟随系统 locale（英文系统即英文）；**已显式中文 label**（撤销/重做/剪切/复制/粘贴/全选，role 保留行为与快捷键）。③ expanded 侧栏用户确认 OK。真实窗口的汉堡/WCO 拖拽仍待用户复验（主进程改动需重启壳）。
- 阶段4第二刀 + 阶段1菜单迁移（本轮后半）：① **WCO 配色跟随主题**——`qaqh:titlebar-overlay` 通道（main 侧 `canControlWindow` 守卫 + try/catch 静默降级），preload `windowControls.setTitleBarOverlay`，`theme.ts recompute()` 里随 `syncNativeBackdrop` 一起同步（dark #17181b/#edeef0，light #f7f7f8/#20242b，与 token 同源）。② **壳层 ⋯ 菜单**（App.tsx `openShellMenu`）：新会话默认模型/当前会话模型/设置/关于(跳设置 about 分区)/退出，复用 ContextMenuHost（定位/键盘/外点关闭免费）；退出确认抽成 `openQuitDialog()`（⋯、quit-requested 事件共用）；模型入口走既有 `modelPicker.open()`（preload 桥早已存在，spec §5.5 文档滞后）。夹具同位 + capture 场景 `shell-menu-light`（5 项完整性 + Escape 可关）。
- 阶段1完成：**application menu 已在 Linux/Windows `setApplicationMenu(null)`**（macOS 保留角色菜单）。`Ctrl+Shift+M`（新会话默认模型）/`Ctrl+Q`（退出确认）迁到 renderer `onKey`（App.tsx，置于设置浮层分支之前=全局动作），与 ⋯ 菜单 hint 同源；tray 菜单保留全部动作。
- **设置页 DevTools 开关**（用户需求）：`qaqh:devtools-toggle` 通道（canControlWindow 守卫，只暴露 toggle 返回开关态）→ preload `devtools.toggle()` → 「关于」页开发者模式区（连点版本串 5 次解锁）出现「打开/隐藏 DevTools」按钮；浏览器 dev 环境无壳时按钮隐藏并 toast 提示。
- **阶段4完成（垂直 chrome 收敛 2 行）**：`SessionHeader` 整体迁入 TopBar 中格（组件原样复用：双击重命名/⋯菜单/复制 ID 路径全保留；根元素 header→div，banner 归 `#top`）；`#session` 拍平为 `messages + 附属条` 两行；`--topbar-height: 48px`（token 化，WCO overlay height=48 同步）；`#top` 改 `grid: sidebar-width | 1fr | auto` 三格，中格左缘对齐 Main（spec §3.4）；StartupView 启动页 hero **摘除产品名**（§8.7：TopBar 已有「新会话」，composer 才是主角）。窄窗 160px/收起 48px 两种侧栏态下 `#top` 列宽同步跟随。夹具 #top 三格同位。
- **阶段5完成（响应式/抽屉）**：① 断点机制——`webui/src/lib/shell-cols.ts`（`shellColsFor` 纯函数 + `observeShellCols` ResizeObserver 观察 `#app` 实宽，4 个单测），`App.tsx` 把 3/2/1 列态写进 `#app.cols-N` class，CSS 列定义全部移出媒体查询；② **<1280 任务抽屉**——`WorkspacePanel` 增 `drawer` 属性（固定 320 覆盖式，恒展开），TopBar 右格出现带待办 badge 的触发钮，遮罩/Esc/触发钮回焦三路关闭；③ **<800 侧栏抽屉**——`Sidebar` 增 `drawer/drawerOpen`（288 覆盖 Main），汉堡在 cols=1 时变菜单按钮；④ 壳表面实底化（`.app-sidebar` 去 backdrop-filter，玻璃只留给抽屉/浮层，spec §10）。capture 断言语义分三态：列态验 dock/推挤、抽屉态验覆盖层、未挂载只验正文对齐；新增 `rail-drawer-1024`/`sidebar-drawer-640` 场景，`sidebar-pending-640` 带 `sidebarDrawer=1`。
- **visual-capture 护栏（本轮沉淀，可作其他调试典范）**：单场景 120s `withTimeout`（CDP 对端崩溃时 send 永不返回 → 实测 exit 13 静默死）、`Page.captureScreenshot` 单独 30s 护栏（OOM 时丢截图不丢断言）、每场景最多 3 次重试并整体重建 Edge/CDP（`spawnEdgeAndConnect` + `killStale` 用不带前导连字符的 pkill 模式——`--` 开头会被 pkill 当选项，实测踩坑）。**曾试 `--disable-gpu/--disable-dev-shm-usage` 压内存：这台 Edge 会让 CDP 静默挂死，勿再用**。
- **休眠限制（用户需求，Linux+Windows）**：Electron 原生 `powerSaveBlocker`——`prevent-app-suspension` 阻止系统休眠（允许熄屏，Linux 走 D-Bus inhibit、Windows 走 SetThreadExecutionState），`prevent-display-sleep` 连屏幕常亮（演示/监控）。主进程 `qaqh:power-blocker`/`qaqh:power-blocker-state` 通道（canControlWindow 守卫，模式白名单，单实例单 blocker 切换先停旧）；preload `powerBlocker.set/state`；renderer `webui/src/lib/power-blocker.ts`（纯逻辑：normalizeMode/modeFromToggles/togglesFromMode，7 个单测）+ 偏好存 `localStorage["qaqh.power-blocker"]`，启动时 HostSection `restorePowerMode()` 重放。UI 在「设置→桌面壳」：两个 Switch（阻止系统休眠 / 同时保持屏幕常亮，后者蕴含前者）+ readonly 状态行；主进程**不持久化**（界面偏好非 daemon 配置），应用退出 blocker 自动释放。真实休眠抑制效果未实测（需真机等系统 idle 计时器）。
- 剩余（不阻塞"壳"验收）：TopBar 右格的模型/权限 chip（§8.4/§8.5，依赖数据层口径统一）；启动页辉光装饰清理；`#app` grid-track 白名单断言（§12.1，现有 34 场景已覆盖几何/抽屉/回归三轴）。
- 未验证：真实 Electron 窗口全量手感（拖拽/缩放/WCO 按钮/⋯菜单/DevTools 按钮/抽屉手势）——主进程改动多轮累积，**务必重启壳实机复验一次**。

- 修复托盘创建窗口后 TypeScript 将 `mainWindow` 推断为 `never` 的编译问题；窗口唤起统一使用 Electron 的 `restore`、`show`、`focus`：`src/main/index.ts`。
- 前端使用的 `session.rename` 加入受限 RPC 白名单；显式提供的 `session_id` 不再要求另有活动会话：`src/main/ipc-handlers.ts`。
- IPC 在启动时注册；daemon 初始连接失败后，后续 IPC 可单航班尝试连接；连接失败仍明确抛错。恢复流程仍需真实 UI/daemon 测试：`src/main/index.ts`。
- 旧 daemon 停止重连前保存活动 session，重连后尝试恢复 attach：`src/main/ipc-handlers.ts`。现有测试验证恢复 helper，尚非真实 daemon 停机集成测试。
- `fs.list`/`fs.read` 按后端的可选会话契约运行，保留调用方显式传入的 `scope_session_id: null`。后端仍负责 allowed roots 与敏感路径保护：`src/main/ipc-handlers.ts`，`../qaqh-backend/crates/qaqh-runtime/src/service/fs_git.rs`。
- 基于历史功能清单补回若干受会话约束的只读 RPC（如 session dashboard、todo、plan、git 查询）；仍保留白名单，不开放任意 RPC。
- `host_process_group` 使用 Electron `app.getAppMetrics()`，排除已通过 `host_memory` 统计的主进程，按 KiB 转 bytes 并保留缺测：`src/main/process-metrics.ts`。前端 `../qaqh-desktop-app/src/lib/hostmem.ts` 对 Electron 来源不再将 JS 堆重复加入合计。

## 最后验证

- 2026-10-28 壳改造收尾口径：根仓 `pnpm run typecheck` 通过 + 根 tests 62/62；webui `pnpm run typecheck` 通过 + vitest **532/532**（含 `shell-cols` 4 个新单测）；`visual-capture.mjs` 全部场景的**断言**均绿（分块与单场景两种跑法都验证过），单场景快检 `shell-menu-light`/`rail-drawer-1024` 绿。注意：受当时机器 OOM（swap 满）影响，34 场景**一次性连续全绿**的跑法未拿到，但护栏（重试+截图降级）已就位，内存宽裕时重跑应一次通过。
- 以下为壳改造开始前的旧口径（历史参考）：
- Electron：`pnpm run typecheck && pnpm run build && pnpm test` 通过，44/44 tests。
- Renderer：`pnpm run typecheck && pnpm exec vitest run tests/hostmem.test.ts` 通过，16/16 tests。
- 上一阶段 SDK `pnpm test` 通过，35/35；这并不代表全功能端到端验收。
- **未运行真实 Electron 窗口 + daemon 的完整端到端测试、平台截图测试或完整 Linux 发布包验收。**进程指标转换及窗口操作当前主要有单元/编译验证，未进行跨平台 GUI 验证。

## 下一步优先事项

1. **实现原生截图与安全附件流。** 当前 `capture_screenshot` 明确报不支持（`src/main/ipc-handlers.ts`），前端 `screenshotSupported` 恒为 false（`../qaqh-desktop-app/src/lib/screenshot.ts`）。功能需求包括 selection、fullscreen、用户取消与错误区分；通过 Electron 原生能力设计，不能把整屏冒充选区。考虑 Wayland/X11/macOS/Windows 权限、显示器缩放和多屏、截图时机与遮罩、多次并发、取消和临时文件清理。截图生成的路径须以受控方式加入现有一次性附件许可（见 `approvedAttachmentPaths`），不应为 renderer 打开任意文件读取。平台不可用时诚实报错或隐藏能力，不能静默成功。先完成可测试设计，再在真实桌面环境逐平台验收。
2. **真实 Electron + daemon 冒烟与恢复验收。** 使用隔离数据目录与测试 daemon，覆盖启动/启动失败后恢复、创建与 attach、消息、流、审批、重命名、会话恢复、退出及托盘。避免未经用户确认关闭或改写用户正在使用的 daemon 和会话。`../qaqh-sdk/scripts/acceptance.mjs` 主要为协议只读验收，不能替代 Electron UI E2E；现有 `scripts/test-connection.mjs` 不能把打印成功当作全面验收。
3. **核对前端实际使用的 IPC 与后端响应。** 设置/配置、工作区、skills、todo、账户、模型、文件、配对/LAN、timeline 分页和重连需要针对真实 daemon 验证。SDK 的生成 coverage 中一些项目标记 pending，但后端当前源代码已有部分相应服务；pending 不等于服务肯定缺失，也不等于已验收。
4. **继续原生桌面能力。** 原 Tauri Git 历史可参考需求（`git show HEAD:src-tauri/src/lib.rs`、`commands.rs` 等）；原生主题/材质当前 `set_window_theme` 返回 false；Electron 进程组指标的跨平台可用性和单位需在真实应用验证。Linux 打包脚本仅支持 Linux x64（`scripts/build-all.mjs`）。
5. **自动化防回归。** 在保持发送方校验、固定白名单、token 留在主进程、审批 challenge 隔离的前提下，为前端 HostCommand/service 使用、SDK wire 与后端契约添加测试；对暂不支持的功能明确显示而非假成功。

## 重要注意

- 用户此前明确要求不要 spawn subagents；沿用该限制。
- 当前 frontend 工作区有大量迁移改动和 Tauri 删除项；这些都是工作区状态，不应自动恢复或清除。
- 本轮没有证明原 Tauri 全功能等价；不要称迁移完成。
- 每次改变源码后运行适当测试/构建；无法进行真实平台或 daemon 验收时明确说明。
