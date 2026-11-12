# 子代理 / 任务板前端施工单 —— 2026-11-13（v3.1a 批次）

后端来源：`qaqh-backend` main `f1b5fc78`（ADR-0014 切片 A–G 全部落地）。
端到端背书：`scripts/smoke-subagent.ps1`（fresh）与 `-Fork`（真 fork）均 PASS
（真实 daemon + 真实模型回合，非单测）。

**本批零契约增量**：不改任何导出 DTO 形状。team/task/subagent 全部类型已在
v3.0 金标准导出（`TeamResponse.ts`/`TaskView.ts`/`SubagentTerminalNotification.ts`
等 28 个文件），`webui/src/api/qaqh/*` 缺的从现有导出补，**不需要**等契约重生成。
命令面代际 -8 → -9 的 bump 属 Goal 批次（见 `goal-mode-frontend-2026-11-13.md`），
与本批正交；两批一起重新生成契约产物时本批不贡献形状变化。

---

## 〇、先读三个事实（防止按死契约施工）

1. **没有 team delta 推送**。`TeamDelta`/`TaskBoardDelta` 词表在契约里活着，但
   collector 退役后**无任何发射器**（runtime/daemon 全文零引用）。不要写订阅
   代码。刷新策略见 §一·3。
2. **两种 fork 不是一回事**：
   - `handoff` 工具的 fork（`forkHandoffSession`，已落地，见
     `docs/handoff-fork-frontend-2026-11-10.md`）= **文档交接**，新会话只拿到
     markdown，看不到父工具调用/思考。
   - 本批 `spawn_subagent` 的 `mode:"fork"` = **上下文 fork**，子会话日志被
     种子化父级**已完成回合**前缀（无损，不含父级在飞回合）。两者并存，别合并。
3. **终态通知是运行时陈述，不是子代理说的话**。`subagent_terminal` 消息的
   正文是 runtime 生成的摘要（含子级最终答复），归因渲染见 §三。

## 一、Team 页数据源

### 1. 端点

`GET /ringing/v2/sessions/{seed}/team`（鉴权：Bearer + `x-qaqh-client-session-id`，
lease 必须已 attach 到该会话）。响应 `TeamResponse`：

```jsonc
{
  "schema": "qaqh.ringing.team/v1",
  "session_id": "<seed>",
  "team": {                      // TeamSnapshot：花名册
    "root_session_id": "<seed>",
    "agents": [TeamAgentSnapshot],
    "unread_messages": [],       // 恒空（无发射器），别渲染未读角标
    "revision": 0,               // 恒 0
    "last_fact_seq": 0
  },
  "tasks": {                     // TaskBoardSnapshot：任务板（本批重点）
    "team_id": "<root seed>",
    "revision": 3, "last_fact_seq": 3,
    "tasks": [TaskView]
  },
  "board": {                     // TeamBoardSnapshot：留言板
    "board_id": "<root seed>", "revision": 1, "last_fact_seq": 1,
    "channels": [TeamBoardChannel], "threads": [TeamBoardThread],
    "posts": [TeamBoardPost], "subscriptions": [TeamBoardSubscription]
  }
}
```

`TaskView`（`types/qaqh/TaskView.ts`）：

```jsonc
{
  "task_id": "…", "title": "…",
  "description_ref": {"…ContentRef"}?,   // 正文走 GET /ringing/v2/content/{id}
  "state": "open|claimed|completed|closed|cancelled",
  "owner": {"agent_path": "/root/…", "session_id": "…"}?,  // TeamActor
  "claim_epoch": 2,                      // CAS 认领代际，展示用
  "depends_on": ["task_id"],             // DAG 边
  "artifacts": [{"artifact_ref": ContentRef, "media_type": "…", "added_at_ms": 0}],
  "acceptance": ["验收条 1", "…"],
  "result_ref": ContentRef?,
  "created_by": TeamActor, "created_at_ms": 0, "updated_at_ms": 0
}
```

状态语义（后端 `TaskState` 同口径）：终态 = `closed|cancelled`；
依赖满足 = `completed|closed`。`depends_on` 渲染 DAG/阻塞标记；
`acceptance` 渲染验收清单（当前 writeScopes 未落地，文件 scope 纪律靠
title/acceptance 文本承载，见 §五）。

### 2. 花名册投影的已知粗糙（不要当精确状态用）

`team.agents` 是端点现算的粗投影：子级 `Idle` 也映射成 `running`，
`residency` 除 root 外恒 `unloaded`，`nickname/role/current_task_id` 恒 null。
**精确运行状态用 `session.list` 的 `status`**（not_running/idle/running/
waiting_user/cancelling）；花名册只用于血缘拓扑（parent_agent_path）。

### 3. 刷新策略（无推送）

- 主触发：timeline 出现 `task_*`/`board_*` 工具的 `ToolFinished` → refetch `/team`。
- 兜底：Team 页可见时低频轮询（建议 5–10s）；不可见停轮询。
- `revision` 单调递增，可做乐观并发展示，但别等 delta 事件（§〇·1）。

## 二、工具渲染（`webui/src/tools/registry.ts` + `StepRow.tsx`）

模型面新增 10 个工具（本批复活），补 LABELS 与主参数：

| 工具 | 展示名建议 | 主参数 |
|---|---|---|
| `task_create` | 创建任务 | `title` |
| `task_claim` | 认领任务 | `task_id` + `action`(claim/release) |
| `task_update` | 更新任务 | `task_id` + `action`(add_dependency/attach_artifact/set_acceptance) |
| `task_close` | 关闭任务 | `task_id` + `action`(complete/close/cancel) |
| `task_list` | 列出任务 | `state?` |
| `board_channel_create` | 创建频道 | `name` |
| `board_thread_create` | 创建话题 | `title` |
| `board_post` | 留言 | `thread_id`（body 进二次折叠） |
| `board_subscribe` | 订阅留言 | `target_kind` + `action`(subscribe/unsubscribe) |
| `board_list` | 查看留言 | `channel_id?`/`thread_id?` |

工具**输出**形状（注意与 `/team` 的 TaskView **不同形**，别混用解析器）：
`task_*` 输出 `{task: TaskBoardTask}` / `{tasks: [TaskBoardTask]}`，其中
`TaskBoardTask.owner` 是 **string**（agent path，非 TeamActor）、
`artifacts[].content_id` 是 **string**（非 ContentRef）、无
`description_ref`/`created_by`。`board_post` 输出
`{post, notified: string[], skipped: [{agent, reason}]}`。
display 投影 header 为 `tasks`/`board`（`ToolHeader::Other`），summary 已带
`task_id [state] epoch=N` 文本，折叠行可直接用。

`spawn_subagent` 入参新增可选 `mode: "fresh"|"fork"`（缺省 fresh）。
Subagent 展示行建议：fork 时加徽标（如「继承历史」）。其余四件
（send_message/wait_agent/list_agents/interrupt_agent）形状不变。

## 三、Timeline：终态合流消息与 fork 子会话

### 1. 终态通知卡（父会话 timeline）

子级回合终态后，父会话 timeline 出现 `TimelineEntry::Input`（kind=`input`），
携带：

```jsonc
{
  "inter_agent": {/* InterAgentEnvelope，署名子级 */},
  "subagent_terminal": {
    "child_session_id": "ses_…",
    "parent_call_id": "…",        // 关联父级 spawn_subagent 工具调用，可跳转
    "terminal": "completed|failed|cancelled|timed_out"
  },
  "content": {"inline": {"text": "运行时摘要（含子级最终答复）"}}
}
```

渲染要求：
- 系统通知卡样式（按 terminal 着色），**不要**渲染成子代理聊天气泡——
  正文是 runtime 陈述；子代理自己的话在子会话 timeline 里。
- `parent_call_id` 链接到 spawn 调用行；`child_session_id` 链接到子会话。
- 该 Input 会触发父级新回合（TriggerTurn），父模型答复紧随其后——通知卡
  与后续 assistant 块是因果关系，别折叠成两条无关消息。

### 2. fork 子会话的「重复历史」

`mode:"fork"` 的子会话 bootstrap/timeline 含父级已完成回合的种子块：
**内容与父会话相同，block/turn/call id 全部是新的**，`created_at_ms` 早于
子会话创建时间。这是设计内无损继承，不是 bug。可选：子会话视图顶部加
「继承自父会话 N 个回合」横幅（判据：首个块 created_at_ms < 会话 created_at）。
fresh 子会话无此现象。

## 四、wire `subagent.spawn`（如有手动 spawn UI）

后端修复了两处实测缺陷（`a99dcab3`），此命令现在可用：
- target **必须** `Session{session_id: 父会话}`（此前信封分类与 handler 互斥永拒）。
- command：`{type:"subagent.spawn", tools?: string[], selection?: {provider_id, model_id, options?}, workspace?: string}`；result：`{session_id: 子会话}`。
- 缺省名 `sub_<id前12位小写>`；tools 空 = 无会话级限制（STANDARD）。
- 信封 `contract_revision` 必须与 daemon 一致（当前 -9，Goal 批次）。建议
  open 握手 426 时按 daemon 声明协商，别硬编码（后端冒烟脚本即此策略）。
- 注意：wire spawn 恒 **fresh**（冻结命令不带 mode）；fork 只经工具面。

## 五、未落地（v3.1 规划，不要施工）

- **writeScopes**：`TeamTaskSnapshot` 将增提示性写作用域前缀字段 + 重叠警告
  （wire 实变，搭 v3.1 切线）。UI 可预留 scope 列位，形状未定，别按猜测实现。
  当前 scope 纪律由 team:policy 提示词承载（title/acceptance 文本）。
- Team 根开关：goal 工具已按根会话条件注册（ADR-0015 ROOT_TOOL_REGISTRARS）；
  task 工具仍全注册（板按根树共享，lead/子级同权），本批无开关 UI。

## 六、验收清单

- [ ] Team 页渲染任务 DAG/状态/owner/claim_epoch/acceptance；task_* 工具完成触发 refetch
- [ ] 10 个新工具中文标签 + 主参数；输出解析区分 TaskBoardTask（工具）vs TaskView（/team）
- [ ] 终态通知卡归因正确（系统卡，非子级气泡）；parent_call_id/child_session_id 可跳转
- [ ] spawn_subagent fork 徽标；fork 子会话历史继承不报「重复」错
- [ ] 零 TeamDelta 订阅代码；花名册精确状态走 session.list
- [ ] 手动 spawn（如有）用 Session target + 代际协商

对位文档：`goal-mode-frontend-2026-11-13.md`（同批次，契约增量在那边）、
`docs/handoff-fork-frontend-2026-11-10.md`（handoff 文档 fork，与本批上下文 fork 并存）。
后端疑问查 `docs/adr/0014-subagent-as-session.md`（落地清单 A–G 全勾，含冒烟证据与并发留痕）。