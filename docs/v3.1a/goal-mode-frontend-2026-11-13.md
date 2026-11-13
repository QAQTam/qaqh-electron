# Goal 模式前端施工单 —— 2026-11-13（v3.1a 批次）

后端来源：`qaqh-backend` ADR-0015（切片 A–F，代码已落后端工作区，待提交）。
本单是**契约增量施工**，不是零新增：命令 +3、事件 +1、DTO +4、配置段 +1、
`session.create` 参数 +1、命令面代际 **-8 → -9**。与 widget-directive 批次正交，
可并行施工，但**契约产物要一起重新生成**（两批都改了 RingingCommand/SessionEvent/
ConfigDto 的形状）。

对位文档：`docs/handoff-fork-frontend-2026-11-10.md`（handoff fork 已落地，
本单 §一·1 直接改它的 `forkHandoffSession`）。

---

## 〇、契约同步（先做，其余都依赖它）

1. 后端机器生成新产物（**不要**从 `docs/api-surface/v3.0` 抄——那是冻结金标准，
   本批增量还没切线进去）：
   ```
   cargo run -p qaqh-contract-export -- export --out <stage-dir>
   ```
   取 `types/qaqh/*` 覆盖 `webui/src/api/qaqh/*`。新增文件：
   `GoalView.ts`、`GoalStatus.ts`、`GoalsDto.ts`、`GoalsPatch.ts`。
2. **`COMMAND_CONTRACT_REVISION` = `ringing-commands-9`**。open 握手与命令信封
   都严格校验代际：仍报 `-8` 的客户端会被 daemon 当场拒（428/信封 validate）。
   前端 pin 的常量与夹具同步升。`SESSION_CONTRACT_REVISION` 不变（`ringing-session-2`，
   事件/读模型纯增量）。
3. **ConfigDto 无向前兼容**（该 crate 纪律：缺字段即解析失败）：`config.load`
   的返回现在必带 `goals` 段。前端类型与设置页必须与后端**同批上线**，否则
   设置页读配置直接挂。

---

## 一、P0：两条必做

### 1. handoff fork 传 `handoff_from`（goal 跨交接不断链的唯一接缝）

落点：`webui/src/tabs/store.ts::forkHandoffSession` 的 `session.create` 载荷。

```diff
 session.create {
   cwd, model_selection, tool_mode, custom_tools,   // 照旧抄 A 的 session.meta
   title,                                           // = work_summary，照旧
+  handoff_from: from_session_id,                   // 封箱机器面 JSON 里那个，已解析出来
 }
```

- `from_session_id` 就是你们去重键 `from|turn` 的 from——**现成的，不用新解析**。
- 语义：内核据此建立 **handoff 工作链**（`sessions.handoff_from_session_id`），
  goal 沿链解析：A 上建的 goal，B（及 B 再交接的 C）继续被同一个 goal 管理，
  用量跨链累计，自动续跑投到链头。
- **不传 = 链断**：goal 留在 A，B 不受管。内核不猜血缘（后端宪法 5），
  没有兜底推断，这条必须传。
- 命名辨析：`handoff_from` **不是** `parent_session_id`。后者是子代理血缘
  （subagent=会话），前者是交接工作链，两条边独立。你们 §六 等的
  「SessionCreate.parent 字段」以 `handoff_from` 的形式来了，但只解决交接链；
  侧栏 fork 徽标若要改读后端字段，见 §五·1（读侧导出还没做）。
- 次判据（`inferred:true` 推定封箱）路径：from 退回本地会话 id，照传。
- 去重/幂等/补投逻辑全部不变；`handoff_from` 只是 create 载荷多一个字段。

### 2. 代际升 -9 + 契约类型再生成

见 §〇。`RINGING_COMMAND_TYPES covers every generated RingingCommand variant`
那条双向覆盖测试会逼你们把 `goal.set / goal.get / goal.clear` 三个新变体接进
命令类型表——照 truncate 的先例接。

---

## 二、P1：goal 状态面（读 + 控制）

### 读侧

- **bootstrap**：`SessionState.goal?: GoalView`（缺席 = 无 goal；skip_serializing_if，
  不是 null）。链上任何会话的 bootstrap 都解析出同一个 goal（后端沿链上溯）。
- **事件**：`SessionEvent` 新变体 `goal_updated`：
  ```json
  { "type": "goal_updated", "goal": { …GoalView… } }   // 状态/用量变化
  { "type": "goal_updated", "goal": null }              // goal 被清除
  ```
  reducer 照 `driver_changed` 的先例：整字段替换，null 即清空。事件可能从
  **链根与当前会话两条流**都收到（后端双发），按 goal_id 幂等即可。
- 自动续跑回合会以 `actor.kind:"system"` 的 input 出现（正文以
  `<qaqh_goal_continuation goal_id="…">` 开头）——你们现有插话归约规则
  （api/system/agent/subagent → InterjectionStep）直接覆盖，**不要**渲染成用户气泡。
  建议标签读作「目标续跑」。

### GoalView 形状（snake_case，导出物为准）

```ts
type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
interface GoalView {
  goal_id: string;
  session_id: string;        // 链根会话（goal 行所在），不一定等于当前会话
  objective: string;
  status: GoalStatus;
  token_budget?: number;     // 缺席 = 无预算
  tokens_used: number;
  time_used_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}
```

### 控制侧（三条新命令，都走既有 `POST /ringing/v2/commands`，同步 ack.result）

| 命令 | 载荷 | ack.result |
| --- | --- | --- |
| `goal.set` | `{ objective?, status?, token_budget? }` 全可选 | `{ goal: GoalView }` |
| `goal.get` | `{}` | `{ goal: GoalView \| null }` |
| `goal.clear` | `{}` | `{ cleared: boolean }`（幂等） |

- `goal.set` 语义：给 `objective` = 无 goal 则创建（active）、有 goal 则改目标；
  只给 `status` = 状态迁移（无 goal 拒 `no_goal`）。`token_budget` 双层语义：
  缺席=不动，`null`=清除预算，数值=设置（>0）。
- **用户可控的状态**：`active`（resume）/ `paused`。`complete`/`blocked` 建议只读
  展示（那是模型审计后的声明）；`budget_limited`/`usage_limited` 是系统熔断，
  用户要恢复须 `goal.set` 调高/清除预算或等用量重置后再 resume。
- 拒绝码（`CommandRejection` 词表扩面，照 truncate 的 `CommandRejectedError` 分型）：
  | code | HTTP | 前端动作 |
  | --- | --- | --- |
  | `goal_exists` | 409 | 已有未完成 goal——引导先 complete/clear，别静默覆盖 |
  | `no_goal` | 404 | 无 goal——刷新状态面 |
- UI 建议：会话头部 goal 徽标（status + objective 摘要）+ 详情卡
  （用量/预算/剩余，`tokens_used / token_budget`）+ 暂停/恢复/编辑/清除按钮。
  文案直显后端 message，不编。

### 设置页 goals 段（ConfigDto.goals / ConfigPatch.goals，camelCase）

```ts
interface GoalsDto { enabled: boolean; maxTokenBudget: number | null }
interface GoalsPatch { enabled?: boolean; maxTokenBudget?: number | null }
```

- `enabled` 缺省 true（后端产出侧语义）。
- `maxTokenBudget`：`null` = 无上限；patch 里**缺席=不动，null=清除**（K3 的
  有意例外，后端已注明）。输入 0 会被 validate 拒（必须 >0）。
- 这是全局配置，不是 per-goal；per-goal 预算在 `goal.set` / 模型 `create_goal`。

---

## 三、P2：模型工具卡（可后补）

模型面新增三工具（仅根会话声明）：`create_goal` / `update_goal` / `get_goal`。
工具卡照现成注册机制接：

- display：`ToolHeader::Other { label: "goal" }` + `ToolBody::Text`（summary 已是
  「goal Active — objective (tokens n/m)」形状），`tools/presentation.ts` 加 `goal` 档。
- `update_goal` 的 args 只有 `status: "complete"|"blocked"|"paused"`——卡片可以
  把三态渲染成明确标签（完成/受阻/暂停）。
- `create_goal` 成功即意味着自动续跑开始：随后会出现 system 续跑回合（§二），
  用户没有输入却在跑——UI 必须能解释这个状态（goal 徽标 active + 续跑插话行）。

---

## 四、语义备忘（写 UI 文案前必读）

1. **取消不暂停**（所有者拍板 Codex 原样）：用户 cancel 一个续跑回合，goal 仍
   active，空闲还会续跑。要停必须显式 pause。别把 cancel 按钮文案写成「停止目标」。
2. **空转保险**：连续 3 个自动续跑轮空回复 → 后端自动 blocked；回合失败 → blocked。
   blocked 不是错误，是「需要人看一眼」——resume 后审计重新计数。
3. **预算熔断在回合边界**：budget_limited 到达时当前回合已收尾，不会 mid-turn
   打断；下一轮不再自动续跑。
4. **goal 跨 handoff 存活**的前提是 §一·1 传了 `handoff_from`；封箱到 fork 之间
   goal 处于「等待后继」（后端扫描日志可见），fork 后自动接上。
5. 用量是后端记账的权威值（终态 usage 累计），前端不要自己算 token。

---

## 五、后端还没做的（不要等，也不要替后端补）

1. **读侧血缘导出**：`SessionMeta` / `SessionListEntry` 尚未导出
   `handoff_from_session_id`。你们 §六 的本地账本（`parentSessionOf`）**本轮继续用**；
   要退役账本改读后端字段，向后端提一条 v3.1 批次增量（一个字段的事，但要走
   refreeze 记账）。
2. **mid-turn 预算 steer**：v1 只在回合边界记账熔断，运行中注入收尾提示留后续切片。
3. **真机端到端**：后端定向测试全绿，但「起 daemon + 真模型跑 goal 续跑 + handoff
   接链」的运行半边没跑——与你们 §八 的运行半边合并做一次即可。

---

## 六、自测清单（照你们既有测试风格）

- [ ] `forkHandoffSession` 载荷断言加 `handoff_from === from_session_id`
      （含 inferred 路径）；去重/补投回归不变。
- [ ] 命令类型双向覆盖测试纳入 goal 三变体；revision 夹具升 -9。
- [ ] reducer：`goal_updated` 替换/清空；bootstrap `state.goal` 缺席=无；
      链根/当前会话双流幂等。
- [ ] system 续跑 input 渲染为插话行（不是用户气泡），实时与 bootstrap 同律。
- [ ] goal.set 拒绝码分型：goal_exists→409 引导、no_goal→404 刷新。
- [ ] 设置页：goals 段读写；maxTokenBudget null=清除、0 被拒；
      ConfigDto 缺 goals 段解析失败（无向前兼容）有一条负例。
- [ ] 运行半边（真 daemon）：A 建 goal → 推到 handoff → B 自动接续跑 →
      B 上 goal.get 与 A 同一个 goal_id、tokens_used 累计。