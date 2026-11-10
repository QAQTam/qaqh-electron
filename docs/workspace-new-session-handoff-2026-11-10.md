# 工作区新建入口 / 模型切换 交接

日期:2026-11-10。基线 `HEAD = 33ab564d`(会话中途由并行工作推进,开工时为 `bcc9e12`)。
本轮改动**全部未提交**:我改的 14 个源文件 + 4 个新测试文件 + 本文档;另有 1 个**与本轮无关**的
既有未提交项(`webui/src/api/qaqh/ModelCapabilities.ts`,见 §5.5)。
给下一个执行环境(人或工具)使用;命令、路径、行号均为本机绝对事实,行号只在对后端 `qaqh-backend-lts` 引用时给(那边本轮只读未写)。

## 1. 状态摘要

| 项 | 状态 |
| --- | --- |
| 阶段A 侧栏/菜单「在此工作区新建会话」 | ✅ 已落地并验 |
| 插队修 `SettingValue::Inherit`(「跟随存档」此前一点就报错) | ✅ 已落地并验 |
| WebUI `pnpm run typecheck` / `pnpm run test` | ✅ 通过(82 文件 / 492 例;开工前 78 / 477) |
| 根包 `pnpm typecheck` / `pnpm test` | ✅ 通过(69 例,0 失败,1 skip:Linux-only) |
| `visual:capture` 新场景 `sidebar-workspace-create` | ✅ 端到端通过并出图(见 §6 的启动方式) |
| 阶段B 启动页复用 `Composer` + 预检态卡片 | ⬜ 未动 |
| 阶段C provider/model 目录并入 `EffortCard`、摘 profile chip | ⬜ 未动 |
| 阶段D 单档不画轨道 / 配置→发送顺序屏障 / 失败自动展开卡片 | ⬜ 未动 |
| backend | ⬜ 未动(工作树另有他人在改:`qaqh-agent-runtime/*` + 未跟踪 `handoff.rs`) |
| SDK 契约 | ⬜ 未动,见 §5.2 的既有未提交项 |

## 2. 需求与裁定(来自产品讨论,已定)

| 诉求 | 裁定 | 依据 |
| --- | --- | --- |
| 每个工作区行右侧一个「+」= 直接在该工作区新增对话 | 做:设粘性目标 + 回启动页,**不在点击时建会话** | 后端 `session.create` 末尾无条件 `registry.spawn_new`(`service/handlers/session.rs:205-209`),先建不说话的会话等于白拉 worker 且会以零轮次会话进 `sessions()` |
| 启动页默认选中新目录 | 已具备:`newSessionCwd` 本身是粘性且落 localStorage | `tabs/store.ts` WORKSPACE_CWD_KEY |
| 摘掉 composer 的「选择服务商和模型」下拉 | 方向确认,但**不能裸删**:它是当前唯一能改会话 `provider_id` 的入口,且 BYOK 无账户级目录时是唯一模型列表 | `session/store.ts:setSessionSelection` vs `setSessionModel`;`composer/model-config.ts:catalogOptions` |
| 启动页 composer 与 chat 一致(可调思考强度、工具模式) | 做:后端 `session.create` 收 `model_selection.options.reasoning_effort` / `max_output_tokens` 与 `tool_mode` / `custom_tools` | `session.rs:159-185`、`RingingCommand.ts` |

## 3. 后端事实清单(勿重复挖)

- **`session.create`**:`cwd` / `title` / `model_selection` / `tool_mode` / `custom_tools`;`model_selection` 为空 → 回落 `default_model_selection`,无默认才报 `请先在电脑端设置默认服务商和模型`(`session.rs:173-176`);回合执行时同样回落(`qaqh-agent-runtime/src/agent/session_config.rs:15-18`)。**没有 draft/ephemeral 入参**:`create_business_row` 硬编码 `ephemeral: false`(`session.rs:267`)。
- **`session.settings.patch`**:`{model_selection?: SettingValue<ModelSelection>, tools?}`,带 `settings_revision` CAS,冲突返回 409 `settings_revision_conflict`(`axum_impl/commands.rs:390+`)。`SettingValue::Inherit` → **清列、跟随全局默认**(`qaqh-session/src/db/store.rs:305` 文档 + `:347` 实现)。写完定向 `agent.reload_config`,**下一轮生效**(`providers.rs` 注释)。
- **提交侧 fail-fast**:`resolve_model_selection`(`qaqh-profile/src/resolver.rs`)校验 provider 已注册 / 模型已注册且 enabled / `reasoning_effort` 必须落在该模型 `reasoning_levels` 且 `capabilities.reasoning` / `max_output_tokens ∈ [1, 模型上限]` / 原生搜索能力与路由。跨模型沿用旧档位会被 400 拒——所以"换模型清掉 options 的档位叶子"是**正确**行为,不是 bug。
- **`requested_model_selection`** 是审计位,不是"待生效"标记(见 `SessionMetadataPatch` 字段文档),不要拿它做 UI 状态。
- **`tool_mode` 白名单**:`qaqh_types::tool_mode::KNOWN_MODES = [standard, minimal, minimal:b, minimal:c, custom]`(`tool_mode.rs:28`)。`custom` 要求 `custom_tools` 非空。`ptc` 尚未收录。该常量**不在契约导出里**(`docs/api-surface/v3.0/constants.ts` 只有 schema/version/base_path/两条 revision),所以 `composer/ToolModeCard.tsx` 的档位表是人工镜像 —— 想让它进契约属于"换锁"级改动。
- **LTS 冻结纪律**(`qaqh-backend-lts/docs/lts-v3.0-maintenance.md` §1):HTTP 路由集、信封字段、`ringing-commands-7`/`ringing-session-2` 取值、`TYPED_METHODS` 形状、`RingingCommand`/事件各变体字段、`contract_hash` 全部冻结;闸门逐字节比 artifact + 从源码正则抓路由表 + 比 qaqh-client `pub use` 清单;金标准只能"新 LTS 线切出"或"明确批准的契约修订(换锁)"两种情况再生成。允许"新增仅在内部使用的代码路径"。
- **值级通道已探尽,全部不能用**:config.save 虽是 `JsonValue` 但入口 `serde_json::from_value::<ConfigPatch>` 严格转类型(`service/handlers/system.rs:24-30`);`tool_mode` 走白名单;`RingingV2Capabilities` 是 6 个固定 bool(`qaqh-ringing/src/v2/types.rs:384-397`);`todo.set.args` 是别人的域。壳侧 `QAQH_*` 环境变量**会**原样透传给 daemon(`src/main/daemon.ts:258-264`,仅删 `QAQH_SERVER_TOKEN`)。
- **expAPI 结论**:本轮四项**都不需要** expAPI(后端语义已在,缺的是前端没接)。"草稿会话"需要新后端语义,不属于 exp 而属于 main 线换锁;若将来设计 exp,规则应为:①槽位一次性进契约、之后只长数据;②开关权威在后端、前端只按能力渲染(本地 flag 只允许关不允许开);③exp 特性禁止进入持久化数据形状;④每个特性登记 id / 最小 revision / 退出条件。参照 ZCode 的做法见 §5.4。

## 4. 本轮改了什么

### 4.1 `webui/src/app/MessageSidebar.tsx`
- 分组过滤:`filter(group => group.sessions.length > 0)` → `filter(group => group.sessions.length > 0 || group.missingDir !== true)`。**零会话工作区现在列出**(否则「给这个工作区起第一条对话」在侧栏没有落点);目录已不存在且零会话的死组不占行;有历史的死组仍列出。
- 组结构:`.message-workspace-row` = 折叠钮 + `.message-workspace-create`(`+`)。`+` 的条件:`onCreateIn != null && path !== "" && !missingDir`;`canCreate === false` 或 `creating` 时**禁用而非撤掉**(「这里能建,只是现在不行」要能被读出来)。
- 新 prop `onCreateIn?: (path: string) => void`;`app/Sidebar.tsx` 透传;`app/App.tsx` 接 `createSession(path)`。

### 4.2 `webui/src/tabs/store.ts`
`createSession` 从 `async`+`setIsStartup(true)` 改为同步并**委托 `openStartup()`**(它负责取消在飞激活、退订其余 store、bump 焦点令牌)。修掉了 **Ctrl+T 与侧栏「+」行为不一致**。注释改成真实语义(不再声称调用 `session.create`)。调用点:`App.tsx` 的 Ctrl+T 去掉 `void`;`<TabBar>` 那段调用在 JSX 注释里(死文本),未动。

### 4.3 `webui/src/workspace/WorkspaceMenu.tsx`
`WorkspaceMenuItem` 由单个 `<button role="menuitemradio">` 改为 `.workspace-row-shell` + `.workspace-row-pick`(选择钮)+ `.workspace-row-create`(`+`)。理由:**button 嵌 button 是非法 HTML**。新 `onCreateIn?: (path) => void` 经 `WorkspaceMenu` 逐行分发;`missing_dir` 行不给。两个宿主(`composer/Composer.tsx` 新 prop `onCreateInWorkspace`、`session/StartupView.tsx`)都接上,点前先关菜单。

### 4.4 样式
- `styles/shell/sidebar.css`:`.message-workspace-toggle` 由 `width:100%` 改 `flex:1 1 auto; min-width:0`;新增 `.message-workspace-row` / `.message-workspace-create`(静置 `opacity:0`,hover/focus-visible 显形,**常占位**——沿用 `.message-session-more` 的既有规则)。
- `styles/components/composer.css`:把 `.composer-menu > button` 的三组基础表面规则(position/display/padding/hover/selected/small)显式续到 `.workspace-row-pick`;`.workspace-row-create` 绝对定位进**同一个 26px 行尾格**,悬停/`focus-within` 时与 `.workspace-row-check` 互换显隐(所以行宽、条目高度零变化,长路径不被挤出)。

### 4.5 inherit 修口(`webui/src/session/store.ts` + `composer/EffortCard.tsx`)
- `setSessionModel(null)` → 发 `{kind:"inherit"}`。此前 throw,「跟随存档」按钮**一点就报错**(全仓从未发出过 inherit)。
- `setSessionEffort(null)` / `setSessionMaxTokens(null)`:会话本就无独立选择时改为**无操作**;要设值却无可依附的对时报可照做的错(「先在「模型」行选一个」)。
- **本轮新增的补偿**:清成跟随存档后 `metaModelSelection` 为 null,而模型行只带 `model_id`,换不回 → `setSessionModel(model)` 在无选择时以 `registry()?.defaultSelection` 为底落 `Use`(= 后端此刻实际在用的那一对)。副作用要说清:此后本会话钉在当时的默认对上,不再跟随存档。
- 文案:「强度跟随存档」→「强度跟随模型默认」;最大输出 placeholder 与注释同改;模型行「跟随存档」加 title 说明写的是 Inherit。

### 4.6 新测试(`webui/tests/`)
`workspace-sessions-ui.test.ts`(4)、`workspace-menu-add.test.ts`(3)、`session-settings-inherit.test.ts`(6)、`create-session-workspace.test.ts`(2)。

## 5. 陷阱与既有问题(不要重新踩)

1. **happy-dom UI 用例必须显式指向 dev 客户端构建**:`vi.mock("solid-js" → ../node_modules/solid-js/dist/solid.dev.js)` + `vi.mock("@solidjs/web" → web.dev.js)`。不写这两行时 `@solidjs/web` 解析到 server 构建,`tabs/store → ui/toast → ~icons` 在**导入期**抛 "Client-only API called on the server side"。
2. **写完信号要 `await flush()` 再读**:本轮实测不 flush 时第一条用例读到 `null`、第二条读到的是上一条的写入。断言别拿未提交的读当证据。
3. **`registry()` 是模块级缓存**,同一测试文件内前一条用例的 `provider.list` 会污染后一条(本轮 `refreshProfile` 只在 `registry()==null` 时才 `refreshRegistry`)。需要特定存档默认时显式 `await refreshRegistry()`。
4. **messages 视觉场景在本机跑不通(既有)**:`waitForFixture` 默认要 `#messages .turn`,而夹具 `store.loadBootstrap()` 需要宿主(`window.qaqhHost`),vite+浏览器下消息树恒不产出 → 停在「消息同步中…」。A/B 已确认与本轮无关(stash 后基线同样 0 turns)。本轮只做了两件不改变既有判定的事:`capture()` 新增可选 `ready` 选择器;把 geometry 段里 `null.getBoundingClientRect()` 的 TypeError 换成有名字的失败。**下一步若要把 messages 场景救活,应该修夹具而不是放宽断言。**
5. **`webui/src/api/qaqh/ModelCapabilities.ts` 在本轮开工前就已是 modified 状态**(后端 `ac54e508` docs + `4c3a26be` regenerate golden → 前端镜像同步未提交)。本轮未碰。合并时要单独确认它是否随本批提交。
6. `tabs/store.ts` 的 `moveSessionToWorkspace` / `detachSessionFromWorkspace` **无 UI 调用方**;`WorkspaceMenu` 头部注释原写"三处共用"是假的,已改为实际两处。
7. **`options: {}` 不是 bug**(本会话一度判错,已更正):见 §3 提交侧 fail-fast。要做的是**逐叶判合法**(用 `ModelDef.reasoning_levels` / `max_output_tokens` 判断能否保留),不是无脑保留。

## 6. 复验命令

```powershell
cd D:/Projects/qaqh-electron
pnpm typecheck; pnpm test                       # 根包:69 例
cd webui; pnpm run typecheck; pnpm run test     # 82 文件 / 492 例

# 视觉场景(需要 dev server 与 Edge)
cd D:/Projects/qaqh-electron/webui
pnpm exec vite --host 127.0.0.1 --port 5173     # 另开一个终端
$env:QAQH_VISUAL_FILTER="sidebar-workspace-create"; pnpm exec node scripts/visual-capture.mjs
# 产物:webui/artifacts/ui-visual-review/sidebar-workspace-create.png(artifacts/ 已 gitignore)
```

关键断言值(实测):`qaqh-telegram` 零会话组列出;`gone-and-empty`(死目录+零会话)不列出;`+` 静置 `opacity=0` 且占位 24px;悬停 `opacity=1`、行宽 262 不变;菜单行悬停时 create `0→1`、check `1→0`,`elementFromPoint` 落在 `+` 自己的盒子里。

夹具入口:`webui/src/stress.tsx` 的 `previewWorkspaces` 含一个零会话工作区与一个死目录工作区;侧栏 `onCreate/onCreateIn` 与输入区 `workspaces/onWorkspace/onCreateInWorkspace` 都已接(此前**完全没传**,那张目录菜单从来没被视觉评审覆盖过)。

## 7. 下一步(建议顺序与入口点)

**阶段B｜启动页 = 同一份 composer**
- 删 `session/StartupView.tsx` 里手搓的输入区(整段与 `composer/Composer.tsx` 平行:textarea、附件 chip、工具条、发送钮),改渲染共用组件。理由不是审美:每键卡顿修复 `44177da` 当时在两个文件各写一遍同样的非受控化。
- 给 `Composer` 加 `sending?: () => boolean`(启动页忙态 = 发送钮转 loader,**不要**复用 `running()` 那条切「停止」的路径)。
- 新增 `startupPreflight` 信号(放 `tabs/store.ts`,与 `newSessionCwd`/`startupAttachments` 同级并落 localStorage),`EffortCard`/`ToolModeCard` 接本地读写口——两卡 props 全可选、未注入时自动退回全局(`EffortCard.tsx` 里 `currentProviderKind()/currentModel()` 兜底),所以是"补调用点"而不是改卡片。
- `submitStartupSession` 组装 `session.create{model_selection(+options), tool_mode, custom_tools}`;删掉 `StartupView.tsx` 的 `请先选择服务商和模型` 硬闸(未选 = 不发 `model_selection`,后端回落)。
- 附件从 `string[]`(只有 ready 态)升到 `PendingAttachment[]`。

**阶段C｜合并 provider/model,摘 profile chip**（**必须先于摘 chip**,否则 §4.5 的补偿就是唯一的退路）
- `Composer.tsx` 的 profile 菜单目录并进 `EffortCard` 模型行(registry 的 enabled 模型按 provider 分组 ∪ 账户级在线目录;两家都空才退回手填),「管理服务商和模型…」入口搬进卡内。
- 写口换整对,并按 §5.7 做**逐叶判合法**的保留/丢弃。
- 会话页摘掉那颗工作区 chip(`App.tsx` 只在启动页传 `onWorkspace`),身份行只读显示本会话工作区;强度卡加「下一轮生效」说明(§3 reload 事实)。

**阶段D｜纪律(抄 ZCode,不动契约)**
- 单一可用档位时不画禁用轨道,只画标题。
- 配置写 → 发送加顺序屏障:`enqueue/wait` + 未开始的同类命令合槽 + 发送前 `seal`(参照 ZCode `packages/ui/src/v4/composer/configCommandBarrier.ts`,94 行纯实现)。现状:`session.settings.patch` 与 `conversation.send_message` 无顺序保证。
- 切换失败自动展开出错的那张卡(参照 `ComposerProviderMenu.tsx:67-70`),不要只 toast。
- 空值诚实:全局兜底值不得当作"本会话的值"渲染。
- 参考实现的其余可抄点(合并菜单、状态穷举、container query 密度分级、`Object.freeze` 提交快照、会话事实永不回写全局默认)见对话记录,不在本轮范围。

## 8. 待你决定

1. 提交切分:建议两个可审的 commit —`feat(workspace): 每工作区新建会话入口` 与 `fix(composer): model_selection 清除走 Inherit`;`ModelCapabilities.ts`(§5.5)是单独一笔还是随本批。
2. 「跟随存档」→ 之后再换模型会**钉在当时的默认对**上(§4.5)。是否在卡片上把这句写出来(现在的 note 只会变成"模型单独设置"),还是等阶段C 合并后一并措辞。
3. 侧栏列出零会话工作区会让注册过但没用过的工作区常驻列表。若嫌吵,可选:默认折叠(复用现有 `qaqh.sidebar.collapsed` 记忆)或只列最近 N 个——需要产品定夺,不是技术限制。
