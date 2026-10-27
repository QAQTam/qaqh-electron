# Electron 用户交互语义与验收

本清单对应本地 Ringing v2 admin 宿主，不是新的后端 API。实现入口为
`src/main/approvals.ts`、`src/main/challenges.ts`、`src/main/ipc-handlers.ts` 和
`src/main/ringing-client.ts`。前端仍使用 `pending_approvals` / `respond_approval`。

## 1. 名称与职责边界

- **`ask`** 是当前后端注册的提问工具名；`ask_user` / AskUser 是历史名称、模块名和领域交互称呼。
  参数为 `questions: [{id?, question, options?: string[], allow_custom?}]`，旧单问参数仍由后端归一化。
  它是需要用户回答的信息交互，不是权限提升。
- **request permissions / 请求授权** 在当前后端工具注册代码中没有名为
  `request_permissions` / `request_permission` 的独立工具。权限引擎在工具调用需要确认时产生
  `pending_permission`，Electron 展示它并发送 `tool_permission_respond`。
  不应为此凭空添加 `approval_decision` 或把普通聊天回复解释为授权。
- **plan review** 是独立的用户决策，不能与 Ask 答案或工具授权互换；正文可能是
  `review_type=plan`，也可能是 `todo_activation`。
- 上述授权不是 Chromium 的摄像头/麦克风/通知权限，也不是操作系统提权或管理员密码对话框。
  这些宿主/系统能力不由本次 Ringing 审批命令提供。

后端来源：`../qaqh-backend/crates/qaqh-workspace/src/ask_user.rs`（`AskArgs` / `AskTool`）、
`crates/qaqh-domain/src/interaction_body.rs`、`crates/qaqh-domain/src/command.rs`。

## 2. 决策映射（封闭集合）

| 展示类型 | 前端 decision | 正规命令 | 语义 |
| --- | --- | --- | --- |
| `ask` | `submit` | `control / interaction_ask_respond` | 使用 `interaction_id` 和 `answers: [{question_id, answer}]` 回答当前整组问题 |
| `ask` | `dismiss` | `control / interaction_ask_dismiss` | 撤销悬挂 Ask，并中止当前回合；**不是留空回答后继续** |
| `tool_permission` | `approve` | `tool / tool_permission_respond` | `approved=true, trust_folder=false`，只允许这次待执行工具调用 |
| `tool_permission` | `reject` | 同上 | `approved=false, trust_folder=false`，拒绝工具并把拒绝结果交给后端；**不等于取消整个回合** |
| `tool_permission` | `trust` | 同上 | `approved=true, trust_folder=true`，允许本次并让后端记住对应资源的目录信任 |
| `plan` | `approve` | `control / plan_review_respond` | `approved=true`，透传可选 `message` 和布尔 `autonomous` |
| `plan` | `reject` | 同上 | `approved=false`，可带修改意见；**不等于 Ask dismiss** |

### Ask

- 宿主校验答案数组、非空字符串、非重复 question id；不允许任意对象或额外命令字段穿透。
- 问题是否全部回答、选项是否有效、是否允许自由答案，以后端当前问题集为最终权威。
- 后端可能顺序挂起多个 Ask；回答一个后可能展示下一个，不代表所有交互已完成。
- 自由答案 `"拒绝"`、`"不执行"` 仍只是答案文本，不能替代工具权限的 `reject`。

来源：`../qaqh-backend/crates/qaqh-runtime/src/agent/engine_turn.rs`
（`handle_ask_response`、`validate_answers`、`handle_ask_dismiss`）。

### 工具授权与目录信任

- 用 `pending_permission.tool_call_id` 应答，不能拿 `pending_interaction.id` 冒充 tool-call id。
  如果 ask/plan 槽意外出现 `kind=permission`，宿主拒绝该响应形状，而不猜测其身份。
- `trust` 不是全局 `skip-permissions`，也不是给任意 shell/network 操作永久放行。
  当前后端根据该次请求的资源，将资源父目录加入持久化信任集；是否自动批准后续调用仍由权限引擎判定。
- 是否需要审批由后端裁决，Electron 不根据工具名再推导一份策略：`ask` 本身自动通过工具权限门禁，
  防止“提问之前再问一次是否允许提问”的递归弹窗；敏感会话文件与 skill 指令写入则有专门守卫，
  不能因为全局 skip-permissions 就在宿主静默放行。exec 自动放行还取决于实际沙箱后端，
  不能把“工作区内执行”或一个只读命令分类标签等同于已经获准。
- Electron 不自行修改全局权限档位，不自行执行被授权的工具，也不自动重新提交被拒绝的调用。
- 审批 details 仅放行 `tool_name/action_summary/reason/paths/category/level/risk/consequence`；
  `tool_call_id`、`details_unavailable` 和未知扩展字段不进入审批卡 details。
  此约束仅针对审批卡视图，不声称所有投影事件都隐藏 canonical id。

来源：`../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/challenge.rs`、
`crates/qaqh-runtime/src/agent/engine_tool.rs`（`handle_permission_response`）、
`crates/qaqh-workspace/src/authorization.rs`（`trust_folder`）、
`crates/qaqh-permission/src/permission.rs`（`needs_permission` / `TrustedFolderSet`）。

### Plan / autonomous

- `autonomous` 必须是布尔值，默认 false；字符串 `"false"` 不可按 truthy 转成 true。
- 后端当前 Goal 自动执行能力处于冻结状态：批准普通计划且 `autonomous=true` 只得到对应的
  工具结果指引，不会开启一个由 Electron 实现的自动执行器。
- `todo_activation` 即使批准，当前后端也会返回 Goal 暂不可用；不能把按钮/ACK 成功当成 Goal 已启动。

来源：`../qaqh-backend/crates/qaqh-runtime/src/agent/engine_turn.rs`
（`handle_plan_response` 的 todo activation 和 plan review 分支）。

## 3. Challenge、会话与确认结果

1. Electron 使用本地 admin 凭据读取两个独立槽位：permission + ask/plan，随后签发本地随机
   64-hex challenge。SDK `respondApproval()` 的 **device** challenge 端点不是本地 challenge 的提交入口。
2. Challenge 绑定 `(session, kind, canonical id, details)`；内容未变且未过期时复用，TTL 为 5 分钟，
   全局最多保留 16 个。内容变化、成功读取确认已消失或过期后，旧 challenge 失效。
3. Challenge 在校验决策/提交命令之前一次性消费。失败、拒绝后前端必须重读 pending 获取新 challenge，
   不能重复点击重放原 token；跨会话提交不能消费另一会话的 challenge。
4. 应答的信封 `session_id` 来自已存 challenge；不会因当前标签切换而改投活动会话。
5. 不随交互应答发送 driver epoch，也不为回答问题强行 claim driver。
6. ACK `accepted` 仅表示命令被接受，**不代表工具执行成功或 pending 已清空**。
   最终状态来自重新读取 approvals 和后续投影。`rejected` 会经 IPC 抛错。
7. 超时结果未知时，适配器先按 SDK command id 查询；确定执行失败不会伪报成功。
   无法确定时保留 `outcome_unknown` 错误，不自动重放用户决策。
8. approvals 读取错误会拒绝 IPC、记录日志并发 `conn://error`，不会伪装为空列表撤掉原卡；
   是否显示 toast 仍取决于 renderer 的诊断订阅。bootstrap 读取错误同样不再伪装成 `{}`。

## 4. 订阅与恢复

- Session 投影和 timeline 两路订阅都 live 才报告 `open`；任一暂停/关闭不能继续假报在线。
- 可恢复 cursor/epoch/snapshot/缓冲 reset 延迟调用 SDK `SessionWatch.resync()`，按
  250/500/1000 ms 最多尝试三次；收到实际投影事件后重置次数。
- 重新 bootstrap 通过 `projection://reset` 通知 renderer 重建 approvals/activity 等派生状态。
- `upgrade_required`、未知事实、跨会话等非恢复白名单原因，以及 `stream_terminated`，保持暂停并报错，
  不做无限重试。用户可使用现有连接重试入口。
- 切换会话/关闭时取消恢复定时器；过期 attach 的快照和旧订阅回调不得覆盖新会话。
- 普通前端 attach 保留现行 `session_resume` 路径以支持历史根会话；本次不改变为全局只读
  `session_attach`。后端两者语义不同，尤其子代理只读观察场景，后续应有单独宿主 API 和验收，
  不能通过改一个命令名顺带改变会话生命周期。

## 5. 测试与剩余验收

`pnpm test` 运行所有 `scripts/*.test.mjs`：

- `interactions.test.mjs`：真实宿主模块 + Electron/SDK 边界替身，覆盖七类决策、非法载荷、会话作用域、
  Challenge 生命周期、拒绝结果、恢复上限与 attach 竞争。
- `interaction-wire.test.mjs`：真实宿主 + 已安装 SDK，fetch 使用内存替身，检查 HTTP 路径、认证头、
  信封/命令双层 channel、session、正规命令字段；另用真实 SDK SSE decoder 验证 reset → bootstrap → 继续事件。
- `packaging.test.mjs`：打包、preload 与服务白名单防护。

上述测试不启动真实 daemon、不会调用模型、不会向用户目录写信任规则，也不是 GUI 自动化。
发布前仍应在隔离数据目录中手工验收：Ask 单/多问与 dismiss、工具 approve/reject/trust、plan 两种决策、
回答期间切标签、等待中重连、daemon 重启以及过期/重复应答；确认卡片、提示和后端终态一致。

前端剩余注意项：`PlanCard` 目前主要展示 `plan_content`，`todo_activation.todo_items` 的专门展示不属于本仓修复；
Ask 卡重挂时保留草稿依赖 renderer 的签名/状态实现，稳定 challenge id 不等于已验证全部焦点与倒计时行为。
