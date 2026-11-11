# 交接（handoff）前端施工记录 —— 2026-11-10

对位 LTS 后端施工单「前端施工单（全部走现成命令，后端不会再动契约）」。
本轮**没有新增任何命令、没有改任何生成契约**：根目录 `pnpm test` 里
`RINGING_COMMAND_TYPES covers every generated RingingCommand variant in both directions`
仍然通过，`webui/src/api/qaqh/*` 一个字节没动（施工单 §一：契约零新增）。

## 一、落点地图

| 施工单条目 | 落点 |
| --- | --- |
| §一·1 识别交接 | `webui/src/session/handoff.ts`（判据层，纯函数） |
| §一·2 立刻 fork（三条现成命令） | `webui/src/tabs/store.ts::forkHandoffSession` + `deliverHandoffDoc` |
| §一·3 切 tab / 去重 | `webui/src/session/handoff-journal.ts`（`from\|turn` 唯一键 + localStorage） |
| §三 插话条目渲染 | `session/reducer.ts::applyInputEntry`、`session/types.ts::InterjectionStep`、`turn/segments.ts`、`turn/interjection.ts`、`turn/TurnView.tsx::InterjectRow` |
| §三 handoff 工具图标/标签 | `tools/presentation.ts`（新增 `handoff` 档）、`tools/registry.ts`、`tools/StepRow.tsx` |
| §四 错误码 | `reducer.ts::statusFromOutcome`（带上 `TurnError.code`）、`TurnView.tsx`（`.turn-error-*`）、`StepRow.tsx`（`handoffToolErrorCode`） |
| §五 产品层兜底 | `TurnView.tsx::HandoffCard`（回合尾部常驻入口）+ `session/store.ts::reportHandoffFacts`（实时 fork 的闸门） |
| §六 血缘 | `handoff-journal.ts::parentSessionOf` + `MessageSidebar.tsx` / `SessionHeader.tsx` 徽标 |
| §七 自测 | `tests/handoff.test.ts`、`handoff-fork.test.ts`、`handoff-render.test.ts`、`handoff-live.test.ts` |

## 二、判据

主判据 = `tool_name === "handoff"` **且**结果里 `handed_off === true`：

- `handoff_doc` / `work_summary` **优先取 `ToolCallView.args`**（模型亲手写的那份结构化），
  `tool_finished.output` 里的同名字段只作「只渲染 output」老路径的兜底；
- `from_session_id` / `turn_id` 只在 output 里 → 它就是去重键 `from|turn`；
- 机器面 JSON 按**括号配平**取，不按 ``` 栅栏切：交接文档正文里带代码栅栏是常态
  （那是一篇给人读的 Markdown），栅栏切法会停在文档内部的闭合栅栏上，表现是
  「交接成功了但没人接」。测试专门喂了一份带 ```bash 栅栏的文档。

**次判据（推断封箱）只在机器面整段读不出来时启用**：`status:"finished"` + `args`
里有完整文档 → 事实成立，`from_session_id`/`turn_id` 退回本地会话与回合，并置
`inferred:true`（卡上明说这条是推定，不冒充读到了封箱标记）。开这条口子只为两种真实
情况：同回合的重复调用（输出只有人话、没有 JSON）、tool_result 正文取不到而
`args_json` 还在。重复调用落在同一会话同一回合 → 与首封**同一把 key** → 去重不受影响。
正文还挂在引用（`outputRef`）上没回填时**不推断**——那不是读不出，是机器面在路上。

**fork 时机 = 封箱结果到达，不等 `tool_declared`。** declare 用来识别与展示
（标签/图标/摘要）；若在 declare 就 fork，一旦入参被判 `handoff_invalid_args`、
模型改参数重试，就会把一份没写成的文档投进 B。封箱结果到达时 A 的 loop 正好终止，
没有额外延迟。

明确**没有**采用的判据（§二）：

- 不用 `turn_ended` 终态：`TurnTerminal` 冻结三值，交接后就是 `completed`，与自然答完不可区分；
- 不用 `compact_skip` / `autoCompactThreshold`：前者至今 0 写方，后者只驱动后端自己的提醒/折叠；
- 不做交接文档下载接口（没有 ContentRef），`handoff_path` **不上屏**：那只是本地镜像
  `.md`，摆出来只会被当成可点的链接（渲染测试断言转录里读不到那个路径字符串）；
- 不在 transcript 里找 `[#ctx 61% · 98k/160k]`：那条只进发给模型的投影，不落库。
  交接卡上的占用取自这条封箱自带的 `context_used_tokens`/`context_window_tokens`，
  与投影页脚不是一回事。

## 三、§三 那条最容易出问题的接缝

后端把看门狗提醒/折叠提示按**普通 timeline input** 落库：`purpose:"interject"` +
`actor.kind:"api"` + `actor.id:"handoff-watchdog"`。老渲染把 input 一律当「用户说的
话」，于是用户原话被系统文案顶掉，并且看起来像用户自己发了一句系统提示。

归约规则（`applyInputEntry`，实时与 bootstrap 走同一条）：

1. **用户 actor 的第一条 input** 才是回合主输入（写进 `turn.user` 并记下 `blockId`）；
2. 其余一律另立 `InterjectionStep`，单独成行、单独成段（不折进「已工作」组）：
   - `api/system/agent/subagent` → 系统插话，名字取 `display_name`（看门狗读作「上下文看门狗」）；
   - `user` 的 `steer` / `queue_only` → 「插话转向」/「排队输入」——同回合的用户插话
     同样不能顶掉主输入，这是老逻辑的另一处失真；
3. 同 `block_id` 重放只更新那一行，不产生第二行；
4. 判据只看契约里已有的 `actor.kind` / `purpose`；`actor.id` 只用来挑更准的名字；
   老快照不带 `actor` 时按「用户说的话」处理（字段缺省 ≠ 系统插话）；
5. 插话条目**不盖时间戳**：bootstrap 重放时 `now()` 会把历史回合的工作段时长拉成
   「加载时刻 − 实际开始」（实测把「已工作 3 秒」变成「已工作 2 小时」）。顺序事实
   来自 steps 数组本身，就是 timeline 顺序。

工具图标：`handoff` 按**工具名**判档，不吃任何 tool_mode 白名单（后端
`ensure_declared` 在 minimal/custom 档也无条件声明它）。摘要用模型的 `work_summary`
——`primaryArg` 会把整篇 `handoff_doc` 的第一个字符串当摘要。

## 四、fork 的三条命令与「接管」

```
session.create { cwd, model_selection, tool_mode, custom_tools, title }
   ← 四项全部抄 A 的 session.meta（transport.query("session.meta")，都是导出字段）
   ← title = work_summary（自动标题是死代码，不等后端）
conversation.send_message { text = handoff_doc, input_purpose = "trigger_turn" }
   ← 经本仓既有发送门面（session/store.ts:sendMessageWithAttachments 把 purpose 钉死）
会话接管 = openSession(child) → SessionStore.activate() → 宿主 attach（session.resume）
```

关于 `driver.claim`：**这条不发**，按事实说明理由。daemon 的
`RingingCommand::DriverClaim { client_session_id: _, stale_holder }` 显式忽略 payload 里
的 id，席位 holder 取命令**信封**里的租约 id（`commands.rs:510-529`），而租约 id 在主
进程、renderer 拿不到；会话面命令的鉴权看的是 lease 归属（`commands.rs` 的
`owns_session`），`attach` 已经把归属建立好；driver 席位在服务端不 gate 任何东西
（只 overlay 进 bootstrap 快照 + 广播 `DriverChanged`）。所以「按你们现有会话接管
流程」在本仓就是 attach，与用户点开一条既有会话同一条路径。

自动 fork 的闸门：只有**本会话事件流里声明过**的 handoff 调用才有资格触发
（`liveHandoffCallIds` 来自 `tool_declared` / `tool_arguments_delta`）。bootstrap 重放
不进这里——否则每次切回标签、每次重开客户端都会照着历史再开一条会话；历史里那条
交接走回合尾部的人点入口。输出以引用下发时等正文回填后再认（`handoff-live.test.ts` 覆盖）。

去重与幂等（三层）：

1. `handoffForkFlights`（进程内在飞集合）挡同一 tick 的并发触发；
2. `handoff-journal` 的 `from|turn` 唯一键（localStorage 持久）挡重开客户端后的二次点击；
3. `HandoffCard` 按账本切按钮态（`继续这条交接 →` / `打开交接会话` / `补投交接文档`）。

投递失败时**先记 child 再补投**：会话已经建出来就绝不再开第二条，重试只把文档投出去。

## 五、账本为什么以普通 Map 为权威（踩过的坑）

本仓的 Solid 2 rc **在 root 外写信号不会同步可读**（`tests/create-session-workspace.test.ts`
为这个专门 `flush()`）。实测撞上两次：

- 按钮守卫只靠 `busy()` 信号时，连点两下都放过 → 会 fork 两次；
- `recordHandoffFork` 之后立刻 `forkRecordOfFact` 读到 null → 同一 tick 内并发触发会开第二条会话。

所以账本权威是一份普通 Map（写下去就算数），信号只当版本号给渲染面订阅；卡片守卫
同理用普通 `let`。账本里**不存交接文档正文**——权威在 A 的 `tool_calls.args_json`
与 tool_result 两处，抄一份进 localStorage 只会多一个没有版本管理的真相源。

## 六、血缘（§六）

`session.create` 没有 `parent` 字段，加它 = 改命令判别 = 契约破坏（LTS 禁）。本轮按
「短期」方案做：本地 child→parent 映射（账本）现算，两处呈现——侧栏会话行的 `fork`
徽标与标题栏同款徽标，`title` = 「【此对话为 fork 交接对话】 · 交接自「…」」。

**待 v3.1 换锁**（后端已表示可写进契约修订单）。我方口径，按重要性排序：

1. `SessionCreate.parent_session_id` + `SessionListEntry` 导出该字段 —— 血缘的唯一
   正解。届时 `parentSessionOf` 改读后端字段，账本退化为「早于 v3.1 的存量会话」的
   兼容读取路径（`handoff-journal.ts` 头注释已标出这个切换点）；
2. `handed_off` 终态（或 `TurnTerminal` 之外的显式交接标记）—— 前端判据不变（仍从
   工具事实读），但历史侧读起来不必反推；
3. `TimelineEntry` 那条 input 的命名可判别 —— 现在靠 `actor.kind` + `purpose` 组合
   判定已经够用，这条是锦上添花。

另：§二 说的「占用率进 `session.meta`」（新字段 = 换锁）我方无异议。进来了就把交接卡
上的占用从「取自这条封箱的 JSON」升级为「取自会话当前占用」——两个语义不同，不能混用。

## 七、错误码（§四）

都在现成字符串里，正文一律直显后端 `message`，前端不编文案：

| code | 走哪条面 | 呈现 |
| --- | --- | --- |
| `context_overflow` | `TurnError.code` | `.turn-error` + code 徽标（后端同时已把分母收敛） |
| `handoff_missing` | `TurnError.code` | 同上 + 一句「要人看一眼、不会自动重试」；本仓对失败回合**没有任何自动重试路径** |
| `handoff_invalid_args` | `tool_finished{status:"error"}` | 工具行状态位直显 code，展开区显示 message；回合继续 |
| `handoff_write_failed` | 同上 | 同上 |

## 八、自测清单进度

已自动化（`pnpm --dir webui run test`：**89 files / 538 tests 全绿**；根目录
`pnpm test`：68 pass / 0 fail / 1 skipped；两端 `tsc --noEmit` 均干净）：

- 插话条目：实时 + bootstrap 两条路径都不顶掉用户原话、标签不是「用户」、不折进
  「已工作」组；用户 steer/queue 也不顶主输入；同 block 重放只更新一行；
- 交接事实：args 优先 / 带代码栅栏的文档仍读得出机器面 / 重复调用退回同一条 key /
  失败调用不成立 / 无 args 退回 output 那份 / 页脚缺失不影响；
- 实时链路：封箱立刻上报、declare 不上报、引用回填后上报、**bootstrap 重放不上报**、
  同回合二次调用不再上报第二条；
- fork：三条命令的载荷（`session.create` 抄齐四项 + title）、文档投给 child 的既有
  发送门面、同一 `from|turn` 只 create 一次、「会话建了但文档没投出去」重试只补投递、
  活动标签切到 B；
- 渲染面：系统插话行不是用户气泡、无主输入时不造空气泡、`handoff_path` 不上屏、
  连点两次只 fork 一次、fork 过后按钮变「打开交接会话」、`handoff_missing` 直显 code、
  交接工具行的标签/摘要/状态；
- 账本：fork 去重、child→parent 血缘、进程重开（模块重新求值）后仍读得到同一条。

仍需真 daemon + 真模型（§七·1/·2/·4 的运行半边，本轮没起后端、没打真模型请求）：

1. 长会话推到 `autoCompactThreshold`（默认 0.75）→ A 里出现「上下文看门狗」条目、
   模型调用 handoff → A `completed`、B 首条 user 是交接文档且能继续干活；
2. 阈值设 0 → 不应出现任何提醒/折叠，撞墙时看到 `context_overflow`；
3. 让模型只发 `work_summary` 不发 `handoff_doc` → A 里看到 error tool_result 且回合
   继续（不 fork）；
4. 关掉客户端再触发交接 → A 停在 `completed`；重开后点「继续这条交接」→ B 正常生成，
   文档内容与 A 的 timeline 一致。

异常时请一并给：那份 `.md`（`handoff_path`）与 A 的 `session_id`。
