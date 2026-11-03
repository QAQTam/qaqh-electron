# Backend v3 协议变化与 Electron / SDK 改造清单

盘点基线：2026-11-03。第 1–3 节和后端风险项记录最初盘点；第 4–8 节同时记录之后在 SDK 与 Electron 工作树中的实施和验证。后端工作树保持只读且干净，B01–B09 未由客户端改动解决。

本轮续作清除了 WebUI 工具展示的旧 display/status 兼容层，并把压力与布局夹具切到 v3 事件帧。此轮修改尚未重新运行类型检查、测试或浏览器验收；第 8 节中先前通过的记录均早于这些修改。

## 1. 结论与分析基线

**SDK 与 Electron 已按 `ringing-commands-6` 完成主要本地协议迁移；当前工作树仍不能视为完整 v3 验收。** 先前的 SDK / Electron / WebUI 检查曾通过，但本轮工具状态、diff 展示和夹具改动尚未重验。后端水位、同步结果恢复、设置目录等问题仍需处理，真实 daemon 与最终桌面包也尚未验收。仅通过客户端模拟不能关闭这些门槛。

| 仓库 / 产物 | 本次看到的状态 | 含义 |
| --- | --- | --- |
| `qaqh-backend` | HEAD `b144398d7a58aba1119bd72bc4d8880f8745ba82`，工作树干净；版本 `3.0.20261103-1` | 本次 SDK 导出和 contract check 使用的后端基线 |
| `qaqh-electron` | HEAD `cc2e7865bbb9f757e2c3c9a93ebfa2c6b54adfcd`；包含本次协议迁移修改 | 主进程、IPC、WebUI 和校验脚本均已更新；尚未做最终桌面打包 |
| `qaqh-sdk` | HEAD `40a17b85d3fd7b5f09817be22b56759f7d105886`；保留未提交 core / generated / test 修改 | SDK 已按当前 backend exporter 生成并 build，未覆盖其他修改 |
| SDK generated manifest | `backend_version=3.0.20261103-1`，`source_revision=b144398d7a58aba1119bd72bc4d8880f8745ba82`，`source_dirty=false` | 来源与干净的后端基线一致 |
| SDK generated 常量 | `COMMAND_CONTRACT_REVISION="ringing-commands-6"` | 与本报告的后端命令契约一致 |
| SDK contract hash | `12aa79ef827e69d2ef1bb1f3010507927d1781635b66dd48f585e9989f302a98`；exporter check 与 SDK manifest 测试通过 | 生成产物匹配该后端 revision；不代表后端行为缺口已修复 |
| Electron SDK 依赖与 WebUI 类型 | `node_modules/@qaqh/sdk` 使用邻接 SDK；205 个 WebUI 生成类型与 SDK 的 205 个类型文件逐字节一致 | SDK `dist` 已重新 build；镜像漂移检查通过 |

主要破坏性变化是：

1. 命令从“旧三频道命令 + UnifiedCommand + service 写操作”收敛为**一个 `RingingCommand`、一个 `RingingV2CommandEnvelope`、一个 POST `/commands`**。
2. 读取从 `ClientV2Bootstrap.control/conversation/tool` 和多层投影 delta 改为 **`SessionBootstrap.state: SessionState` + 扁平 `SessionEventFrame`**。
3. SSE 游标从 JSON envelope 的 `cursor` / `snapshot_cursor` 改为 SSE `id: epoch:seq`；缺口通知改成 **`ringing.resync_required`**，且当前后端没有历史事件回放尾。
4. 设置写入必须携带 `settings_revision`；provider/model/default selection 写入必须携带 `config_revision`。
5. `ContentRef` 改为规范 hash 字符串，发送附件不能再使用旧 `{content_id,media_type,sha256,truncated}` 对象。
6. 工具展示、压缩进度、业务失败通知等旧投影能力不再等价存在，需要删除旧消费逻辑，并把后端尚缺的数据单列处理。

后端完整公开目录为 **44 个命令、36 个 service 方法、13 种 SessionEvent**，附录逐项列出。ServiceMap 当前仅类型化其中 28 个 service；另外 8 个方法有实际入口，不能将导出标记 `pending` 理解为后端没有实现。

## 2. 契约真源与主要证据

下列路径相对于本 Markdown 所在的 Electron `docs/` 目录。行号用于定位本次基线，后续修改后可能移动。

| 范围 | 权威来源 |
| --- | --- |
| HTTP 实际端点 | [backend router](../../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/mod.rs)，`build_router`，约 115–160 行 |
| 44 个命令及 payload | [command.rs](../../qaqh-backend/crates/qaqh-ringing/src/command.rs)，`RingingCommand`，47 行起 |
| 目标、前置条件、代际和校验 | [v2/types.rs](../../qaqh-backend/crates/qaqh-ringing/src/v2/types.rs)，`CommandTarget` / `CommandPrecondition` / `RingingV2CommandEnvelope`，21 行起 |
| 命令权限、同步结果、CAS | [commands.rs](../../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/commands.rs)；[旧文件名 command.rs 中的执行入口](../../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/command.rs) |
| 快照及工具 / 交互状态 | [state.rs](../../qaqh-backend/crates/qaqh-ringing-contract/src/state.rs) |
| 事件词表及帧 | [events.rs](../../qaqh-backend/crates/qaqh-ringing-contract/src/events.rs) |
| bootstrap、SSE、审批 | [daemon v2.rs](../../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs)，bootstrap 约 142 行；SSE 约 537 行 |
| 服务目录与 DTO | [service_methods.rs](../../qaqh-backend/crates/qaqh-runtime/src/ringing/service_methods.rs)，`TYPED_METHODS` / `METHODS`；[账户 DTO](../../qaqh-backend/crates/qaqh-runtime/src/ringing/service_methods/accounts.rs) |
| 正确的新命令客户端参考 | [Rust client v2.rs](../../qaqh-backend/crates/qaqh-client/src/v2.rs)，`send_command_v2_typed`，256 行起 |
| 当前 SDK 错配入口 | [SDK core](../../qaqh-sdk/src/core/index.ts)，`submit` / `submitChannel` / `watchSession`；[旧生成契约](../../qaqh-sdk/src/protocol/generated/index.ts) |
| 当前 Electron 错配入口 | [主进程 adapter](../src/main/ringing-client.ts)、[IPC](../src/main/ipc-handlers.ts)、[approvals](../src/main/approvals.ts) |
| 当前 renderer 错配入口 | [transport](../webui/src/lib/transport/backend.ts)、[store](../webui/src/session/store.ts)、[reducer](../webui/src/session/reducer.ts)、[projection](../webui/src/session/projection.ts) |

本题是本地私有协议与代码对照，没有依赖第三方库的新 API 用法；协议结论直接来自当前源码。定位已先使用三个目录的 CodeGraph 状态：backend / Electron 使用了 `codegraph explore`，SDK 无 `.codegraph/`，直接检索。

## 3. 新旧 wire 对照

### 3.1 命令提交

当前 SDK 的 `submit()` 使用 `UnifiedCommandEnvelope`，缺少新信封必需的两个身份字段，仍发送旧代际和单个 `precondition`。`submitChannel()` 则直接请求后端已经删除的 `/commands/{channel}`。

目标 wire 示例：

```json
{
  "schema": "qaqh.Ringing",
  "version": 2,
  "contract_revision": "ringing-commands-6",
  "command_id": "调用方生成并在未知结果时保留的同一个ID",
  "client_instance_id": "SDK实例ID",
  "client_session_id": "open返回的租约ID",
  "target": { "kind": "session", "session_id": "ses_example" },
  "command": {
    "type": "session.settings.patch",
    "patch": { "effort": "high" }
  },
  "preconditions": [{ "kind": "settings_revision", "revision": 3 }]
}
```

- HTTP 仍需 Bearer 和 `X-QAQH-Client-Session-Id`。后端鉴权使用 header 中的 lease；信封中的身份字段也需要填写，不能因为已有 header 就省略。
- 命令 `type` 使用点分名，例如 `session.resume`、`conversation.send_message`、`tool.permission.respond`。不再携带 `channel`，会话目标只放在 `target`。
- `CommandTarget` 有 `global`、`session`、`workspace`、`exec_session`。虽然枚举存在 `exec_session`，当前 44 个命令没有以它作为必需目标的 kill 操作；exec kill 仍是单独 HTTP 端点。
- `preconditions` 是数组：`settings_revision` / `config_revision`，没有旧 `expected_revision` / `driver_epoch` variant。同类前置条件不能重复，revision 必须是 JS 安全整数。
- `RingingCommandAck.status` **仍只有 `accepted | rejected`**，不要引入 `completed`。同步完成操作以 `accepted` 返回 `result` / `operation` / 可选 `revision`。
- `commandStatus.state=succeeded` 对输入等引擎命令表示成功交给会话循环，**不表示模型回合已经完成**；回合终态看 `turn_ended`。
- TTL 300 秒、最多 4096 个 receipt、best-effort 持久化的策略仍在。超时 / 缺回执不能推导成“未执行”，不能生成新 ID 自动重做副作用操作。
- 新 SessionEvent 没有旧 `causation_id`；不能继续等某个可靠投影事件把命令回执推进到终态。

### 3.2 快照与事件

| 项目 | 当前 Electron / SDK 使用方式 | 后端当前契约 |
| --- | --- | --- |
| bootstrap | `control.state` / `conversation.state` / `tool.state` | `{schema,version,server_epoch,session_id,state}` |
| 会话正文 | `ConversationSnapshot.context` | `SessionState.timeline`，按 `TimelineEntry.kind/data` 分类 |
| 工具 | context 中旧 tool display / 旧 delta | `state.tools: ToolCallView[]`；timeline 通过 `call_id` 引用 |
| 活动 / 当前回合 | `control.state.activity` 等 | `state.activity` / `state.current_turn_id` |
| 交互 | `control.state.interactions`、`revision`、`expired_reason` | `state.interactions`；终态字段 `resolution`；实时结束事件带 `status` |
| SSE 数据 | 含 schema/version/session_id/stream_key/payload/cursor 的 envelope | `{seq, type, ...该事件字段}`；`SessionEvent` flatten 到顶层 |
| 游标 | bootstrap `snapshot_cursor`，event JSON `cursor` | bootstrap 的 `server_epoch` + `state.seq`；实时 SSE `id` |
| 重同步 | `ringing.reset_required` 和旧 reason 白名单 | `ringing.resync_required {session_id,reason}`，reason 当前为 `cursor_gap` / `stream_lagged` |
| 历史 / 重连 | 旧投影 replay / timeline page | owner 仅广播实时事件；有缺口重新 bootstrap |
| 内容引用 | 各处旧 `ContentRef` 对象及包装 | `ContentRef` 为 `"sha256:<hex>"` 字符串；`ContentValue` 仍是 `inline/ref/unavailable` 的 kind/data union |
| 团队响应类型名 | `ClientV2TeamResponse` | `TeamResponse`；schema 仍为 `qaqh.ringing.team/v1` |

实时示例：

```text
id: epoch-example:27
event: ringing.event
data: {"seq":27,"type":"message_delta","turn_id":"turn-example","block_id":"block-example","text":"截至目前的完整文本"}

event: ringing.resync_required
data: {"session_id":"ses_example","reason":"cursor_gap"}
```

`message_delta.text` 和 `tool_arguments_delta.text` 来自累计内容更新，应替换相应 block / 参数缓冲，不能反复 append 导致重复。`tool_output_delta.text` 才按 stdout/stderr 追加尾窗。正常 `TimelineAppended` 的 sealed block 与流式 block 使用同一个 `block_id`，必须合并。

**水位实现仍有后端缺口，见 B01。** 不要在没有解决 B01 前宣称实现了“快照水位以下全部忽略即可无缝续传”。

## 4. SDK 独立修改清单

以下全部针对 `../qaqh-sdk`，记录目标改造和验收点，不表示当前完成状态；实施记录与遗留项见第 7–8 节。P0 是基础链路阻断，P1 是产品能力或发布正确性。

| ID | 优先级 | 文件 / 范围 | 必须完成的修改及验收点 |
| --- | --- | --- | --- |
| S01 | P0 | `src/protocol/generated/**` | 用**当前 backend exporter**整体重新生成，保留用户的非 generated 修改；得到 `ringing-commands-6`，删除失效文件和引用，校验 manifest 全集、hash、source revision。禁止手改生成文件凑类型 |
| S02 | P0 | `src/protocol/index.ts`、`src/core/index.ts`、`src/index.ts` | 改为直接导出 / 引用 `SessionBootstrap`、`SessionState`、`SessionEvent`、`SessionEventFrame`、`TeamResponse`、`CommandTarget`、`CommandPrecondition`、`RingingCommand`、`RingingV2ResyncRequired`；删除 `ClientV2Bootstrap/Event`、Conversation/Control/Tool 泛型投影别名、Unified 类型和失效 OperationFailure API |
| S03 | P0 | `submit()`、`SubmitOptions`、target helpers | 改成唯一新信封；填写身份、代际、target、`preconditions[]`，保留 caller commandId；删除 `submitChannel()` 及频道编码。所有命令必须真正经过 `/ringing/v2/commands` |
| S04 | P0 | `createSession()` | 以新 `RingingCommand.SessionCreate` 构造参数，支持 `profile` / `effort` / `model_selection` / tools；消费 `{session_id}`；不额外重复创建或恢复；后端创建已经 attach 到当前 lease |
| S05 | P0 | `patchSessionSettings()` | 接受调用方读到的 `settingsRevision`，发送前置条件；支持契约现有的 `model_selection/profile/effort/mode/tools`，保留 `SettingValue<ModelSelection>` 的继承语义；返回新 revision，不能丢掉 ACK 中的版本 |
| S06 | P0 | provider/model/default selection helpers | 五种写操作都强制携带 `config_revision`；当前 `upsertProvider()` 完全没带、其他 helper 走旧 `expected_revision` 或 payload 字段，全部要改。不要用 `expectedRevision ? ...` 丢掉合法初始版本 0；不要把 0 解释成跳过检查 |
| S07 | P0 | `bootstrap()` / `watchSession()` | 校验并返回 `SessionBootstrap.state`；cursor 来自新水位及 SSE `frame.id`。停止读取 event JSON 中已不存在的 schema/version/session_id/server_epoch/cursor。epoch 校验放在 handshake / bootstrap / SSE ID 层 |
| S08 | P0 | watch reset / reconnect | 识别 `ringing.resync_required` 和两个新 reason；清理暂态、重新 bootstrap 再订阅，禁止按旧 reset 白名单漏处理后静默继续。保留 single-flight、abort、超时、退避。租约重开后处理 watch 的重新归属 / attach，尤其设备身份 |
| S09 | P0 | `SessionWatchHandlers` / `operationFailureOf()` | `onEvent` 改为 typed 新帧；从实际 SSE 名 demux；删除把 `payload.kind=operation_failed` 当现行协议的承诺。当前 13 种业务事件没有该事件，HTTP 错误和 turn/tool 失败要分开表达 |
| S10 | P0 | `errorFrom()`、`SdkError`、`submit()` | 明确的 HTTP 400/409/502 拒绝与“未收到结果”的传输中断分开；保留 commandId、code、message、retry_after_ms、existing、typed interaction result。当前非 401/403 都标 `transport`，会把确定的校验失败也描述成可能已接受 |
| S11 | P0 | `resolveOutcome()` / `waitForCommand()` / helpers | 不把 receipt succeeded 当回合 done；允许追踪带 commandId 的不确定传输错误；未知结果坚持同 ID / 同 payload / 同 guards。结果恢复的能力边界见 B05，不能仅凭 succeeded 假造 `session_id` 或 revision |
| S12 | P1 | `serviceCall()` / ServiceMap | 新生成表删掉 service 写方法；增加 typed `service<K extends keyof ServiceMap>` 或等价接口，使查询 / 账号调用使用真实 params/result。8 个尚未生成 DTO 的查询显式标记待补齐，不能重新放宽整个公开 API 为任意 string/unknown 来掩盖漂移 |
| S13 | P1 | `claimDriver()` / `releaseDriver()` | 当前 `/sessions/{id}/driver/claim|release` 已无路由。改发统一 `driver.claim/release`，payload 使用当前 lease ID；释放支持 `expected_epoch`。按新 ACK 表面设计返回值，不能照旧承诺专用 response；B02/B04 需先确认席位观测来源 |
| S14 | P1 | `uploadContent()` / 下载类型 | raw upload 响应仍是 `{content_id,media_type,sha256,size,truncated}`；将**原始响应与规范 ContentRef**分清，可提供显式转换/结果字段。发送附件使用字符串 hash。保留 multipart、body read timeout、AbortSignal、Range 读取 |
| S15 | P1 | `teamSnapshot()` / 端点覆盖 | 改为 `TeamResponse`；按 router 盘点补 `exec-sessions` list / kill（若 SDK 继续承诺完整 wire surface）。`/health`、`/activity`、control stop 的非业务端点单独登记。不要恢复 timeline URL |
| S16 | P1 | `connect()` / capabilities / node discovery | 删除旧 `drive` capability 依赖；仍校验 wire v2，验证 `single_stream`。wire version=2 并不能区分旧投影与当前协议；若需首连识别命令代际，需 B07 配套。`CONTROL_PROTOCOL_VERSION=1` 与 Ringing wire version / command revision 各有含义 |
| S17 | P1 | `src/core/sse.ts`、`test/client.test.mjs` | decoder 继续保留帧 ID，watch 开始真正消费它；用新 fixture 验证累计文本、seq、resync、换 epoch、断连、终止、字节级 keepalive。更新旧 snapshot_cursor / stream_key / reset 样本 |
| S18 | P1 | `test/package.test.mjs`、`scripts/acceptance.mjs`、README | coverage 断言必须与真实 router 交叉检查；剔除旧 timeline/频道/Unified 说明；验收脚本使用新 bootstrap 和 cursor。旧“11/11 通过”仅是历史记录，不能作为当前 v3 验收结果 |
| S19 | P1 | build / package exports / `scripts/fix-dist.mjs` | 重建 `dist` 并检查 JS + d.ts + manifest 同步、根/protocol/node 三个入口可消费；ESM fixup 继续适用。确认编译后的包没有旧投影别名、旧路由和旧常量 |

SDK 完成判据：

- [ ] S01–S11 所列基础对接完成，当前 backend 的真实命令和 SSE 可以连通。
- [ ] S12–S19 所列类型覆盖、工具方法、测试与产物同步完成；后端缺口有明确处理结果。
- [ ] 不再有 `submitChannel`、`UnifiedCommand`、`snapshot_cursor`、`stream_key` 等旧 wire 消费逻辑。

## 5. Electron 独立修改清单

### 5.1 主进程、IPC 与构建

本节和 5.2–5.3 记录 Electron 的目标改造与验收点；当前完成情况见第 7–8 节。

| ID | 优先级 | 文件 / 范围 | 必须完成的修改及验收点 |
| --- | --- | --- | --- |
| E01 | P0 | `webui/src/api/**`、`src/main/types.ts` | WebUI 与 main 使用同一份 backend exporter 产物 / SDK protocol；消除两份生成目录漂移。整体删除旧 Timeline/Projection/Unified 类型的活跃引用。WebUI 自己的展示模型可保留，不能重造旧 wire 转换层 |
| E02 | P0 | `src/main/ringing-client.ts` | `command()` 接收新 RingingCommand + CommandTarget + preconditions；删除 `submitChannel()`。`attach()` 改发 `session.resume` 或 `session.attach`（按是否需要拉起 worker 选择），目标只放 target；随后开始新 watch |
| E03 | P0 | `src/main/ipc-handlers.ts` 的 `command` case | 删除 9 项 Unified allowlist + conversation 名字翻译 + 其余一律 service 的三分支路由。业务写入全部走统一命令；查询/账户 RPC 走独立 typed service IPC。关闭宽泛 `{type:string,...}` 带来的假类型安全 |
| E04 | P0 | service IPC / renderer transport | **修复丢会话参数**：当前 `query({type:"session.meta"}, sessionTarget(seed))` 最终只传空 params，target 从未进入 serviceCall；`todo.list` 同样受影响。目标方案让 service params 明确包含 `session_id`，不再用伪 command target 隐式表达 RPC 参数 |
| E05 | P0 | main eventSender、preload、`desktop-host.ts`、`transport/electron.ts` | 新事件本身没有 `session_id`。main 必须用 watch 闭包中的 seed 包成宿主事件 `{session_id,event}`（或同等明确上下文）；renderer 再取 `event`。否则现有 subscriber 从帧上读 seed 得空串，事件全部被 store 的 seed 检查过滤。宿主事件名可保留，但 payload 类型必须改；两侧同时更新 |
| E06 | P0 | `normalizeAck()`、TransportBackend / ElectronTransport | 直接 ACK 的 result/operation/revision/existing 不丢；不确定状态恢复不能仅返回 `{accepted,command_id}` 冒充完整结果。IPC 要保留可识别的错误码、commandId、状态，供 CAS 冲突和未知结果展示。查询应直接返回 service result，不再伪造 ACK |
| E07 | P0 | `pending_approvals` / `approvals.ts` / `challenges.ts` | snapshot 检验改为 `bootstrap.state.interactions`；删除对 `control.state.revision` 和 `expired_reason` 的检查。permission 用 `call_id` 对应 `tool_call_id`，ask/plan 用 `interaction_id`；plan 的 wire kind 是 `plan`，不是当前代码的 `plan_review`。目前旧校验导致所有审批 view 无法 verified |
| E08 | P0 | `approvalCommand()` / `respond_approval` | `tool.permission.respond`、`interaction.ask.respond/dismiss`、`plan.review.respond` 改为点分命令，无 channel；通过唯一 submit。继续使用 host 一次性 challenge；未知结果只跟踪原 commandId；不能重复应答。保留后端 `existing` 对已有裁决的对账能力 |
| E09 | P1 | `native-dialogs.ts`、main/renderer upload 类型 | 返回明确的 `{content_ref, media_type, name, size, ...}` 展示对象，引用字段为 `sha256:<hex>` 字符串；不再将旧 upload 对象整体当 ContentRef。使用后端响应校验，不用本地 fallback hash 把坏响应装成成功 |
| E10 | P1 | `scripts/build-all.mjs`、justfile、SDK link | 当前流水线只 build SDK，**没有从 backend 导出或 check 契约**。加生成/一致性检查，再 build SDK→main→WebUI；严格校验类型/manifest/实际包。backend 与 frontend 都叫 3.0 不代表协议匹配 |
| E11 | P1 | daemon 启动 / updater / 错误页 | 后端 session SQLite schema=5，旧 schema 明确报 SchemaTooOld，旧 JSONL / workspaces.json 不迁移。把启动失败原因传给 UI；发布说明写清此破坏性变更；不要由 Electron 静默删用户数据。配对、stop、OS 权限归属按原职责继续 |

### 5.2 WebUI 的状态归约与呈现

| ID | 优先级 | 文件 / 范围 | 必须完成的修改及验收点 |
| --- | --- | --- | --- |
| E12 | P0 | `session/types.ts`、`reducer.ts`、`store.ts` | 用 `SessionState.turns/timeline/tools/interactions/current_turn_id/activity` 重写快照装载。旧 reducer 遍历 `snapshot.context`，现 `installBootstrap()` 因没有 `conversation.state` 直接 return，会永久不 hydrated |
| E13 | P0 | `session/projection.ts` / `applyProjection()` | 删除频道×delta kind 决策表，按 `SessionEvent.type` 穷尽处理 13 种事件；具体映射见附录 C。不允许把新事件再翻译成旧 ConversationDelta 维持整套旧系统 |
| E14 | P0 | streaming / row keys / content loader | block_id / turn_id / call_id 当 opaque ID；累计 `message_delta` 替换；sealed entry 同 ID 合并；工具参数累计替换、输出按 stream 追加。新快照/resync 后重新建立正文引用订阅，取消旧 session/generation 请求；保持滚动位置与展开状态。水位边界先解决 B01 |
| E15 | P0 | `normalizeActivity()`、等待区间、侧栏状态 | 新 `ActivityState=idle|running|interrupted`，`SessionActivityState=starting|idle|working|waiting_user|disconnected|failed`，与当前 WebUI 同名文件的归属**恰好相反**。重新生成后同步改 mapping；pending interactions 决定等待用户状态。`SessionRunStatus.not_running` 不等同 idle |
| E16 | P1 | `tools/StepRow.tsx`、`registry.ts`、`presentation.ts`、`command-icons.ts` | 不再读取 `TimelineToolDisplay.header/body/permission` 或推断旧状态。快照工具字段来自 ToolCallView，原始 args 只 stringify 展示；工具状态直接消费 declared/awaiting_permission/running/finished/failed/cancelled/interrupted。当前实时帧不发 tool_name，缺口见 B03 |
| E17 | P1 | `diff/deliverables.ts`、`TurnDeliverablesCard.tsx`、DiffReviewDrawer | 行数总计优先使用 `code_delta`，绝不把它合成为 unified diff。文件行与审查抽屉只从原始 tool output 的实际 diff 路径生成；没有 diff 路径时不猜文件数或文件名，工具行仍显示结构化行数 |
| E18 | P1 | `turn/thinking-label.ts`、usage / timing / retry UI | 新块只有 AssistantBlockKind reasoning/answer/tool_call，没有原 reasoning_kind 细分；缺数据时不声称“原始完整思考”或“摘要”。usage 从 turn outcome / assistant block 的 UsageInfo 读取；工具耗时从 metrics 时间戳计算。帧 seq 不能当时间戳；旧 provider_retrying 等事件已退出词表 |
| E19 | P1 | `compact.ts`、store.requestCompact、SessionView、pagination.ts | `conversation.compact`、compact_started/progress/finished、旧 checkpoint / turn_index 翻页协议均不存在。去掉手动压缩命令及旧过程卡；`TimelineEntry.compaction` 仅表示已出现摘要。页面虚拟化/本地窗口可以保留；不能伪装成后端深分页 |
| E20 | P1 | 审批刷新、todo 刷新、标题 / 会话列表 | 以 interaction_requested/resolved、tool_finished、turn_ended、session_meta_changed 驱动对应 UI；写命令成功后按需重读列表/元数据/todo。新词表没有旧 workspace_resource_changed / deleted / settings_changed / team delta，不能继续等这些信号。后台跨客户端刷新能力不足见 B04 |

### 5.3 WebUI 业务调用

| ID | 优先级 | 文件 / 范围 | 必须完成的修改及验收点 |
| --- | --- | --- | --- |
| E21 | P0 | `tabs/store.ts:createSessionWithCwd`、StartupView、OAuthPage | 当前发送 profile_id/model/max_tokens/context_length，后端 SessionCreate 不消费这些字段。改发 `profile`、`effort`、`model_selection:{provider_id,model_id,options}`、cwd/title/tools。max tokens 对应 options.max_output_tokens；context_length 是模型目录能力，不能当单会话任意覆盖。保留唯一创建后的 `{session_id}` 检查 |
| E22 | P0 | `session/store.ts:refreshProfile`、Composer、EffortCard、ToolModeCard | `session.meta` 读 SessionListEntry 平铺字段 profile/model_selection/effort/settings_revision/tool_mode/custom_tools；当前 profile_id/model_override/max_tokens_override/context_length_override 均非当前字段。每次写入带读到的 settings_revision，成功推进版本；409 后重读并提示冲突，禁止无条件自动覆盖 |
| E23 | P0 | 各 `setSession*` 方法 | patch.profile 为字符串（空串可清），patch.effort 为字符串，不是 `{kind:"use"}`。model/输出参数走 `model_selection:SettingValue<ModelSelection>`；没有 profile_id、model、max_tokens、context_length 顶层 patch 字段。model_selection 的继承才用 `{kind:"inherit"}`；effort 清除与 selection.options 的优先级要按产品语义验证 |
| E24 | P0 | `session/store.ts:sendMessageWithAttachments` | 改 `conversation.send` 为 `conversation.send_message`；attachments 为 hash 字符串数组。允许 input_purpose 规范值 trigger_turn/queue_only/steer/interject；cancel 保留可选 turn_id。公网 JSON 不得设置 as_system=true / inter_agent / subagent_terminal，后端会回 trusted_invocation_required |
| E25 | P0 | `settings/store.ts`、`settings/patch.ts` | `config.patch` 改 `config.save {patch}`；patch 字段继续依据当前 ConfigPatch，保持 camelCase 的 DTO 字段和 snake_case 命令字段的边界。不要把所有配置写入都套 config_revision：当前契约只对附录 A 的五种目录写命令强制该前置条件 |
| E26 | P0 | `settings/registry.ts`、ProvidersSection、模型选择 / 全局默认 | 新 provider.list 读 `providers.toml` 目录，provider.upsert 使用 ProviderUpsertDto 的 base_url、credential、wire、headers、compat、api_key:SecretWrite，携带 config_revision。当前 baseUrl/apiKey 字段和 merge 语义错误。新增/编辑模型使用 provider.model.upsert/delete；全局默认走 model.selection.set_default；读 default_model_selection，不再只依赖 default_profile |
| E27 | P0 | ProfilesSection、registry.saveProfile/deleteProfile、首次登录配置 | 当前 profile.create/update 的嵌套 `{profile:{...}}` 不符合契约，profile.update 根本不存在。若保留公开的 profile 功能，create 改为平铺 name/model/id/provider/...，delete 用 `{name}`；修改已存在 profile 的产品动作需要后端给出实际契约或停止暴露。`profile.list` 与新 provider.list 分属不同目录，不能混用 revision，详见 B06 |
| E28 | P1 | `tabs/store.ts`、WorkspacePanel、WorkspaceMenu | 查询 workspace.list/get 继续 service；create(global)、rename/delete(workspace target)、set/move_session/detach(session target) 全走命令。删除 session.set_group 翻译；调用者直接发规范 move/detach；读取 WorkspaceEntry.missing_dir。变更后重取列表，不能继续等待旧资源投影 |
| E29 | P1 | `lib/memwatch.ts`、MemoryPanel、main event bridge | diagnostics.memwatch/dump 均已不存在；改 diagnostics.memory.start/stop 命令 + diagnostics.memory.snapshot 查询。当前 renderer 已选择 snapshot 轮询，不宣称接入 SSE diagnostics.memory；若之后改用推送，main 需注册 SDK onDiagnostics 并转发 |
| E30 | P1 | `skills/scan.ts`、skills-scanner、ToolsPage | 后端已有 skills.catalog / skills.list_tools：优先消费 backend 的解析、同名遮蔽、diagnostics，不再靠 daemon.version 探活后由 renderer 复刻后端目录优先级。Electron 用户文件扫描只保留确需 OS 权限的用途，不能替代会话 cwd 下的权威 catalog |
| E31 | P1 | `lib/siwc.ts`、`lib/dsaccount.ts`、PairingSection | 账户方法仍走 service，保留 flow_id/attempt_id/profile_id/order_id 等各自参数，不迁成会话命令；18 个方法全部 admin_only。账号登录成功后 ensureAccountProfile 的“建 provider→建 profile→默认”流程随 E26/E27 一并改；配对/device opaque challenge 继续与 host challenge 区分 |
| E32 | P1 | 压力页面、测试、README、构建说明 | 更新 settings-check/stress/mock 的 ProfileSummaryDto 与 ACK；移除旧 wire 测试和无效源码路径注释；改用当前 exporter fixture。测试文件清单见第 8 节 |

- [ ] E01–E15、E21–E27 的 P0 基础链路完成，能创建、打开、发送、显示流式文本、审批、改设置。
- [ ] E16–E20、E28–E32 完成，或因明确退出的后端能力同步移除产品入口。
- [ ] Electron main、renderer、SDK dist 使用同一代契约，发布验证不复用旧 mock 结论。

## 6. 不能仅由 Electron / SDK 修好的后端缺口

本节是阅读当前实现后发现的联调依赖，**不是声称本次已经修改 backend**。每一项都给出实际观察，避免把契约声明误当成能力已经交付。

| ID | 级别 | 源码事实 | 对接影响 / 所需处理 |
| --- | --- | --- | --- |
| B01 | P0 | `owner.current_seq()` 返回 next_seq；emit 使用 `fetch_add` 的旧值作为帧 seq；snapshot 先异步读 DB 再取 next_seq；daemon 用 `since < snapshot.seq` 判断缺口 | **水位存在 next-vs-covered 的边界不一致及快照/事件非原子风险。** 第一帧可能与 bootstrap 水位相等；若按常见 `seq<=snapshot.seq` 丢弃会丢首帧。DB 快照与后取水位之间还可能发生写入。后端先统一水位语义和快照/订阅边界，再锁定 SDK 去重规则。按“下一序号”定义和按“已覆盖序号”定义二选一，不能客户端猜测 |
| B02 | P1 | actual router 没有 driver/claim/release 路径；coverage.rs 仍列这两个 URL 为 implemented | 修正 coverage 为统一 driver 命令；SDK 不再请求旧 URL。类型声明、fixture 存在不代表 HTTP 路由存在 |
| B03 | P1 | declare_tool_call 只落库不发声明事件；timeline tool_call 仅含 call_id/turn_id；tool_started 也只有 call_id；OwnerSink 丢弃原 progress 中的 tool_name、block kind、model | 活跃订阅者拿不到新工具名/完整 args，也不能即时区分 reasoning 与 answer。后端应给出完整工具声明/更新和块类型事件字段；SDK/Electron 再按新契约消费。不能靠重建旧 display 协议或猜工具名修复 |
| B04 | P1 | snapshot load_session_state 当前填 title=None、subagents=[]、driver=None；未找到 SessionMetaChanged/SubagentUpdated 的生产构造；SessionEvent 也没有 driver_changed / settings_changed / todo resource / team delta | 新字段/事件中有声明未接线的部分。title 可从 session.meta/list 读；team 有独立 GET。若产品需要实时标题、子代理和席位状态，后端需补齐生产与重同步数据；否则客户端明确使用已有查询/写后刷新，不能承诺完整实时同步 |
| B05 | P0（可靠创建） | 同步操作 ACK 有任意 JSON result/revision，但 pending.mark_terminal 只记 succeeded；status.result / existing.result 类型仅覆盖三种交互结果 | 创建已成功却丢 ACK 时，轮询 succeeded 拿不回 session_id；同 ID 重发只回 receipt，不保证原同步结果。后端需要持久化并重放同步 result/operation/revision，或明确查询恢复契约。SDK/Electron 不能自动再创建一个，也不能把 succeeded 包装成完整创建结果 |
| B06 | P0（设置 / 引导） | provider handlers 的 load_catalog 用 default_providers_path；system profile.list/create 等用 default_profiles_path；新目录 default_model_selection 与旧 default_profile 并存；没有 profile.update | 当前设置页“一份 profile.list 目录负责一切”的假设不成立。应以新 provider/model selection 作为新执行目录；如果继续提供 profile 产品能力，后端必须明确它与新目录的关系及编辑入口。不同文件的 revision 不能串用 |
| B07 | P1 | open response 只暴露 wire v2/capabilities，不带 command contract revision；新旧两代仍都使用 schema=qaqh.Ringing/version=2 | 旧 SDK 的 connect/bootstrap 表层校验可以通过，直到命令或渲染才失败。建议后端在握手提供代际信息，客户端显式校验；若不增加字段，则在发布/契约 hash 门禁中阻止混搭，并给明确错误 |
| B08 | P1 | ServiceMap 仅覆盖 28/36；config.load/profile.list/session.dashboard/skills.list_tools/todo.status/todo.list/plan.read/diagnostics.memory.snapshot 未纳入 typed DTO；coverage 还有旧频道/expected_revision/driver_epoch 的幂等说明 | 先补导出 DTO 或明确 partial coverage，再生成客户端；修正文案与真实 fingerprint/guards 的关系。不能靠 SDK 自造另一份长期权威协议补齐 |
| B09 | P1 | 当前 SSE resync 无重放尾；message/tool arguments/output progress 是不落库的暂态；snapshot 当前仅从 DB 组装，未把运行中累计 progress 尾窗补回 | resync 可以恢复已提交业务状态，但不能承诺保留所有尚未 sealed 的流式展示。若要求断线后无闪退、无暂态回撤，后端需要补运行中快照；客户端必须清理上一代暂态，避免把残留当持久事实 |

B01 / B03 / B04 / B09 的主要证据在 [owner.rs](../../qaqh-backend/crates/qaqh-session/src/owner.rs)、[db/view.rs](../../qaqh-backend/crates/qaqh-session/src/db/view.rs)、[session_loop.rs](../../qaqh-backend/crates/qaqh-agent-runtime/src/session_loop.rs) 和 [SSE handler](../../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs)。B05 见 [同步 dispatcher](../../qaqh-backend/crates/qaqh-daemon/src/axum_server/axum_impl/commands.rs) 与 [receipt 类型](../../qaqh-backend/crates/qaqh-ringing/src/v2/types.rs)。这些是静态调用链结论，尚未用运行中的 v3 daemon 复现并发场景。

## 7. 已有工作与不应重复改造的部分

| 范围 | 本次判断 |
| --- | --- |
| OS / 令牌边界 | renderer→preload→main→SDK 的基本职责正确；令牌与本地文件权限继续留在 main |
| SDK 传输基础 | lease renew、refreshCredentials、单 watch 生命周期、abort、重连退避、SSE 按字节读空闲超时等可保留，替换 wire 消费部分 |
| 内容下载 | SDK 已有跨 body read 的 timeout/AbortSignal，不能在协议改造中回退；Range 与 bearer/lease 仍适用 |
| 用户审批 host challenge | opaque host challenge、一次性消费、details unavailable、离线不可自动批准等原则可以保留，替换校验源和出站命令即可 |
| ACK 词表 | Electron requireAccepted 的 accepted/rejected 基本假设正确；stress 中 completed mock 错误，不能倒过来修改生产协议迎合 mock |
| session.list/meta | 仍是 SessionListEntry，meta 使用 flatten；不应改成嵌套 `{meta:{...}}`。需要补充 settings_revision、新 selection 字段，删除多余兼容解包 |
| workspace.list/get | DTO 形状大体已覆盖；主要变化是写入口和持久化来源，不必重做工作区全部 UI |
| 账户与配对 | 18 个账号 RPC、pairing、device list/revoke 的主要入口仍有效；更新共享类型及登录后的目录配置链，不要整体迁到命令表 |
| 生成契约完整性 | 当前 SDK manifest 内部 hash 全部正确；当前缺陷是**来源陈旧**，不是 manifest 文件损坏 |

## 8. 验证结果、需更新的现有测试与实施顺序

### 8.1 当前实施与验证状态

| 检查 | 结果 |
| --- | --- |
| Backend exporter `check --release` + WebUI/SDK generated mirror | 通过；干净 backend revision `b144398d…`，205 个类型文件完全一致 |
| SDK `npm test` | 通过；build 成功，34/34 测试通过，dist 与 manifest 已更新 |
| Electron `npm run typecheck` / `npm test` | 通过；81/81 测试通过 |
| WebUI `npm run typecheck` / `npm test` | 前一轮通过；445/445 测试通过。后续 E16/E17 改动尚未重验 |
| `settings-check.mjs` | 通过；11/11 浏览器断言 |
| `layout-check.mjs` | 前一轮通过；三种窗口宽度、创建/发送、workspace、审批状态、思考内容生命周期与滚动断言均通过。v3 夹具改动尚未重跑 |
| `oauth-shot.mjs` | 通过；OAuth 画面检查完成并生成截图 |
| build pipeline syntax / source diff checks | 本轮对 E16/E17/E32 相关文件运行 scoped `git diff --check` 和 `node --check webui/scripts/layout-check.mjs`，均通过。未运行完整构建或桌面打包；工作树含已有 release 产物 |
| 本轮 E16/E17/E32 编辑 | 已移除旧 ToolDisplay 与本地旧状态枚举；行数读 `code_delta`，diff 只从原始输出解析；stress/layout 夹具改用 v3 事件帧。静态检查通过；尚未运行类型检查、测试或浏览器检查 |
| resync 客户端路径静态追踪 | SDK 收到 `ringing.resync_required` 后清空游标并强制重新 bootstrap；WebUI bootstrap 重建 turn/timeline，并清空未归属 timeline 的文本与工具参数缓冲。未做 daemon/browser 验收；B01 水位竞争与 B09 服务端暂态补回仍未解决 |
| SDK S12 / acceptance 说明 | SDK README 明列 8 个缺失 exporter DTO 的 service 方法，并说明它们未进入 typed API；真实传输验收文档注明有会话时会提交 `session.resume` 改变当前 lease attachment。SDK 两个文件的 `git diff --check` 与 acceptance 脚本 `node --check` 通过；未跑 SDK 测试 |
| E29 diagnostics memory 路径 | MemoryPanel 已用 `diagnostics.memory.start/stop` 命令管理采集，并按秒轮询 `diagnostics.memory.snapshot`；源码明确标注不消费 SSE diagnostics 推送。该路径是当前设计选择，不要求 main SSE bridge |
| E04 service 参数约束 | IPC 对 session-scoped service 运行时校验 `session_id` 并原样传递 params；主进程 `RingingClient.serviceCall` 已移除可令所有方法省略 params 的默认 `{}`，避免绕过方法级参数要求 |
| 当前 backend 真机 HTTP / SSE 验收 | 未运行；B01/B05/B06 等阻塞项仍在，本次没有用用户令牌或现有用户数据目录 |

本次没有修改 backend。SDK 包级测试覆盖其内部 hash 与入口，Electron 主进程测试覆盖 IPC/SDK 路径；这些结果不替代真实 daemon 的命令、SSE、CAS 与断线恢复验收。

### 8.2 现有测试 / fixture 的迁移范围

- SDK：`test/client.test.mjs`、`test/package.test.mjs`、`scripts/acceptance.mjs`、generated fixtures。重点改旧 Unified envelope、snapshot_cursor、stream_key、reset_required、driver URL、旧 OperationFailure；补新 CAS 与 result 恢复能力边界。
- main / IPC：`scripts/config-allowlist-wire.test.mjs`、`interaction-wire.test.mjs`、`interactions.test.mjs`、`content-read.test.mjs`、`packaging.test.mjs`、`test-host.mjs`。重点验证统一出站 wire、查询 session_id、帧的宿主 session 上下文、审批 call_id 与 interaction_id 匹配、未知结果原 ID 对账。
- WebUI：`reducer.test.ts`、`streaming.test.ts`、`projection.test.ts`、`content-hydration.test.ts`、`background-unload.test.ts`、`status-watchdog.test.ts`、`approval-refresh.test.ts`、`todo-refresh.test.ts`、`defensive-recovery.test.ts`、`live-metrics.test.ts`、`attachments.test.ts`、`compact.test.ts`、`pagination.test.ts`、`deliverables.test.ts`、`tool-presentation.test.ts`、`registry.test.ts`、`tool-shimmer.test.ts`。本轮把工具状态、raw output、`code_delta` 夹具改为 v3 形状；这些调整尚未重跑。保留有效的滚动、正文加载、diff parser、审批安全和列表虚拟化验证。
- 不为本次 Markdown 新增测试。后续实现只补必要的契约/关键行为验证，不按每个字段增加一批重复测试。

### 8.3 建议执行顺序

1. 先裁定并修正 B01、B05，以及设置/引导依赖的 B06；确认 B03/B04/B09 所需的产品展示能力。修 backend coverage 和导出，冻结这次要消费的确切契约。
2. S01–S03：整体再导出 SDK generated，切唯一命令根/信封/公共类型；同轮调整 core 引用，避免处于“新类型 + 旧实现”中间态。
3. S04–S16：接命令 helper、CAS、SSE、resync、错误/receipt、内容、driver、服务查询，build SDK dist。
4. E01–E15：同步 WebUI 类型、主进程/IPC、宿主事件包装、审批和 reducer，先打通一个最小会话闭环。
5. E21–E31：逐业务切设置、provider/model selection、创建、附件、workspace、诊断、skills、登录后配置；E16–E20 同步处理展示能力退出或补齐。
6. 更新现有 mock/fixtures，运行 SDK、main、WebUI 的定向验证；三方 typecheck 通过后再做隔离数据目录的真实 daemon 验收。
7. 真机最小验收应包含：新建→attach/resume→bootstrap→SSE；文本/思考/工具→终态；permission/ask/plan；settings CAS 成功+409；provider revision=0 首次写；附件上传+发送+下载；断线/换 epoch/resync；丢 ACK 原 ID 对账；workspace 增改移除；账户登录后目录能实际执行。
8. 最后走现有 `just` 打包入口，验证安装包实际内嵌 SDK、WebUI 与 daemon 的契约一致；不以版本字符串代替此检查。

## 附录 A：44 个命令完整对照

全部使用 `POST /ringing/v2/commands`。G=global target，S=session target，W=workspace target。非强制 CAS 的行不代表可以复用其他命令的 revision 语义。

| # | 规范命令 | target / 前置条件 | payload / Electron 现状与动作 |
| --- | --- | --- | --- |
| 1 | session.create | G | cwd/title/profile/effort/model_selection/tool_mode/custom_tools 可选；改创建参数，结果 `{session_id}` |
| 2 | session.settings.patch | S + settings_revision | patch 仅现行五类字段；所有设置写调用改造 |
| 3 | session.resume | S | 无 session_id payload；main 当前旧 session_resume 需切换，会拉起 worker |
| 4 | session.attach | S | 无业务 payload；只建立归属，View 可用，供只读订阅 |
| 5 | session.close | S | 无业务 payload；关闭/释放 actor；有调用者时直接新命令 |
| 6 | session.rename | S | `{title}`；SessionHeader 已发同名，但当前错误转 service 且未传 session_id |
| 7 | session.archive | S | 无业务 payload；删旧 service/频道入口 |
| 8 | session.unarchive | S | 同上 |
| 9 | session.delete | S | 同上；写后刷新本地列表，不等待旧 deleted 投影 |
| 10 | session.shutdown | S | 无业务 payload；保持与关闭展示、全局 daemon stop 的语义区别 |
| 11 | agent.reload_config | S | 无业务 payload；settings handler 本身已定向 reload，UI 不需重复补发 |
| 12 | conversation.send_message | S | 平铺 text/images/attachments/message_id/input_purpose 等；替换 conversation.send 和 snake_case 频道名 |
| 13 | conversation.cancel | S | turn_id 可选；替换 conversation_cancel 频道名 |
| 14 | interaction.ask.respond | S | interaction_id/answers；host 审批构造器改名去 channel |
| 15 | interaction.ask.dismiss | S | interaction_id；同上 |
| 16 | driver.claim | S | client_session_id，stale_holder 可选；SDK 去掉旧专用 URL |
| 17 | driver.release | S | client_session_id，expected_epoch 可选；同上 |
| 18 | plan.review.respond | S | interaction_id/approved/message?/autonomous；host 构造器改名 |
| 19 | tool.permission.respond | S | tool_call_id/approved/trust_folder；permission ID 用 call_id |
| 20 | provider.list | G | 返回新目录；虽然是读取，但当前被定义在命令目录且需要 admin |
| 21 | provider.upsert | G + config_revision | id/provider:ProviderUpsertDto；整体替换语义，密钥用 SecretWrite |
| 22 | provider.delete | G + config_revision | id；settings 当前缺 guard |
| 23 | provider.model.upsert | G + config_revision | provider_id/model_id/model:ModelDef；新增模型编辑接线 |
| 24 | provider.model.delete | G + config_revision | provider_id/model_id；同上 |
| 25 | model.selection.set_default | G + config_revision | selection:ModelSelection；payload 不再带 expected_revision |
| 26 | config.save | G | patch:ConfigPatch 的 JSON；替换 config.patch |
| 27 | config.set_permission_level | G | level:1..3；设置保存若已走 config.save 不重复发 |
| 28 | profile.create | G | 平铺 name/model，及可选 id/provider/base_url/wire/reasoning_effort/context_length/max_tokens/api_key；当前嵌套 payload 无效 |
| 29 | profile.set_default | G | id 或 name；与新 model selection 默认目录关系见 B06 |
| 30 | profile.apply | G | name；保留则直接统一命令 |
| 31 | profile.save_current | G | name；同上 |
| 32 | profile.delete | G | name；当前 renderer 发 id 错误 |
| 33 | workspace.set | S | path；修改 cwd 并 attach 工作区，触发 reload |
| 34 | workspace.create | G | path；返回 WorkspaceMeta；当前错误转 service |
| 35 | workspace.rename | W | title；workspace_id 放 target |
| 36 | workspace.delete | W | 无业务 payload；同上 |
| 37 | workspace.move_session | S | workspace_id；替换 session.set_group |
| 38 | workspace.detach | S | 无业务 payload；替换 set_group=null |
| 39 | subagent.spawn | G | tools/model/base_url/max_tokens/workspace；**当前是 global target**，不要因为名字擅自指定 session target |
| 40 | todo.set | S | args:JSON；若增加 UI 写能力直接用规范命令 |
| 41 | todo.cancel | S | id；同上 |
| 42 | plan.action | S | item_id/action/user_comment?；同上 |
| 43 | diagnostics.memory.start | G | 无业务 payload；替换 diagnostics.memwatch action=start |
| 44 | diagnostics.memory.stop | G | 无业务 payload；替换 diagnostics.memwatch action=stop |

应删除的旧出站名字 / 能力：`conversation.compact`、`conversation.undo_turn/load_more/set_mode`、`provider.models.discover`、`profile.update`、`session.set_group`、`config.patch`、`diagnostics.memwatch`、`diagnostics.dump`，以及所有 `session_resume` / `conversation_send_message` / `tool_permission_respond` 等带 channel 的旧命令编码。这里部分是本前端遗留名字，部分是后端已经删除的声明，不意味着它们曾全部由当前 Electron 调用。

## 附录 B：36 个 service 方法完整清单

全部使用 `POST /ringing/v2/service/{method}`。T=当前 exporter 有 params/result 类型，U=当前公开入口存在但未纳入 typed export。会话查询的 `session_id` 必须明确在 params 中；不是 CommandTarget。

| # | 方法 | 参数 / 范围 | 导出 / 本轮动作 |
| --- | --- | --- | --- |
| 1 | daemon.version | `{}` | T；保留，结果 string |
| 2 | session.list | `{}` | T；SessionListEntry[]，含平铺元数据和 status/workspace_id |
| 3 | session.meta | session_id | T；SessionListEntry 或 null；修 target 丢参、旧覆盖字段读取 |
| 4 | session.activity | `{}` | T；SessionActivity[]，不是 SessionState.activity 枚举 |
| 5 | session.dashboard | session_id | U；若使用必须补 DTO；不能假定有旧 projection |
| 6 | session.get_activity | session_id | T；SessionToolActivity[]，finished_at_ms 为毫秒，args 为原始 JSON 字符串 |
| 7 | workspace.get | session_id | T；结果为 cwd 字符串，未绑定为空串 |
| 8 | workspace.list | `{}` | T；WorkspaceEntry[]，含 missing_dir |
| 9 | fs.list | path，scope_session_id? | T；FsEntry[]，路径属于 daemon 文件系统 |
| 10 | fs.read | path，max_bytes?，scope_session_id? | T；FsReadResult，保留允许根边界 |
| 11 | config.load | `{}` | U；已有 ConfigDto，但该 RPC 未登记 typed slice；补 exporter |
| 12 | profile.list | `{}` | U；旧 profiles 目录；不能作为新 provider.list 的替代 |
| 13 | siwc.status | `{}`，Admin | T；保持 service |
| 14 | siwc.profiles | `{}`，Admin | T；保持 service |
| 15 | siwc.models | profile_id?，Admin | T；保持 service |
| 16 | siwc.sign_in.start | profile_id?/new_profile?/label?/reconsent?，Admin | T；保持 service，不能迁成会话命令 |
| 17 | siwc.sign_in.status | flow_id，Admin | T；同上 |
| 18 | siwc.sign_in.cancel | flow_id，Admin | T；同上 |
| 19 | siwc.profile.select | profile_id，Admin | T；同上 |
| 20 | siwc.sign_out | profile_id?，Admin | T；同上 |
| 21 | dsaccount.status | `{}`，Admin | T；保持 service |
| 22 | dsaccount.balance | `{}`，Admin | T；保持 service |
| 23 | dsaccount.bonuses | `{}`，Admin | T；保持 service |
| 24 | dsaccount.sign_in.start | locale?/port?，Admin | T；保持 service |
| 25 | dsaccount.sign_in.status | `{}`，Admin | T；与 siwc 的 flow_id 参数规则不同 |
| 26 | dsaccount.sign_in.cancel | attempt_id，Admin | T；保持 service |
| 27 | dsaccount.sign_out | `{}`，Admin | T；保持 service |
| 28 | dsaccount.bonus.ack | order_id，Admin | T；保持 service |
| 29 | dsaccount.models | `{}`，Admin | T；保持 service |
| 30 | dsaccount.verify | `{}`，Admin | T；可能清凭据，仍按写类 RPC 处理 |
| 31 | skills.catalog | cwd? | T；结果 skills/diagnostics，使用后端解析/遮蔽 |
| 32 | skills.list_tools | `{}` | U；查询工具名目录，补 DTO |
| 33 | todo.status | session_id | U；补 DTO，不恢复旧 service 写操作 |
| 34 | todo.list | session_id + 透传的 todo.list 查询参数（flatten） | U；当前 WebUI 读取 items；修 IPC 丢参，补 DTO |
| 35 | plan.read | session_id | U；补 DTO |
| 36 | diagnostics.memory.snapshot | after_sequence?，Admin | U；替换 diagnostics.dump，补 DTO |

SDK 旧 ServiceMap 需要删除的写 RPC：`session.rename`、`session.set_profile`、`session.set_effort`、`session.create`、`session.set_tool_mode`、`workspace.set/create/rename/delete/move_session/detach`。它们的能力分别迁到规范命令 / settings patch，并非功能全部删除。

## 附录 C：13 种新事件的 WebUI 消费责任

| type | 核心字段 | 归约 / 副作用 |
| --- | --- | --- |
| activity_changed | activity/current_turn_id | 更新运行态、取消按钮、当前回合；结合未解决交互显示等待状态 |
| turn_started | turn_id/input_id/mode | 建立回合，关联已接收输入；不从本地发送顺序猜归属 |
| turn_ended | turn_id/outcome | 处理 finished/interrupted；更新 usage/error/status，刷新 todo/会话列表 |
| tool_arguments_delta | call_id/turn_id/text | 累计参数替换；不是执行成功或参数校验通过 |
| tool_started | call_id | 置 running；工具名/args 缺口见 B03 |
| tool_output_delta | call_id/stream/text | 按 stdout/stderr 追加有界尾窗 |
| tool_finished | call_id/status/output/output_truncated/error/metrics/code_delta/effects | 完整工具终态，更新计数/效果/正文 ref，按需刷新 todo/审批 |
| timeline_appended | entry | 追加 input/assistant_block/tool_call/tool_result/compaction；同 ID 流式 block 合并，避免工具结果和工具卡双重显示 |
| message_delta | turn_id/block_id/text | 累计文本替换；block_kind 缺口见 B03 |
| interaction_requested | interaction:InteractionView | 记录请求，失效旧 challenge，刷新 host 审批视图 |
| interaction_resolved | interaction_id/decision/status | status=resolved/expired/cancelled；关闭对应卡片、清理等待区间 |
| subagent_updated | subagent:SubagentView | 更新子代理；实际生产/重同步缺口见 B04 |
| session_meta_changed | title | 标题/侧栏刷新；实际生产缺口见 B04 |

SSE 外层另有 `ringing.resync_required`、`ringing.stream_terminated`、`diagnostics.memory` 和 keepalive 注释。它们不是上述 13 种 SessionEvent，不能当 `SessionEventFrame` 解析。

## 附录 D：HTTP 表面逐项归属

| 端点 | SDK / Electron 动作 |
| --- | --- |
| GET /health、GET /activity | 观测用途；不要混入会话命令目录 |
| POST /ringing/v2/clients/open、POST /leases/renew | 保留 lease 基础实现，更新能力与代际检查 |
| GET /sessions/{id}/bootstrap、GET /events | 新快照/帧/水位/resync；本次核心改造 |
| GET /sessions/{id}/team | 类型改 TeamResponse；无旧 team delta 推送保证 |
| POST /commands、GET /commands/{id} | 唯一业务命令入口和 receipt 查询 |
| GET /sessions/{id}/approvals、POST /approvals/respond | admin canonical 与 device opaque 两套 view 仍区分；host 则用自己的 challenge→统一命令 |
| POST /content、GET /content/{id} | raw 上传响应仍为对象；业务 ContentRef 是 hash 字符串 |
| POST /service/{method} | 仅附录 B 的查询与账户 RPC |
| POST /pairing/tokens、POST /pair、GET /devices、POST /devices/{id}/revoke | 保留，更新共享 DTO；scope 仍由 daemon 认证 |
| GET /exec-sessions、POST /exec-sessions/{id}/kill | 后端真实路由已存在；SDK 当前缺工具方法 / 明确覆盖记录 |
| POST /control/v1/stop、POST /control/v1/stop-if-idle | Electron graceful stop 已有 SDK 实现，继续保留；不因 coverage pending 就删除 |
| 旧 /commands/{channel}、timeline 页面/事件、driver 专用 URL | 当前 router 不存在；清理 SDK、文档、mock 和 coverage 中的遗留引用 |
