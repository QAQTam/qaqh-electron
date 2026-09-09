# qaqh-electron UI 设计：顶部标签页工作台

> 状态：设计定稿 v1 · 2026-09-09
> 技术栈：SolidJS 2（2.0.0-rc.6）+ Vite 8 + TypeScript + Electron 44 + qaqh-js-sdk
> 输入：WinUI3 壳（QAQTam/qaqh-winui-app，含 docs/nextdev/tab-session-redesign.md）、
> bindings 类型映射（72 个 ts-rs 类型）、design-taste-frontend 审美纪律

---

## 0. Design Read

**读法**：AI 编码代理的桌面工作台（product UI，非 landing），受众是开发者/prosumer；
视觉语言走 "calm terminal" 工程美学；刻度设定 DENSITY=高、MOTION=低、VARIANCE=中——
刻意反"侧边栏聊天应用"范式，向 IDE/浏览器的心智模型靠拢。

## 1. 反范式声明：为什么没有左侧栏

WorkBuddy / zCode / Claude Code Desktop / Codex Desktop 共享同一套骨架：
左侧栏（导航 + 会话列表）+ 中央聊天列 + 底部输入。本设计把会话管理整体上移：

| 职责 | 千篇一律做法 | 本设计 |
|---|---|---|
| 会话切换 | 左侧列表项 | **顶部标签页**（seed 为 key） |
| 历史/归档 | 侧栏长列表 | **⌘K 命令面板**（模糊搜索 seed/title/路径） |
| 全局导航 | 侧栏图标列 | 标签条右端 `···` 菜单 + 命令面板 |
| 工具/事件/用量 | 塞在消息流里 | **呼出式检查器**（右侧抽屉，默认收合） |
| 连接状态 | 无处安放 | **1px 全局状态线**（底部常显） |

依据一：用户自己的 WinUI3 壳已验证「TabView 会话标签 + 状态圆点」可行
（session_tabs.rs + tab-session-redesign.md），侧栏退役条件在该文档 §5 已写明。
依据二：协议上 lease 是**连接级共享**（一次 open，三频道 SSE 多 seed 复用），
会话不是孤岛而是同一条连接上的多路复用——标签页隐喻恰好与协议拓扑同构。

## 2. 布局五区（自上而下）

```
┌────────────────────────────────────────────────────────┐
│ A 标签条（并入标题栏，frameless 拖拽区）h=36            │
├────────────────────────────────────────────────────────┤
│ B 上下文条：cwd ▸ 子目录 · mode · model · 上下文%  h=24 │
├──────────────────────────────────┬─────────────────────┤
│ C transcript（turn 轨线 + 折叠）  │ D 检查器（呼出式）   │
│   全宽 240~ 收合时占满            │   工具/diff/事件     │
├──────────────────────────────────┴─────────────────────┤
│ E composer：输入 + plan/code 分段 + 附件 + 模型    h≥56 │
├────────────────────────────────────────────────────────┤
│ F 全局状态线：daemon·lease·epoch · tabs 汇总      h=20 │
└────────────────────────────────────────────────────────┘
```

- **A 标签条**：`+` 新建（消费 `session.created` 事件置 active，禁止轮询 diff——
  WinUI3 D2 教训）；右键菜单 = 归档/重命名/复制 seed/关闭；Ctrl+Tab 轮转；
  选中回调必须携带 seed（key），禁止 index→nth 反查（D1 教训）。
- **B 上下文条**：每标签页自己的上下文（cwd basename、plan/code、model、
  token 预算占比），数据源 `session.list` 富元数据 + `skills_updated`。
- **C transcript**：turn 左轨线（序号圆点：实心=完成/空心=运行中），round 折叠，
  block 四种：reasoning 折叠面板 / text markdown / tool 卡 / notice 条。
- **D 检查器**：三页签 工具（调用卡流）/ diff（本次会话累计 code_changed）/
  事件（原始事件流，调试用）。默认收合，⌘I 或 hover 标签右缘呼出。
- **E composer**：plan/code 分段切换（`conversation_set_mode`）、附件
  （先 POST /content 换 ContentRef，禁传本地路径）、Enter 发送。
- **F 状态线**：lease 剩余、epoch、掉线全标签页告警——因为续租失败 =
  所有标签页同时掉线，这个信息必须全局可见，这是协议约束催生的独特元素。

## 3. 标签页系统（协议硬约束直接塑造）

每标签页状态机（来源 `session_activity_changed` + channel.state）：

| 状态 | 视觉 | 数据源 |
|---|---|---|
| working | 绿点呼吸 | activity=working |
| waiting_user | 琥珀徽标 = pending 权限+提问数 | activity=waiting_user（汇总态，悬停细分） |
| streaming | 青点 + tab 内光标 | text_delta 活跃 |
| disconnected | 空心灰点，点击重试 | activity=disconnected |
| archived | 灰底沉末位 | meta.archived |

架构铁律（来自类型映射，违反必坑）：
1. **seed→tab 分发器**：3 条 SSE 频道连接全标签页复用，envelope.seed 逐事件
   路由到对应 tab 的独立 Projection 容器（SDK `Map<seed, SessionView>` 已是此形状）。
   绝不每标签页开一条流。
2. **tab-session-redesign 全部教训内置**：key 化选中、`session.created` 消费 +
   pending 标记（15s 兜底）、创建后 workspace 对齐、禁止 selected=-1 降级。
3. **RingingResetRequired{channel,seed}** = 单标签页单频道精准重建；
   `server_epoch` 变化 = 全标签页重建。两种恢复粒度分开处理。
4. `ConversationLoadMore` 设计性 422，翻页只走 timeline `before_turn`。
5. 子代理 ephemeral 会话不出现在标签条（关闭即删）；archived 需显式操作才显示。

## 4. Transcript 渲染规则

- turn 排序按 `created_seq`（0 时回退 turn_id 数字后缀）；block key 用
  `block_order`，禁用数组下标。
- **sealed 前后双渲染**（协议注释明确）：open 状态纯文本流式追加（无格式，
  避免半截 markdown 围栏抖动）；`block_sealed` 后切换 markdown + 代码高亮。
  这是流式体验的核心开关，也是与竞品"边流边渲 markdown"的差异点（后者必抖）。
- 工具卡：`name + summary` 一行卡；展开 = args JSON 高亮 + output 终端块
  （尾部保留）+ diff 抽屉（diff 只进渲染器，永不进模型投影）。
  四态徽标 prepared/running/succeeded/failed；`backgrounded` 常驻指示器；
  大输出 `output_ref` 走 content 端点懒加载。
- 性能预算（继承 WinUI3 实测值）：事件 16ms 帧化 drain、live 渲染 8ms 节流、
  滚动跟随 100ms 节流；Solid 细粒度更新下预期更宽裕。

## 5. 审批与交互闭环

- **审批卡**（composer 上方浮出）：risk 徽标（high/med/low → 红/琥珀/绿）、
  工具名、reason、paths、category、consequence、**120s 倒计时环**（硬 TTL，
  逾期 Expired）。
- 响应映射协议 2×2（approved × trust_folder）→ 三按钮：拒绝 / 允许一次 /
  信任此目录（`tool_permission_respond`）。
- **AskQuestion**（interaction_requested）：内联问卷卡，options 单选 +
  allow_custom 自由输入；批量 ask 走 single/batch 两种渲染。
- **plan_review**：全宽计划卡，TodoItem[] 清单 + 通过/驳回。
- 全部待办汇入标签徽标 + 状态线汇总（"1 等待用户"）。

## 6. 视觉令牌

- **色**：单一品牌强调 teal（#0F6E56 系），语义状态色 green/amber/red 仅用于
  状态语义；禁 AI 紫、禁蓝紫渐变。浅色为主，深色跟随 nativeTheme。
- **字**：界面 MiSans VF / system-ui；代码 Cascadia Code → JetBrains Mono 回退；
  等宽字体承担"机器输出"语义（工具卡、事件流、路径全部 mono）。
- **圆角**：继承 WinUI3 的 4/8/12px 三档（控件/卡片/容器）。
- **动效**：120-220ms 淡入/上滑，仅用于标签切换、检查器展开、审批卡浮出；
  流式文本不加动画（性能预算优先）。
- **材质**：Windows 上 `BackgroundMaterial: 'mica'`（Electron 原生支持），
  macOS vibrancy；标签条与状态线半透明，内容区实底——Mica 的可用部分继承，
  XAML 依赖部分抛弃。

## 7. 从 WinUI3 继承 / 抛弃

**继承**：顶部 TabView + 状态圆点交互、transcript turn/round 模型、审批风险
语义与按钮文案、4/8/12 圆角体系、主题令牌化思路、流式节流参数。
**抛弃**：windows-reactor 原生 XAML 绑定、NavigationView 侧栏（职责被
标签条+命令面板吸收）、DispatcherTimer 轮询泵（换 SSE 事件驱动）、MSIX 链。

## 8. 里程碑衔接

- M0：壳 + 连接（daemon 发现/spawn、lease、三频道、seed→tab 分发器、状态线）
- M1：transcript 全渲染 + composer + 审批闭环（本设计核心区）
- M2：检查器 + 命令面板 + 打包（electron-builder，产物对齐 daemon /debug/ 布局）
