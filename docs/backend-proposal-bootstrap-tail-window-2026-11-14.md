# 后端提案：bootstrap 尾窗化（timeline tail + `timeline_from_ord` 标记）

- 提案日期：2026-11-14
- 提案方：qaqh-electron（前端 Electron 壳）
- 目标仓：`qaqh-backend`（LTS；按仓库纪律，读模型纯增量、命令面代际不变）
- 状态：评审通过（方案 A 修订版）· 后端批次已实施 · 前端批次未开工

## 1. 背景与动机

前端 Electron 渲染层对大会话做了本地窗口管理（`webui/src/session/pagination.ts`）：
内存只保留最近 50 回合（`TURN_WINDOW`），视口上方 2 屏外的回合被淘汰成等高 gap
占位。但重连/重开标签时的权威快照 `SessionBootstrap` 目前把**全部**回合与
timeline 块一次性下发并全量重建：

- 前端 `applySessionBootstrap` 清空 `draft.turns/slots` 后物化快照内所有回合
  （`webui/src/session/reducer.ts:560-572`）；
- 后端 `load_turns` 无 LIMIT（`qaqh-session/src/db/view.rs:376-395`）；
- `load_timeline` 用 `read_transcript_page(conn, session_id, None, 10_000)` 一次
  读 1 万块（`view.rs:464-481`），**超过 1 万块静默截断且无任何标记**，客户端无从
  得知历史不完整；
- 前端 `loadOlder()` 是 stub（`webui/src/session/store.ts:1307-1309`），被淘汰的
  旧回合数据已删（`pagination.ts:74`），在下次全量 bootstrap 前没有任何取回途径。

长会话（数百回合）下，每次重连都要传输/解析/重建全量读模型，内存与延迟随会话
长度线性上涨；而前端真正需要的只是「可见尾窗 + 运行中回合 + 未决交互」。

v3 协议影响文档 E19（`docs/backend-v3-protocol-impact-2026-11-03.md`）早已告诫
「不能伪装成后端深分页」——本提案就是把深分页的后端一半补上，前端一半由本仓
承担（见 §7，不在本批次内）。

## 2. 目标 / 非目标

**目标**

1. `SessionBootstrap` 的 timeline 载荷有界化（尾窗），并**显式**标记截断边界；
2. 被截断的历史可按回合按需取回（复用已有 `session.turn`，不新增方法）；
3. 对现有客户端零破坏：字段 additive，缺席语义 = 现状（完整快照）。

**非目标**

- 不改 `message_delta` 的累计全文替换语义（前端实测瓶颈在 layout/软光栅，
  协议增量换不来可测收益，且会重新引入水位/重复 append 事故面）；
- 不动 SSE cursor 重放与 `ringing.resync_required` 语义（B01 已定案：`seq` 为
  exclusive「下一序号」，快照已覆盖 `seq < state.seq`）；
- 不新增通用 timeline 游标分页方法（按回合粒度的 `session.turn` 已覆盖前端
  淘汰粒度；单回合内部超大载荷已由 ContentRef 懒加载消化）。

## 3. 已存在、可直接复用的后端能力

| 能力 | 证据 |
|---|---|
| `session.turn` 读方法（`SessionTurnParams → SessionTurnSnapshot`，单回合切片：turn + timeline + tools） | `qaqh-runtime/src/ringing/service_methods.rs:626-632`（Read, requires_session）；`qaqh-client/src/endpoint.rs:84,126-129,193`（白名单+参数+序列化）；`qaqh-session/src/db/view.rs:98-125`（DB 装载） |
| transcript 分页读原语 | `store::read_transcript_page(conn, session_id, before, limit)`（`load_timeline` 已以 `(None, 10_000)` 调用，`view.rs:465`） |
| tools 已有界 | `recent_tool_calls(conn, session_id, 500)`（`view.rs:36`） |
| interactions / exec_sessions 天然有界 | pending 集合；非终态 + 最近 32 终态摘要（`view.rs:40-47`） |

注：`session.turn` 的实现链已核到 runtime 注册与 client 白名单；daemon HTTP 层
的逐一冒烟未验证，验收时一并覆盖（§6）。

## 4. 契约改动（全部 additive）

### 4.1 `SessionState` 新增可选字段

```rust
/// timeline 尾窗起点（exclusive），仅 bootstrap 读口填充。Some(n) 表示本
/// 快照的 `timeline` 只含 `ord >= n` 的块，外加一条**显式例外**：被截掉区域
/// 里最近一条 compaction 摘要块（其 ord < n，客户端必须照常渲染在 timeline
/// 首位——「以上内容已压缩」的表示不因尾窗而消失）。None（或旧 payload
/// 缺席）= 完整快照。回合元数据（`turns`）**始终全量**，不受尾窗影响（行小，
/// 列表/跳转/封箱事实扫描依赖它）。这是读模型填充边界，不是事件水位：不得
/// 与 `seq` 混用；`seq` 仍覆盖全量事件流（含尾窗外历史块），SSE 续传不受
/// 尾窗影响（B01）。
pub timeline_from_ord: Option<i64>,
```

类型为 `Option<i64>`：与 `blocks.ord`、`AssistantBlock.ord`（契约内 ord 一律
i64）一致，评审修正（原提案误写 `u64`）。ts-rs 导出后 `SessionState.ts` 同步
镜像（`just sdk-export <out>` / `just sdk-check <dir>`，产物只由机器写），前端
缺席即按完整
快照处理，旧客户端零影响；读模型纯增量，`SESSION_CONTRACT_REVISION` 不 bump。

### 4.2 尾窗装载变体（评审修订：改不动共享读口，仅 bootstrap 接线）

**改动点修正（评审 P0-1）**：`load_session_state` 是共享读口——`owner.snapshot()`
除 bootstrap 外还喂给 agent 上下文组装（`assemble_context` 用快照 timeline 组装
provider 消息流，`session_loop.rs`）、`file_ledger`、approvals、interaction 回放。
直接改 `load_timeline` 会把 agent 自己的对话历史截断。因此：

- 全量 `load_session_state` **保持不动**（原 10k 上限与行为不变）；
- 新增尾窗变体 `view::load_session_state_tailed(conn, id, tail_blocks)` 与
  `owner::snapshot_tailed(tail_blocks)`（定序纪律与全量快照一致：先取水位，
  再读库）；
- 仅 `handle_bootstrap_v2` 接尾窗：新增 **opt-in query 参数 `timeline_tail`**
  （评审 P0-2 修正——尾窗是服务端行为，与客户端传什么无关；无条件尾窗则
  「旧客户端逐字节等价」验收不可能成立。参数缺席 = 全量快照 = 现状逐字节
  一致；非法值 400 `invalid_timeline_tail`；合法值 clamp 到
  `[1, MAX_TIMELINE_TAIL_BLOCKS=2000]`，默认 600 由**调用方**（前端）决定）；
- `load_turns` 保持全量不变；tools 的 `recent_tool_calls(500)` 维持现状
  （600 块 ≤ ~300 个 call/result 对 < 500，尾窗内引用的 call_id 天然落在
  其中；更早回合的 tools 由 `session.turn` 自带）。

尾窗算法（`view::load_timeline_tail`）：

1. 取最近 `tail_blocks` 块；未取满窗口、或窗口首块之下再无块 → 完整快照，
   `timeline_from_ord = None`；
2. 截断已发生时**向前回退到回合边界**：从窗口首块向上找首个带 `turn_id` 的
   块，边界 = 该回合的 `MIN(ord)`（整回合入窗，首屏不出现「无头回合」）；
   **压缩块无回合锚点（`turn_id` NULL，owner 写口如此），不参与回退**——评审
   补充的边界规则；整窗均无锚点块的病理形态按窗口原样输出；
3. 回退后若边界 ≤ 全会话 `MIN(ord)`，实际已覆盖全部块 → 按完整快照标记
   `None`（前端 `hasMore` 不得空转）；
4. 真截断时 `timeline_from_ord = Some(边界)`，并在尾窗头部**附上被截区域最近
   一条** compaction 摘要（按 `kind='compaction' AND ord < 边界` 取，走
   `idx_blocks_session` 索引）。

### 4.3 明确不变的语义（写进 DTO doc comment）

- `state.seq` 水位照旧覆盖**全量**事件流（含尾窗外的历史块产生的 seq），
  SSE 续传不受尾窗影响——尾窗只裁剪 bootstrap 的 timeline 载荷，不改变事件序号
  空间；
- `timeline_from_ord` 是**读模型填充边界**，不是事件水位；客户端不得把它与
  `seq` 混用；
- 排序仍以 `blocks.ord` 为权威（`view.rs:474-477` 的回填逻辑保留）。

## 5. 前端如何消费（背景说明，非本批次工作）

1. `installBootstrap` 遇 `timeline_from_ord != null` 时，对 ord 边界之前的回合
   建 gap 占位（turn 元数据齐全，占位高度用既有 `fillGapHeights` 机制）；
   - **compaction 例外块**（ord < 边界的头插摘要）不进 gap、照常渲染在 timeline
     首位（契约 doc comment 已写明该例外）；
2. `loadOlder()` 接真：按 gap span 的 turn_id 逐个调 `session.turn` 回填切片，
   `hasMore = timeline_from_ord != null`；「hasMore=false 的本地窗口淘汰」现状
   保留；
3. 被淘汰回合的取回路径与被截断回合相同（同一 `session.turn` 通道），
   「淘汰即永久丢失」的隐性体验问题一并消除。
4. bootstrap 请求带 `?timeline_tail=600`（opt-in，方案 A；默认值与调优归前端）；
   **resync_required 重建同样拿尾窗快照——不得清空重建**：reducer 现状
   `applySessionBootstrap` 会清空 `draft.turns/slots`，resync 时会把用户已回填的
   更早回合一并抹掉，需按 block_id/turn_id 合并而非清空（评审补充，electron
   施工单必须覆盖）。

## 6. 验收标准

1. **兼容性（方案 A 版）**：bootstrap **不带** `timeline_tail` 参数时，响应与
   现状逐字节等价（字段 skip_serializing_if 缺席，全量装载路径未动）；
2. **尾窗边界**（带参数）：构造 > tail 的会话，断言
   - `timeline_from_ord` 非空且指向回合边界块；
   - 尾窗首块所在回合完整（无无头回合；回退后覆盖全会话时回退为 `None`）；
   - 截断区含 compaction 时，最近一条 compaction 出现在尾窗头部；
3. **水位不受影响**：尾窗快照 `seq` 与全量快照一致；SSE 从 `seq` 起播不丢帧、
   不重帧（B01 语义回归）；
4. **按回合取回**：对 `timeline_from_ord` 之前的任意 turn 调 `session.turn`，
   返回完整 turn + timeline + tools，与全量快照对应切片一致；
5. **大库冒烟**：隔离 daemon 对 1 万+ 块会话带参数拉 bootstrap，响应体积有界
   （≈ 尾窗 + 回合元数据），延迟有界（巨型单回合例外：回合边界回退把整回合
   拉进窗口，属 UX 正确性优先的有界性例外，验收时如实记录）；
6. 契约导出检查通过（`just sdk-export` / `sdk-check`；electron 侧镜像
   `webui/src/api/qaqh/*` 由其 sync 流程更新）。

## 7. 工作量估算（仅后端批次）

| 项 | 状态 |
|---|---|
| 全量读口保持不动 + 尾窗变体（view/store/owner 三层） | ✅ 已实施 |
| `SessionState.timeline_from_ord`（additive，i64） | ✅ 已实施 |
| bootstrap `timeline_tail` 参数 + clamp + 400 | ✅ 已实施 |
| 单元/边界测试（§6.2–6.4 + owner 水位 + 参数解析） | ✅ 已实施 |
| 契约导出（sdk-export 冒烟） | ✅ 已实施 |
| 隔离 daemon 大库冒烟（§6.5） | ⬜ 待跑 |
| **前端批次（§5，electron 仓）** | ⬜ 施工单另开 |

## 8. 风险与未验证项

- daemon HTTP 层对 `session.turn` 的暴露未逐一冒烟（§3 注），若验收发现缺口，
  补接线（预计为机械接线，不涉契约）；
- 尾窗默认 600 块由前端发送（方案 A），「往上翻」的节奏由前端实测调优；服务端
  只保留 2000 上界 clamp；
- **有界性例外**：单回合块数 > tail 时回合边界回退把整回合拉进窗口（首屏
  正确性优先），理论上无上界；实运会话工具块密度下可接受，冒烟时覆盖；
- 旧客户端（未升级的 electron 壳）不发参数 → 永远拿全量快照，无退化；升级
  过程中不存在静默截断窗口（方案 A 的核心收益）；
- 前端配套（§5）由 qaqh-electron 仓承担，另开施工单，不在后端批次验收范围。

## 9. 实施记录（后端批次，qaqh-backend）

- 契约：`crates/qaqh-ringing-contract/src/state.rs` — `SessionState` 新增
  `timeline_from_ord: Option<i64>`（serde default + skip_serializing_if，
  doc comment 含 compaction 例外与「非水位」声明）；additive 不 bump
  `SESSION_CONTRACT_REVISION`（仍 `ringing-session-2`）。
- store：`crates/qaqh-session/src/db/store.rs` — 新增
  `read_transcript_from` / `has_blocks_before` / `min_block_ord` /
  `min_turn_block_ord` / `latest_compaction_before`，行映射收敛为
  `map_block_row`；全部走既有 `idx_blocks_session` / `idx_blocks_turn` 索引。
- view：`crates/qaqh-session/src/db/view.rs` — 全量 `load_session_state` 不动；
  新增 `load_session_state_tailed`（内部 `load_session_state_inner` 共享组装）与
  `load_timeline_tail`（§4.2 算法）；块解析收敛为 `parse_block_entry`（ord 回填
  保留）。
- owner：`crates/qaqh-session/src/owner.rs` — 新增 `snapshot_tailed`（先水位
  再读库，B01 纪律同 `snapshot`）。
- daemon：`crates/qaqh-daemon/src/axum_server/axum_impl/v2.rs` —
  `handle_bootstrap_v2` 加 `BootstrapQuery.timeline_tail`（Option<String> 手工
  解析，受控 400 错误形态），`parse_timeline_tail` clamp
  `[1, MAX_TIMELINE_TAIL_BLOCKS=2000]`；路由表无新条目（query 参数非路由）。
- 测试：`view_tests.rs` 5 例（含尾窗==全量、无头回合、回退覆盖全会话回退 None、
  compaction 头插、`session.turn` 切片一致性）；`owner_tests.rs` 1 例
  （尾窗载荷 + 水位不变）；`v2.rs` 参数解析 1 例（缺席/合法/0/超界/非法）。
  `cargo test -p qaqh-session --lib` 39 通过；daemon 测试与全量回归见验收记录。
