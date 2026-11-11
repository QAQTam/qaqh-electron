# Browser Control 设计（QAQ-Harness Electron）

状态：**已实现并通过隔离验证**（2026-11-11）。本文档是 browser-control 功能的唯一设计真源。

## 验收记录（全部实测，非推断）

| 验证项 | 方法 | 结果 |
|---|---|---|
| MCP server ↔ 真 rmcp 客户端互操作 | LTS `qaqh-daemon.exe` release 构建实连（`QAQH_ALLOW_TEST_DATA_ROOT=1` 隔离数据根 + 桩 handler） | ✅ 协议协商 2025-11-25、`cached 9 tool(s)`、resources/prompts 空集 |
| MCP 协议面（JSON-RPC） | `node --test scripts/browser-host.test.mjs`（真实 HTTP 往返） | ✅ 9/9：initialize/session/202 通知/GET 405/404 重握手/DELETE/未知工具 isError/未知方法 -32601 |
| 引擎全部工具行为 | `electron.exe` 真实主进程 e2e（`.tmp/browser-stub/engine-e2e-runner.cjs`，data: URL fixture） | ✅ 14/14：navigate/snapshot/click(真实鼠标事件)/type(char 事件)/Enter/screenshot 落盘 8.6KB/console 捕获/scroll/失效 uid 明确错误/close |
| 壳启动接线（dev bundle） | `electron.exe dist/main/index.cjs` 隔离数据根真启动 | ✅ `[browser] MCP server listening on 127.0.0.1:<port>; config.toml updated`，TOML 形态正确，renderer 正常加载 |
| 生产打包 | `just frontend-rolling`（3.0.20261111-5） | ✅ electron-builder ASAR 校验 103 文件 + daemon 匹配当前构建 + 签名；exe 启动到单实例锁检查（用户活动实例在跑，锁冲突为既有行为，未杀用户实例） |
| 类型/单测回归 | `pnpm run typecheck` + `pnpm --dir webui run typecheck` + `node --test scripts/*.test.mjs` | ✅ 全绿 |

未覆盖（残余风险，低）：daemon 会话内真实模型发起的 tools/call 全链路（bridge.rs 通用机制，对所有 MCP server 同构；握手与 tools/list 缓存已实测）。GUI 面板视觉验收待用户进行。

## 目标

agent（daemon 内的模型）可以打开、导航、检视、操作网页并截图；用户可以在桌面壳里**看到** agent 正在操作的页面（IAB pane）。全部通过 daemon 已有的 MCP 摄入面接入，**零 Ringing 面改动、零 daemon 代码改动**。

## 非目标（MVP 明确不做）

- 视频录制、下载管理、Chrome extension 后端、多 tab 持久恢复、Playwright locator API 面
- iframe 内部元素操作（snapshot 标注 iframe 存在，操作限主 frame）
- 后端 config.save 扩展 mcp 写模型（后端 LTS 下个排期补全，见 docs 记录）

## 架构

```text
daemon (rmcp streamable-http client)
  → http://127.0.0.1:<ephemeral>/mcp  (Authorization: Bearer <per-boot token>)
  → Electron main: browser-host
      ├─ mcp-server.ts   @modelcontextprotocol/sdk StreamableHTTPServerTransport（stateful session）
      ├─ engine.ts       BrowserEngine：单 WebContentsView（persist:qaqh-browser 分区）
      │                  注入脚本 snapshot/act；capturePage 截图落盘
      └─ config-wiring.ts bootstrap 期拼接 config.toml [mcp] 段
  → 工具在会话唤醒时经 bridge.rs 动态注册（clear_dynamic + register_dynamic）
```

- 浏览器引擎 = Electron 自带 Chromium。无 Playwright、无浏览器下载、无新可执行组件。
- WebContentsView 按需创建；隐藏 = 从 mainWindow.contentView 摘除但保留 webContents（页面状态保活）；`browser_close` 销毁释放内存。
- 用户可见性口径（借 zcode IAB）：agent 首次导航自动展示 pane（"打开浏览器"），用户可隐藏；renderer 显示 URL 栏与"agent 正在操作"指示。

## 工具面（MCP tools，server 名 `qaqh-browser`，工具前缀 `mcp__qaqh-browser__*`）

| 工具 | 参数 | 行为 |
|---|---|---|
| `browser_navigate` | `url` | 打开/复用 pane 并导航；自动展示 pane；返回页面 title/url |
| `browser_snapshot` | 无 | 注入脚本产出紧凑可交互树：`[uid] role name "value"`，含 URL/title；uid 稳定到下次导航 |
| `browser_click` | `uid` | 注入脚本定位元素并派发真实鼠标事件序列（pointerdown/mousedown/pointerup/mouseup/click 于元素中心坐标） |
| `browser_type` | `uid`, `text`, `submit?` | 聚焦、逐键派发 keyboard 事件、submit 时补 Enter |
| `browser_press_key` | `key` | 页面级键盘事件（Enter/Tab/Escape/Arrow* 等） |
| `browser_scroll` | `direction: up\|down`, `amount?` | 滚动主 frame |
| `browser_screenshot` | 无 | capturePage → PNG 落盘 `<data_dir>/browser/shots/<ts>.png`；返回绝对路径，模型用 `read_image` 查看（bridge.rs:335 丢弃 MCP 图片内容，落盘是既定绕行口径） |
| `browser_console` | `level?: log\|info\|warning\|error` | 返回累计 console 消息（环形缓冲 200 条） |
| `browser_close` | 无 | 销毁 pane 释放内存 |

错误口径：所有失败返回单行 `error: <原因>（<下一步建议>）`，如 `error: 桌面壳未运行，浏览器工具依赖 QAQ-Harness 桌面端`。

## 生命周期

```text
closed --navigate/工具调用--> creating → live(attached|detached) --browser_close/window 关闭--> closed
```

- `attached`：WebContentsView 在主窗口 contentView 上（可见）；`detached`：已摘除但 webContents 存活。
- 导航/操作不改变 attached 状态，只有用户显式隐藏或关闭才变。
- 壳退出即销毁；daemon 不持任何浏览器状态。

## config 接线（唯一写入点：Electron bootstrap）

`bootstrapApp()` 在 `ensureClient()` **之前**执行 `wireBrowserMcpConfig()`：

1. 启动 HTTP server 绑定 `127.0.0.1:<ephemeral>`，生成 per-boot token；
2. 对 `<data_dir>/config.toml`（路径复用 `daemon.ts getDataDir()`，与 daemon `qaqh_types::platform::data_dir()` 同源）做**段级拼接**：
   - 无 `[mcp]` → 追加整段；
   - 有 `[mcp]` → 仅替换 `[mcp.servers.qaqh-browser]` 子段（到下一个 section 头），并确保 `enabled = true`；
3. 幂等：url/token 未变则不写盘。

写入形态（qaqh_types::PersistentMcpConfig，snake_case 键）：

```toml
[mcp]
enabled = true

[mcp.servers.qaqh-browser]
url = "http://127.0.0.1:PORT/mcp"
headers = { Authorization = "Bearer TOKEN" }
default_timeout_secs = 120
```

竞态约束：Electron 只在 bootstrap 期写该段、运行期不调用 `config.save`；daemon 唤醒重读配置重扫 MCP（service.rs wake 路径）。用户手动关闭入口 = 删除该段或 settings 开关（P4）。

安全：server 只绑回环 + Bearer token 校验；token 仅存在于本机 config.toml（与 daemon 同信任域）；renderer 无任何到该 server 的通道（CSP 不动）；pane 的 webContents 使用独立分区与独立 session，不与 app:// 渲染器共享。

## 交接与测试策略

- 单测（node --test，纯函数）：TOML 段拼接（追加/替换/幂等）、snapshot 序列化器、MCP JSON-RPC 往返（initialize→tools/list→tools/call 经真实 HTTP）。
- 隔离验收：`--user-data-dir` 独立实例 + `data:`/本地 fixture 页面驱动全部工具。
- 生产：`just frontend-rolling`（前端独立打包，不重编后端）→ ASAR 校验 → 真机冒烟。
