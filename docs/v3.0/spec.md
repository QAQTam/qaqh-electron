# QAQH v3.0 MCP 商店规格

状态：待实现。基线：2026-11-06。

## 1. 首发范围

用户在 QAQH 中选择一个 MCP 服务，配置凭据并安装，在会话中使用该服务的工具，也可以随时停用或卸载。首发以千问 One Key MCP 的 `WebFetch` 和 `EnhancedSearch` 验证完整链路。

| 优先级 | 交付 | 范围 |
| --- | --- | --- |
| P0 | MCP 商店 | 随应用发布的精选目录，支持搜索、查看详情、安装和打开上游商店 |
| P0 | 我的 MCP | 查看来源和状态，配置凭据，连接测试，启用、停用、卸载商店安装项 |
| P1 | 外部 MCP 导入 | 复用 daemon 的导入能力，提供逐项预览与确认，补齐 Codex 远端 HTTP 配置解析 |
| P1 | Claude Code / Codex 插件兼容 | 先导入本地插件包，再接公开 marketplace 目录。首批加载 skills 和 MCP，并逐项报告兼容状态 |
| 后续 | 更多来源和宿主能力 | 千问全量目录同步、工作区安装、OAuth、SSE、插件 hooks、agents、LSP、Codex apps、MCP Apps、MCPB |

P0 使用当前 daemon 用户域。同一 daemon 下的会话共享该用户域的安装结果。P1 独立上线。

## 2. 现状与复用

- `qaqh-backend` 已有 stdio、Streamable HTTP、工具白名单、连接管理、配置热重载，以及从 `secrets.toml` 解析 `${secret:name}` 的能力。继续走现有 MCP 工具投影和调用链。 [连接实现](/home/qaqtamsy/Projects/qaqh-backend/crates/qaqh-mcp/src/adapter.rs:133) · [配置热重载](/home/qaqtamsy/Projects/qaqh-backend/crates/qaqh-mcp/src/manager.rs:152)
- Electron 设置目前显示只读 MCP 表格。商店和管理操作通过现有客户端协议访问 daemon，SDK 更新同一契约。后端缺少对应能力时，客户端保留只读入口并提示升级。 [当前设置](/home/qaqtamsy/Projects/qaqh-electron/webui/src/settings/SettingsView.tsx:548) · [v3 客户端交接](/home/qaqtamsy/Projects/qaqh-electron/docs/electron-v3-client-verification-handoff-2026-11-04.md)
- 外部配置已有两条路径。daemon 自动只读合并用户级配置，CLI 支持显式导入。当前 Codex 解析器要求 `command`，会跳过仅配置 `url` 的远端服务。P1 扩展现有解析器并为跳过项提供诊断。 [外部配置实现](/home/qaqtamsy/Projects/qaqh-backend/crates/qaqh-config/src/mcp_import.rs:105)

## 3. P0 用户流程

1. 用户打开「MCP 商店」，按名称搜索并查看详情。详情展示提供方、服务用途、连接域名、鉴权要求、计费说明及上游链接。
2. 用户点「安装」，确认目标 daemon，并选择已有千问 MCP 凭据或填写新的 API Key。两个千问条目可引用同一凭据，更新共享凭据时显示受影响的服务。
3. daemon 保存安装记录和凭据引用，应用运行配置。安装成功后执行 MCP 握手和 `tools/list`。列表分别显示安装状态、启用状态和连接结果。连接失败时保留安装记录，允许更换凭据并重试。
4. 用户进入会话，调用已启用的服务。安装和测试连接只做握手及工具发现。用户在会话中触发实际工具调用，费用按服务方规则结算。
5. 用户可在「我的 MCP」停用、重新启用或卸载。停用保留配置和凭据。卸载移除该安装记录及其运行配置，保留可能被其他安装或配置引用的凭据。手写和外部只读条目显示各自的来源与管理方式。

## 4. 目录、安装与运行

| 对象 | 保存内容 | 所有者 |
| --- | --- | --- |
| 目录条目 | 稳定条目 ID、展示名称、提供方、服务 ID、官方链接、传输、endpoint、鉴权类型、计费说明 | 首版随 QAQH 发布的版本化目录 |
| 安装记录 | 条目 ID、稳定 server ID、已确认的连接声明、启用状态、凭据引用 | daemon 用户域 |
| 密钥 | 实际 API Key | daemon 现有 MCP secret store |
| 运行状态 | 当前配置对应的连接状态、脱敏错误、最近一次发现的工具数 | MCP manager |

- 首发目录包含 `qwen:webfetch` 和 `qwen:enhanced-search`，分别映射到 `qwen-webfetch` 和 `qwen-enhanced-search`。上游服务 ID 保留大小写。目录版本升级可以更新展示字段。已安装 endpoint 或鉴权目标的变化须经用户确认。
- 千问 endpoint 使用 `https://maas.qianwenaiapi.com/api/v1/mcps/<上游服务 ID>/mcp`，传输为 Streamable HTTP。请求头使用 `Authorization: Bearer ${secret:qwen_mcp}` 一类的本地引用。仅对预置的精确 HTTPS origin 注入凭据，禁止携带凭据跨 origin 跳转。
- 首发精选目录由 QAQH 维护。公开文档提供逐服务接入方式，目前未核实可用的公开全量目录 API。千问详情页是条目校验依据。 [外部调用](https://platform.qianwenai.com/docs/agent-infra/mcp/external-invocation) · [服务与计费说明](https://platform.qianwenai.com/docs/agent-infra/mcp/official-services) · [千问 MCP 商店](https://www.qianwenai.com/hub/mcp)
- 管理 API 以安装 ID 操作，和已存在的手写 server ID 冲突时拒绝覆盖。安装重试复用同一记录，写入在 daemon 串行化。持久化失败须恢复到操作前状态。进程中断后以已提交记录重建运行配置，未完成的变更可安全重试。
- 启停、卸载成功返回前，daemon 应使新的工具调用按更新后的配置校验。已发出的调用可完成。旧会话若持有陈旧的工具描述，调用时返回已停用或已移除状态。新会话读取当前配置。
- 安装、凭据写入和测试操作使用目标 daemon 的授权校验。列表、错误、日志和协议响应只返回脱敏内容与凭据引用。测试结果随配置修订关联，避免旧请求覆盖新状态。

## 5. P1 兼容边界

### 外部 MCP 配置

导入使用「扫描 → 预览 → 逐项确认 → 写入」。先支持现有用户级来源及显式选择的 Claude 项目 `.mcp.json`。Codex 补 `url`、静态 headers 和环境变量引用的诊断或映射。需要凭据时，引导绑定 QAQH secret。无法等价映射的传输、鉴权和字段逐项说明。项目配置进入预览前只解析数据，执行前展示命令、参数、工作目录或远端地址。

### 插件包和目录

1. 本地包识别 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json`。两个格式各自解析，统一输出插件身份、能力清单和兼容诊断。支持默认 `skills/`、`.mcp.json`，以及各格式已验证的 manifest 路径或内联 MCP 声明。Claude Markdown commands 经过语义验证后再映射。
2. 安装按来源和插件名记录固定版本或 Git revision。插件文件保存在 QAQH 管理的目录中，校验路径和符号链接的实际边界。插件贡献的 MCP 使用稳定的 server ID，并携带插件所有者信息。启用时把 skills 和 MCP 投影到各自的 runtime，停用时撤销该插件的贡献。
3. 目录适配独立于包加载。Claude 读取 `.claude-plugin/marketplace.json`，Codex 读取 `.agents/plugins/marketplace.json`。首批支持目录相对路径、Git 和 Git 子目录。下载后校验版本和路径，再预览能力。首次安装和会新增执行权限的更新均需确认。
4. 首批公开目录用 Anthropic 官方 Git 仓库验证。Codex 兼容目标覆盖能获取的包和目录，私有账号、专属连接器与外部鉴权机制按组件单独评估。

[Claude 市场格式](https://code.claude.com/docs/en/plugin-marketplaces) · [Codex 本地目录解析](/home/qaqtamsy/Projects/codex/codex-rs/core-plugins/src/marketplace.rs:20) · [ZCode 插件会话合并](/home/qaqtamsy/Projects/Zcode/docs/plugin-mcp-session-runtime-merge.md)

## 6. 实现顺序与上线门槛

1. **Backend** 实现安装记录、凭据绑定、启停和卸载。用本地 HTTP fixture 验证安装到会话调用的完整链路。
2. **SDK 和 Electron** 接管理契约、精选目录和「我的 MCP」，对齐目标 daemon 和协议兼容回退。
3. **联调发布** 使用专用千问 Key 验证两个条目的握手、工具发现及至少一次真实调用，记录脱敏结果。通过现有 Electron、SDK、daemon 的发布契约校验后上线。

| 验收项 | 通过条件 |
| --- | --- |
| 首次安装 | 两个条目都能完成安装并显示工具数，新会话能实际调用服务 |
| 凭据和错误 | 缺失或无效凭据、超时和网络失败可区分。重配后可重试，界面和日志无明文 Key |
| 生命周期 | 重复安装只产生一条记录。停用后无法开始新调用，重新启用恢复。卸载及重启后服务保持移除 |
| 配置保护 | 同名手写服务不会被覆盖或删除。模拟写入失败及进程中断后可恢复或重试 |
| 升级兼容 | 旧 daemon 下只读设置可用。升级后已有手写和外部 MCP 仍可用 |
| P1 插件验收 | 各用一个 Claude 和 Codex 样本验证安装、组件诊断、skills 可发现、插件 MCP 与用户 MCP 同时出现在新会话、停用后撤销贡献 |
