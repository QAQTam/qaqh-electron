# Handoff 内核 fork 前端配套施工单 —— 2026-11-13（v3.1a 批次，ADR-016 切片 4）

对位后端 `qaqh-backend/docs/adr/0016-handoff-kernel-fork.md` §决策 3/6/8。
后端切片 0–3 已实施：封箱即闭门（切片 0）+ 内核 fork 引擎（切片 1）+
`HandoffSealed` 事件与 `handoff_from_session_id` 血缘导出（切片 2）+ daemon sweep（切片 3）。
本单把前端从「fork 的决策者」降级为「fork 的投影」，并收口防双 fork 撞车面
（ADR-016 §坑：前端活跃路径 T0 立即 fork 不走内核幂等闸）。

## 〇、骨架（不可协商）

1. **fork 决策权全部归内核**：前端不再调 `session.create{handoff_from}` 建后继、
   不再投递交接文档。内核单时刻 T+10s（`FORK_DELAY_MS`）一体完成建 B + 投文档 +
   开回合 + 发事件。前端只投影。
2. **信号语义**：封箱事实（`handed_off:true` 的 tool_result，离线可重建）=「本线
   已闭门」；`HandoffSealed` 事件（A/B 双流，字段 `sealed_session_id` /
   `chain_root` / `successor_session_id` / `turn_id` / `work_summary` / `at_ms`）
   =「链已接上」；`SessionListEntry`/`SessionMeta.handoff_from_session_id` = 血缘
   读模型（重开/事件错过也能重建）。
3. **三项产品口径（默认项，ADR-016 §决策 3/6 待所有者复核，推翻只改这三条）**：
   - 单时刻 T+10s：倒计时纯展示（显示后端阅读窗剩余时间），到点前端不自做任何事；
   - [取消自动] → 「不拽我」：内核照常 fork，仅前端不自动跳转（纯前端，零 wire）；
   - [立即继续] → eager 标记：HandoffSealed 一到立即切 B（纯前端）。
4. **防双 fork**：`forkHandoffSession` 全链路删除后，前端不存在任何建后继的写者，
   内核幂等闸（`handoff_chain_head==root`）成为唯一闸门。

## 一、逐文件改动

| 文件 | 改动 |
| --- | --- |
| `webui/src/api/qaqh/SessionEvent.ts` / `SessionEventFrame.ts` | 加 `handoff_sealed` 变体（照金标准 `docs/api-surface/v3.0/types/qaqh/SessionEvent.ts` 逐字段） |
| `webui/src/api/qaqh/SessionMeta.ts` / `SessionListEntry.ts` | 加 `handoff_from_session_id?: string \| null`（金标准同源） |
| `src/main/ipc-handlers.ts` | `session_list` 投影透传 `handoff_from_session_id`（宿主侧栏字段镜像，与 webui `SidebarSession` 两边同步） |
| `webui/src/tabs/store.ts` | 删 `forkHandoffSession`/`deliverHandoffDoc`/`handoffTitle`/`handoffForkFlights`/`onHandoffDetected` 接线；`CreateSessionOptions.handoffFrom` 与 `session.create.handoff_from` 载荷一并删除（用户发起的建会话没有血缘）；`SidebarSession` 加血缘字段 |
| `webui/src/session/store.ts` | 删 `onHandoffDetected`/`settleHandoffFacts`/`reportHandoffFacts`/`liveHandoffCallIds`/`historicalHandoffCallIds`/`reportedHandoffKeys`；加 `handoffSealed` 信号（事件投影，A/B 双流幂等）+ `sealedLocally` 信号（封箱事实扫描：bootstrap / tool_finished / 引用回填三路收口，`sawHandoffCall` 收窄扫描面）+ `isHandoffSealed()`（composer 置灰唯一依据，B 侧不置灰） |
| `webui/src/session/handoff.ts` | 加 `HandoffSealedView` 投影形状；事实层（`handed_off:true` 判据）不动——它仍是封箱卡与置灰的数据源 |
| `webui/src/session/handoff-journal.ts` | 收缩为**只读遗留**：保留 localStorage 旧记录的 `parentSessionOf` 兼容读取；删写面（`recordHandoffFork`/`markHandoffDelivered`）与指纹（`deliveredDocMatch`）、`forkRecordOfFact`、`forkedChildrenOf` |
| `webui/src/session/handoff-remote.ts` | 接口删 `onAuto`（主进程表把退役为纯展示）；`onContinue`=eager 标记、`onCancel`=「不拽我」标记 |
| `webui/src/turn/TurnView.tsx` | 封箱卡：倒计时降级为展示（剩余时间从 `sealedAt+10s` 实算，不再重挂回满 10s）；删 fork/inFlight/补投/账本分支；后继已知 → 「打开交接会话」；`on(uccessor, {defer:true})` 挂载后事件到达才自动跳转（飞箱 + `openSession`），「不拽我」在场则安静留在卡片；开箱判据改权威两源（`HandoffSealed` 事件 successor==self + 目录血缘字段），删 `deliveredDocMatch` |
| `webui/src/session/HandoffOpenCard.tsx` | props 改 `source: { sessionId, workSummary, atMs }`（不再依赖账本记录类型） |
| `src/main/notifier.ts` | 10s 表把退役为纯展示：删 auto 点火，只留 GIF 宽限后收卡；OS 卡按钮照发 `notify://handoff` continue/cancel（renderer 落成标记）；文案改「由内核自动继续」 |
| `webui/src/composer/Composer.tsx` | `SendBlockReason` 加 `"sealed"`；blocked 提示「本会话已封箱交接，去新会话继续」 |
| `webui/src/app/App.tsx` | `blockedReason` 加 sealed 档（`tab.store.isHandoffSealed()`）；`send` 竞态兜底：封箱态下的失败不再弹红 toast，改 info 提示去新会话 |
| `webui/src/lib/strings.ts` | 加 `sendDisabledSealed`/`handoffEagerNote`；删 fork 专用串（`handoffForked`/`handoffForkFailed`/`handoffDeliveredPartial`/`handoffRetryDelivery` 等） |
| `webui/src/app/MessageSidebar.tsx` / `session/SessionHeader.tsx` | 血缘徽标改读目录血缘字段，账本仅作升级前旧数据兜底 |
| `webui/src/promo.tsx` | `HandoffOpenCard` 新 props 适配 |

## 二、测试（定向，不铺摊）

- [x] 删 `webui/tests/handoff-fork.test.ts`（fork 机器整体退役，命令面断言随写者一起失效）。
- [x] 重写 `webui/tests/handoff-live.test.ts`：封箱投影三路收口（事件/事实/引用回填）+
  A/B 双流幂等 + 历史重开不自动跳转 + composer 置灰口径（B 侧不置灰）。
- [x] 更新 `webui/tests/handoff-render.test.ts`：卡 props 改 `successor`；倒计时展示、
  取消即留卡、后继已知出「打开交接会话」；删补投用例。
- [x] 收缩 `webui/tests/handoff.test.ts` 账本段：只留 localStorage 旧记录的
  `parentSessionOf` 兼容读取。
- [x] 闸门：webui 与主进程 `tsc --noEmit` 绿；`vitest run handoff` 三件套 32/32 绿；
  `sdk-contract.mjs check` 逐文件一致。（reducer.test 2 失败属 reducer.ts 在途改动，
  另一会话所有，非本单范围。）

## 三、验收（切片 4 完成判据）

1. [x] 全仓 grep 无 `forkHandoffSession`/`deliverHandoffDoc`/`recordHandoffFork`/
   `deliveredDocMatch`/`onHandoffDetected` 的存留引用（promo/测试除外均已适配）。
2. [x] 前端不再发出任何 `session.create{handoff_from}`（`CreateSessionOptions.handoffFrom`
   与载荷一并删除；防双 fork 收口）。
3. [x] `HandoffSealed` 到达 → A 卡「已在新会话继续」+ 自动跳转（不拽我除外）；
   事件错过时目录血缘重建同一状态（defer effect 只在挂载后 null→有值跃迁跳）。
4. [x] 已封箱会话 composer 置灰 + 文案提示（`SendBlockReason:"sealed"`）；B 会话
   composer 照常（handoff-live 用例钉死）。
5. [ ] 运行半边（真 daemon + 真模型）另测，不在本单。
6. [x] 口径留痕：T+10s 单时刻经所有者复核确认（ADR-016 §决策 3）；[立即继续]/
   fork_now 所有者要求重新统一口径，统一前保持纯前端 eager 标记（ADR-016 §决策 6）。
