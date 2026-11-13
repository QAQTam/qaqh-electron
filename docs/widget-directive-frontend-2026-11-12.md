# Widget Directive 前端实施（指针文档）

主规范（唯一事实源，勿在此重复）：`D:\Projects\qaqh-backend\docs\widget-directive-protocol-2026-11-12.md`

本仓落点速查：
- 新增 `webui/src/widget/`：`directive.ts`（marked extension，block 独占行 / inline 静默吞 / JSON 失败降级一行占位）、`widget-host.tsx`（iframe 挂载、状态占位符替换、sendHeight 自适应、展开/收起保留活页面）、`bridge.js`（`window.qqh`，原型预捕获 + TextEncoder 16KiB 闸）。
- Electron 主进程：**（实施裁定 2026-11-12）不注册 `qqh-widget://` 特权协议**——fragment 文本经 daemon `fs.read`（scope_session_id 锁会话工作区）读取后由宿主组装 srcdoc；主进程仅新增 `widget_state_get_all`/`widget_state_put` 两条 host 命令（`src/main/widget-states.ts`，userData 单文件 kv）。CSP 由 srcdoc 内 meta 落实：`cdnjs.cloudflare.com, esm.sh, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com, fonts.gstatic.com, fonts.bunny.net` 白名单 + `connect-src 'none'`。
- `webui/src/markdown/render.ts`：接入 directive extension；DOMPurify 配置不需要动（marker 走 token，不走 HTML 通道）。
- `webui/src/tools/StepRow.tsx`：删 `surface_rendered` 分支；删 `webui/src/genui/` 全目录；`genui-check.tsx/html` → `widget-check.*`。
- 发送通道：`sendFollowUpMessage` 确认帧 → RingingV2 user-send 带 `widget_context {session_id, widget{path,title}, model_content}`（后端 §4）。
- `webui/src/api/qaqh/*`：等后端 contract 重生成（将新增 widget_context 字段、移除 surface_rendered 变体）。
- 状态存储：`privateContent` 落 Electron userData（键=fragment 绝对 path，唯一编码 workspace+session），`modelContent` 同时留作下轮发送快照（乐观、best-effort）。

顺序：主规范 §7 第 2 步。前置条件：后端 widgets_dir 在 system 环境块可见 + FsRead 放行。
