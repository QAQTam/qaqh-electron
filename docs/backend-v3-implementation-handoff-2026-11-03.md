# Backend v3 协议缺口实施与分工说明

日期：2026-11-03

依据：[协议影响清单](./backend-v3-protocol-impact-2026-11-03.md)

基线：`qaqh-backend` HEAD `b144398d`，检查时工作树干净。

## 目标

关闭影响清单中的 B01–B09，形成可供 SDK / Electron 生成并消费的稳定契约，并通过后端定向测试、契约导出检查和隔离 daemon 联调。

本文是给实现者的拆分建议，不代表已经修改后端。契约类型必须由 backend exporter 生成，不能在 SDK 或 Electron 另造一份长期权威类型。

## 工作量估算

| 范围 | 手写后端实现 | 测试 / fixtures | 主要成本 |
| --- | ---: | ---: | --- |
| B01 水位与快照衔接 | 120–220 行 | 100–180 行 | 需要先定水位语义，再保证快照与订阅边界没有漏帧或重复副作用 |
| B02 driver 路由覆盖 | 10–30 行 | 20–40 行 | 主要修正 coverage 和端点声明；统一 driver 命令已有实现时不应新增旧 URL |
| B03 工具声明与块类别 | 90–180 行 | 70–120 行 | 增加实时声明信息并贯通 owner、session loop 和契约事件 |
| B04 快照与元数据事件 | 80–170 行 | 60–100 行 | 用真实数据填充现有 snapshot 字段，并接通产品确实需要的事件 |
| B05 同步命令结果回放 | 100–210 行 | 100–180 行 | 扩展 receipt 的结果保存、持久化、status 与同 ID 重放 |
| B06 设置目录与 profile 语义 | 120–280 行 | 80–150 行 | 先裁定 provider/model selection 与 legacy profile 的关系，再实现并发修订检查 |
| B07 握手契约代际 | 20–50 行 | 20–40 行 | 在 open 响应加入/校验命令契约代际，更新 exporter fixture |
| B08 缺失 service DTO | 100–220 行 | 80–150 行 | 多数 service 入口已存在；工作集中在权威 DTO、ServiceMap、coverage 和 fixtures |
| B09 运行中进度恢复 | 150–280 行 | 100–180 行 | 若要求断线后无回撤，需要在 snapshot 中维护并恢复运行中的增量状态 |
| **总计** | **约 800–1,650 行** | **约 600–1,150 行** | 粗略估算；包间共享类型会造成重叠 |

按一位后端工程师串行实现并完成定向验证，预估 **10–18 个工程日**。代码行数不含 exporter 自动生成的 SDK/WebUI 类型与镜像文件。大致会涉及 15–25 个手写 Rust 源码、测试或 exporter 文件；生成产物数量取决于最终新增的 DTO 与事件字段。

最大不确定性是 B01 的并发边界、B06 的 profile 产品语义，以及 B09 是否承诺恢复未封存的流式进度。先裁定这三项，可显著降低返工。

## 建议实施顺序

保持一个主实现分支和单一整合者。多个帮手可先并行做只读审查、测试案例整理或独立方案评审；涉及公共 contract、events、pending receipt、exporter 的代码修改不要同时落在共享工作树。

| 阶段 | 工作包 | 依赖 / 输出 |
| --- | --- | --- |
| 0 | 契约决策 | 书面确认 B01 水位定义、B05 receipt 内容与保留语义、B06 profile 策略、B03 事件字段、B04 实时能力范围、B09 进度恢复要求 |
| 1 | B01 | 固定序号边界和 bootstrap/SSE 连续性；这是 SDK 去重与重连的基础 |
| 2 | B05、B06 | 分别完成命令结果恢复与配置目录行为；B06 需要先有产品决定 |
| 3 | B03、B04 | 接通工具声明和 snapshot/event 数据来源；字段先冻结再导出 |
| 4 | B09 | 依赖 B01 的水位定义和 B03 的事件形状；实现进度尾窗或明确损失语义 |
| 5 | B02、B07、B08 | 校正 coverage、补握手代际与 8 个 service DTO；在契约变化稳定后统一导出 |
| 6 | 集成 | exporter check、生成 SDK/WebUI 类型、客户端类型检查、隔离 daemon HTTP/SSE 验收 |

建议单独锁定的产品 / 契约问题：

1. **B01 水位：** `seq` 表示“已覆盖序号”还是“下一序号”。选定后统一 snapshot、SSE `id`、`since_cursor` 和缺口判断；不要让客户端猜边界。
2. **B05 receipt：** 同步命令的 `result`、`operation`、`revision` 哪些需要持久化和重放；确认敏感结果的落盘边界、TTL、容量与身份隔离。
3. **B06 profiles：** 选择继续支持 legacy profile create/list/delete（不承诺 update），还是将该 UI 能力退场；明确它与 `providers.toml`、`default_model_selection` 的关系。
4. **B03/B04：** 确认是否承诺实时工具名/args、reasoning/answer 区分、子代理与 driver 变化；若不承诺，明确依靠现有查询和写后刷新。
5. **B09：** 决定 resync 是否必须恢复仍在运行的累计文本、工具参数和 stdout/stderr 尾窗。若允许丢弃，协议与 UI 必须明确以新 bootstrap 覆盖旧暂态。
6. **B07：** 建议 open 响应明确给出 `command_contract_revision` 并由 SDK 校验；如选择发布门禁替代，则必须由构建/发布链阻止新旧代际混装。

## 按缺口分派

### B01：水位与 bootstrap / SSE 原子边界（P0）

**当前观察：** `SessionOwner::current_seq()` 读取 `next_seq`；事件用 `fetch_add` 返回旧值；snapshot 在异步读 DB 后才读取序号。SSE handler 再按 cursor 判断是否需要 resync。

**主要源码：**

- `crates/qaqh-session/src/owner.rs`：`current_seq`、`snapshot`、`emit`
- `crates/qaqh-session/src/db/view.rs`：`load_session_state`
- `crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs`：bootstrap 与 events handler
- 测试：`crates/qaqh-session/src/owner_tests.rs`、`crates/qaqh-agent-runtime/src/session_loop_tests.rs`

**完成条件：** 并发写入与 bootstrap/subscribe 交错时无静默丢帧；相同 cursor 重连行为确定；旧 epoch、游标缺口和 lagged receiver 都能明确要求 resync。测试必须验证边界值相等的情形。

### B02：driver coverage 与真实路由（P1）

**主要源码：** router `crates/qaqh-daemon/src/axum_server/axum_impl/mod.rs`；命令 dispatch `crates/qaqh-daemon/src/axum_server/axum_impl/commands.rs`；coverage/exporter 来源。

**完成条件：** coverage 不再把不存在的 `/sessions/{id}/driver/claim|release` URL 标成已实现；真实支持面与 `driver.claim` / `driver.release` 命令一致；新增检查能在路由和 coverage 再次漂移时失败。

### B03：工具声明和 assistant block 类别（P1）

**主要源码：**

- `crates/qaqh-ringing-contract/src/events.rs`、`state.rs`
- `crates/qaqh-session/src/owner.rs`：`declare_tool_call`
- `crates/qaqh-agent-runtime/src/session_loop.rs`：provider progress 到 owner 的映射

**完成条件：** 活跃订阅者能拿到工具名和累计参数，且能分辨 reasoning 与 answer；bootstrap 和实时事件形状一致。事件必须保持有界，并定义字段的累计/替换语义。

### B04：snapshot 与产品事件数据（P1）

**主要源码：** `crates/qaqh-session/src/db/view.rs`、`crates/qaqh-session/src/owner.rs`、`crates/qaqh-runtime/src/session_meta.rs`、`crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs`，以及实际拥有 subagent/driver 状态的 runtime 模块。

**完成条件：** `title`、`subagents`、`driver` 要么从权威数据源填入 snapshot 并持续更新，要么明确标为非实时能力并由客户端使用已有查询/写后刷新。不要仅为填字段添加推测状态。

### B05：命令同步结果恢复（P0）

**主要源码：**

- `crates/qaqh-ringing-runtime/src/pending_store.rs`
- `crates/qaqh-ringing/src/v2/types.rs`
- `crates/qaqh-daemon/src/axum_server/axum_impl/commands.rs`、`command.rs`、`v2.rs`
- 测试：`crates/qaqh-ringing-runtime/src/pending_store/boundary_tests.rs`、daemon command/status tests

**当前基础：** receipt 已保存状态和有限的交互结果类型，但不能恢复一般同步操作返回的 session ID、result 或 revision。

**完成条件：** ACK 丢失后，对原 `command_id` 查询或重放能恢复契约承诺的原结果；同 ID 不同 payload 仍被拒绝；TTL、驱逐、身份范围和 best-effort 持久化边界有测试；不能把 `succeeded` 伪装成缺失的 result。

### B06：设置目录和 profile 行为（P0）

**主要源码：** `crates/qaqh-runtime/src/service_methods.rs`、`crates/qaqh-runtime/src/service/command.rs`、相关 service handlers、provider/profile/config 存储与 command dispatch。

**完成条件：** `provider.list`、provider/model 写操作和 `model.selection.set_default` 使用一致目录及 `config_revision`；`profile.list/create/delete` 的旧目录关系明确；不承诺不存在的 `profile.update`。覆盖 revision `0`、冲突、初次创建和删除/默认引用行为。

### B07：open handshake 契约代际（P1）

**主要源码：** `crates/qaqh-ringing/src/v2/types.rs` 的 open DTO、`crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs` 的 open handler、contract fixtures/exporter。

**完成条件：** 新客户端能在命令发送前识别不兼容的 command revision；兼容策略、错误码及旧客户端行为有测试。SDK follow-up 需校验新增字段。

### B08：8 个 service DTO 与 coverage（P1）

缺少 DTO 的方法：`config.load`、`diagnostics.memory.snapshot`、`plan.read`、`profile.list`、`session.dashboard`、`skills.list_tools`、`todo.list`、`todo.status`。

**主要源码：** `crates/qaqh-runtime/src/ringing/service_methods.rs` 及各方法参数/结果定义、`crates/qaqh-runtime/src/service/command.rs`、`tools/qaqh-contract-export/src/main.rs`、exporter artifact tests。

**完成条件：** 每个实际支持的方法都有权威 params/result DTO、ServiceMap 项和代表性 fixtures；真正不支持的项明确 pending。coverage 路径和幂等说明与实际 router / command guards 一致；生成结果由 exporter 产出，不手改 SDK/WebUI 镜像。

### B09：运行中进度的 resync 语义（P1）

**主要源码：** `crates/qaqh-session/src/owner.rs`、`crates/qaqh-agent-runtime/src/session_loop.rs`、`crates/qaqh-ringing-contract/src/state.rs`、`crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs`。

**完成条件：** 若承诺无回撤，bootstrap 必须携带当前运行回合的累计文本、工具参数和输出尾窗，并在终态后清理；重复事件不会重复追加。若产品接受丢失，则在协议/客户端验收中明确只恢复已提交状态，不能声称无损 resync。

## 全量验收门

- [ ] B01：bootstrap 水位、首帧相等边界、重连 cursor、epoch 变化和 receiver lag 有确定测试。
- [ ] B02：coverage 与 router/command surface 交叉检查，不再宣称旧 driver URL 可用。
- [ ] B03/B04：新建工具与运行中工具在 snapshot / SSE 上信息一致；实时状态来自真实 producer。
- [ ] B05：丢失同步 ACK 后用原 ID 恢复原结果；冲突 payload、过期、驱逐和身份隔离行为正确。
- [ ] B06：目录语义及 CAS 流程端到端覆盖，revision `0` 不是跳过检查。
- [ ] B07：新旧 contract revision mismatch 在 open 阶段给出明确拒绝。
- [ ] B08：36 个 service 方法覆盖表与实际实现核对；8 个 DTO 已补齐或以明确 pending 退出。
- [ ] B09：完成“运行中尾窗可恢复”或“明确允许丢失”二选一，并验证客户端按选定语义工作。
- [ ] 在 backend 根目录执行 `cargo run --locked -p qaqh-contract-export -- check --against ../qaqh-sdk/src/protocol/generated --release` 通过，随后验证 WebUI/SDK 生成镜像一致。
- [ ] 后端定向 crate tests 通过；在隔离数据目录做 HTTP/SSE 联调，不使用日常用户目录。
- [ ] 最终由 SDK/Electron 做类型检查和真实 daemon acceptance；旧测试记录不能替代新契约验收。

## 当前参考

- 后端静态基线与主要风险：[协议影响清单](./backend-v3-protocol-impact-2026-11-03.md)
- 事件与 bootstrap：[events.rs](../../qaqh-backend/crates/qaqh-ringing-contract/src/events.rs)、[state.rs](../../qaqh-backend/crates/qaqh-ringing-contract/src/state.rs)、[owner.rs](../../qaqh-backend/crates/qaqh-session/src/owner.rs)
- 命令 receipt：[pending_store.rs](../../qaqh-backend/crates/qaqh-ringing-runtime/src/pending_store.rs)、[v2/types.rs](../../qaqh-backend/crates/qaqh-ringing/src/v2/types.rs)
- exporter 与服务目录：[service_methods.rs](../../qaqh-backend/crates/qaqh-runtime/src/ringing/service_methods.rs)、[contract exporter](../../qaqh-backend/tools/qaqh-contract-export/src/main.rs)

