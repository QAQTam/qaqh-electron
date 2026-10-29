# 内嵌浏览器与元素批注 需求单（Draft v0.1）

> 状态：需求评审稿。分期 P0-P3；P0/P1 纯 Electron 侧（本仓库即可完成），P2 起跨仓库。
> 参照系：ZCode（`/home/qaqtamsy/Projects/ZCode`）已实现同能力，本文只移植架构思路，不复制代码。

## 0. 一句话

在桌面壳内提供**可见的应用内浏览器（IAB）**与**元素批注**（用户点击页面元素 → 结构化锚点随消息进会话流），并为后续**模型驱动浏览器操作（browser-use）**预留协议面。核心动机：① 调试前端不必跳出应用另起浏览器；② 消灭"盲目截图 + 口头形容"——用户指哪，模型精确知道是哪个元素。

## 1. 背景与动机

- 前端调试场景：vite dev server 常驻 5173，希望壳内直接打开、配合会话问答迭代 UI。
- browser-use 生态（Playwright/Puppeteer）是 Node 的，而我们的 agent 后端是 Rust——**这不是障碍**：浏览器宿主放在 Electron 壳（本来就是 Node/Electron），Rust daemon 只做协议转发。CDP 本身是 JSON-over-WebSocket 协议，语言无关。
- 批注的关键洞察：模型操作页面的 ground truth 是 ARIA 树（ZCode 的 `domSnapshot()`）。把用户点击**映射到同一棵树上的节点**，模型拿到的就是可直接定位的锚点，而不是像素坐标猜测。

## 2. ZCode 现状盘点（已验证）

| 能力 | ZCode 实现 | 对我们的启示 |
|---|---|---|
| 浏览器后端 | `iab`（desktop 宿主提供）/ `cdp`（CLI headless）/ `extension` | 采纳 iab 优先、headless 可选的后端划分 |
| IAB 实现 | **main 进程 `WebContentsView` + CDP**，命令经 host↔main 桥执行 | 同路线；明确不采用 `<webview>` tag（ZCode 已弃） |
| 观察面 | `tab.playwright.domSnapshot()` 返回 ARIA 树 | 批注映射的目标树 |
| tab 语义 | 受控 tab / 用户 tab 双注册表 | 批注场景"用户正在看的页面"优先 |
| 技能层 | `control-browser` + `web-gui-tester` | P2 再评估复用或自建 |

## 3. 架构决策

```
┌─ qaqh-electron 壳（Node/Electron）──────────────────┐
│ WebContentsView（IAB，叠在 #app Main 区之上）        │
│ webContents.debugger → CDP session                  │
│ 批注 picker 注入 / URL allowlist / 独立 partition    │
└──────────────┬──────────────────────────────────────┘
               │ P1: 批注结果 = 消息附件（纯内容搬运）
               │ P2: host.tool 透传（browser.* 命令双向）
┌──────────────┴──────────────────────────────────────┐
│ qaqh-backend（Rust daemon）                         │
│ P1: 零改动。P2: browser.* 工具 schema + 转发代理     │
└─────────────────────────────────────────────────────┘
```

**决策 D1：WebContentsView，不用 `<webview>` tag。** webview 需重开 `webviewTag` 且被 Electron 边缘化；WebContentsView 由 main 管理，与 ZCode 同路线，生命周期/CDP 控制都在 main，崩溃隔离更好。
**决策 D2：批注先行，自动化后行。** P0+P1 不动 Rust、不动协议，用户价值先落地；P2 的协议面依赖 P1 验证过的 CDP 管道。
**决策 D3：独立 session partition + URL allowlist。** IAB 不共享宿主登录态与 cookie；allowlist 首期仅 `localhost:*` / `127.0.0.1:*`（覆盖前端调试主场景），扩展走白名单配置。
**决策 D4：CDP 多客户端共存。** 壳内 `webContents.debugger` 与（远期）Rust `chromiumoxide` 可同时挂同一目标，P3 不需要推翻 P0-P2。

## 4. 跨仓库锚点清单

### 4a. qaqh-electron（实施主仓库）

| 锚点 | 角色 |
|---|---|
| `src/main/index.ts` | `canControlWindow` 守卫、窗口/托盘管理；**WebContentsView 挂载与生命周期落点** |
| `src/main/ipc-handlers.ts`（renderer→main 受限 RPC 白名单，见 `session.rename` 先例） | 批注卡保存/读取走此处新白名单项 |
| `src/main/ringing-client.ts`（L233 `serviceRpc` / L187 `command`） | 壳→daemon 既有 RPC 通道；P2 的 host.tool 转发复用 |
| `src/preload/index.ts` | 新桥照 `windowControls`/`powerBlocker` 先例：`browserHost.*` |
| `webui/src/lib/desktop-host.ts` | 壳能力类型面：`BrowserHostBridge` |
| `webui/src/app/App.tsx`（#app 2-3 列 grid） | IAB 视图开关；WebContentsView 覆盖区域 = Main 格的 bounds |
| `docs/shell-layout-spec.md` | 布局约定遵循 §4（Main 格几何） |

### 4b. qaqh-backend（Rust，仅 P2 起动）

| 锚点 | 角色 |
|---|---|
| `crates/qaqh-tool-core/src/tool_api/`、`tool_capabilities.rs`、`permission.rs` | `browser.*` 工具 schema、能力声明与权限门 |
| `crates/qaqh-runtime/src/service/`（`plan.rs`、`common.rs`） | daemon 服务层：host.tool 透传调用点 |
| `crates/qaqh-daemon/` | conn/lease 面上新增透传类目 |

### 4c. ZCode（只读参照，不移植代码）

| 锚点 | 读什么 |
|---|---|
| `packages/desktop/src/host/browserControlMainBridge.ts`（401 行） | 命令桥形态：`BrowserExecuteRequestMessage`/`Result`、requestId 关联、超时处理 |
| `packages/desktop/src/host/index.ts`（4157 行，搜 `iab`/`WebContentsView`） | IAB 运行时注册、生命周期；**注意源码注释"CDP-on-guest pivot"——他们踩过的坑，开工前精读** |
| `bundled-agents/linux-x64/glm/packages/browser-use-plugin/docs/overview.md` + `api.json` | 操作面全集与 manifest 裁剪机制 |
| `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-browser-use-iab-*.json` | 多 tab 生命周期/全链路验收参照 |

## 5. 分期需求

### P0 — IAB 基座（本仓库，预计 1-2 天）

- [ ] `src/main/browser-host.ts` 新模块：`WebContentsView` 创建/挂载/隐藏/销毁；跟随 Main 格 bounds（ResizeObserver → `setBounds`）；随窗口关闭销毁。
- [ ] 导航 UI（渲染层）：地址栏 + 后退/前进/刷新 + "打开批注"入口；IAB 开关进 TopBar 或侧栏 Nav。
- [ ] 安全边界：独立 `session.fromPartition("persist:iab")`；`setWindowOpenHandler` 一律拒绝或转 IAB 内导航；`setPermissionRequestHandler` 默认拒绝（geolocation/notifications/media 全拒）；URL allowlist（首期 localhost/127.0.0.1，越界显示拦截页）。
- [ ] 生命周期：懒创建（首次打开才建）；会话切换藏/显不销毁；崩溃（`render-process-gone`）自动重建并提示。
- [ ] preload 桥 + `desktop-host.ts` 类型 + 渲染层开关信号。

### P1 — 元素批注（本仓库，预计 1-2 天）

- [ ] 批注模式：经 `webContents.debugger` 注入 picker（`Page.addScriptToEvaluateOnNewDocument` + 导航后重注入）：mousemove 高亮框、click 拦截默认行为并采集目标。
- [ ] 元素采集：CSS 路径 + role/accessible name + bounding box + `DOMSnapshot.captureSnapshot` 对齐 ARIA 节点 + 元素截图裁片。
- [ ] 标注卡（渲染层浮层）：展示锚点摘要，用户可附加一句话说明；确认后按 §6 schema 组包。
- [ ] 组包走 `ipc-handlers.ts` 新白名单项存为消息附件；会话流里渲染为可折叠卡片（锚点 JSON + 裁片图）。
- [ ] Esc / 再次点击工具条退出批注模式；批注期间禁导航。

### P2 — 模型驱动 browser.*（跨仓库：本仓库 + qaqh-backend）

- [ ] 工具面（首期最小集）：`browser.open / goto / snapshot / click / type / screenshot / annotate list`；操作结果 JSON 化。
- [ ] 壳侧：`host.tool` 透传通道（复用 `ringing-client.serviceRpc` 形态），main 内执行于 IAB 的 CDP session。
- [ ] Rust 侧：`qaqh-tool-core` 注册工具 schema + 能力声明；`qaqh-runtime` service 增透传调用；**权限门**：导航/只读观察自动放行，点击/输入类走 `qaqh-permission` 既有审批流。
- [ ] daemon↔壳断线语义：命令带 requestId + 超时（参照 ZCode 桥的 pending 关联）；壳离线时工具明确报错，不悬挂。

### P3 — headless / CI（可选，未排期）

- [ ] Rust `chromiumoxide` 直连 CDP 的 headless 后端（CI 前端验证、无壳环境）；与 P0-P2 的 D4 多客户端共存。

## 6. 批注附件 JSON schema（草案）

```jsonc
{
  "kind": "browser-annotation",
  "url": "http://127.0.0.1:5173/session",
  "tab_title": "QAQH",
  "captured_at": "2026-10-29T00:00:00Z",
  "element": {
    "role": "button",
    "name": "发送",
    "css_path": "#composer > div.toolbar > button.send",
    "aria_ref": "button-42",          // 对齐 DOMSnapshot ARIA 树的节点标识
    "bounding_box": { "x": 912, "y": 741, "width": 64, "height": 32 },
    "screenshot_ref": "<content-id>"  // 裁片图走 uploadContent 通道
  },
  "user_note": "这个按钮在窄屏下溢出了"   // 用户可选附言
}
```

模型侧约定：`aria_ref`/`role`+`name` 是首选定位依据，`css_path` 兜底，`bounding_box` 仅用于视觉对齐说明。

## 7. 非功能需求

- **安全**：IAB 与宿主完全隔离（partition/cookie/storage）；allowlist 外导航硬拦截；渲染进程崩溃不波及宿主窗口；批注注入脚本只在显式开启时活动，且 `Page.removeScriptToEvaluateOnNewDocument` 随模式退出清理。
- **性能**：懒创建；本机内存紧张（7.9G，历史 OOM），IAB 隐藏超过 10 分钟自动销毁释放（再次打开重建）；`backgroundThrottling` 保持默认开启。
- **可观测**：main 侧 IAB 崩溃/CDP 断开进 `conn://error` 同级事件面；批注失败（ARIA 对齐失败降级为 css_path-only）在标注卡明示。

## 8. 风险与已知坑

1. **ZCode 的 "CDP-on-guest pivot" 注释**表明 WebContentsView 上的 CDP 曾出问题导致他们摇摆到 `<webview>` 又改回——开工前精读其现状实现，复刻其最终形态而非中间态。
2. 本机 OOM 历史（Edge 被 OOM 杀）→ §7 的闲置销毁是硬需求，不是优化项。
3. Wayland 下的 D-Bus inhibit/GPU 兼容不在本单范围，但 IAB 的 GPU 进程崩溃恢复路径必须测。
4. `serviceRpc` 形态是否适合高频双向命令（P2）需在开工时确认；不合适则以 lease 通道加独立 ws 类目。
5. 批注 ARIA 对齐在 canvas/shadow DOM 场景可能失败——降级路径（css_path + 截图）必须一等公民。

## 9. 验收标准

- P0：`just dev` 后壳内打开 `http://127.0.0.1:5173`，导航/后退/刷新可用；allowlist 外 URL 被拦截页挡下；IAB 崩溃后 2s 内自动重建；关闭 IAB 后宿主内存回落。
- P1：对任意可访问元素批注，产出的 JSON 中 `role+name` 或 `css_path` 至少一个非空且能唯一定位该元素；批注卡在会话流可折叠展示、裁片图可看；批注模式下页面导航被禁。
- P2：模型通过 `browser.snapshot` 拿到与批注同一棵 ARIA 树；点击类操作触发权限审批；壳离线时工具返回明确错误。
- 回归：P0/P1 不引入对既有 34 个 visual-capture 场景的几何影响（IAB 关闭时零布局参与）。

## 10. 开放问题

1. IAB 入口放哪：侧栏 Nav 2×2 已满（会话/任务…），候选是 TopBar 图标或 Nav 扩 2×3——P0 开工时定。
2. 批注卡是否要支持"多选元素"（一次框选多个）——首期单元素，多元素看使用反馈。
3. P2 工具面是否直接对齐 ZCode `api.json` 的语义命名，便于将来共享技能文档——倾向对齐。
