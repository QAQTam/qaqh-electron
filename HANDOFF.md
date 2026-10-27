# Electron 迁移交接

## 目标与工作原则

目标是让 Electron 桌面端达到接近原 Tauri 桌面端的功能，必要时修正原实现中不符合当前后端契约的行为。用户明确要求：**不要继续以 Tauri 实现做逐行审计；从 Git 历史识别功能需求，再使用 Electron 原生方式实现。不要派生 subagent。**

涉及仓库：
- 本仓：`qaqh-electron`，Electron 主进程、preload、打包。
- `../qaqh-desktop-app`：SolidJS renderer。其工作区保留大量迁移中的修改，原 `src-tauri/` 文件在工作区被删除，但仍可只读 `git show HEAD:src-tauri/src/...` 获取功能参考。不要恢复、覆盖或清理这些未提交修改。
- `../qaqh-sdk`：Ringing v2 TypeScript SDK，不是桌面宿主；原生窗口、截图等由 Electron 负责。
- `../qaqh-backend`：daemon 和服务契约。服务语义以现有后端实现及实际运行测试为准，不要将旧 Tauri 的限制直接当作正确契约。

本仓及其他仓库均存在既有未提交修改，不要重置、清理或擅自覆盖。完整构建脚本可能安装依赖、编译后端、覆盖构建产物并在成功时替换 release，执行前先了解 `scripts/build-all.mjs`。

## 本轮已完成（截至交接）

- 修复托盘创建窗口后 TypeScript 将 `mainWindow` 推断为 `never` 的编译问题；窗口唤起统一使用 Electron 的 `restore`、`show`、`focus`：`src/main/index.ts`。
- 前端使用的 `session.rename` 加入受限 RPC 白名单；显式提供的 `session_id` 不再要求另有活动会话：`src/main/ipc-handlers.ts`。
- IPC 在启动时注册；daemon 初始连接失败后，后续 IPC 可单航班尝试连接；连接失败仍明确抛错。恢复流程仍需真实 UI/daemon 测试：`src/main/index.ts`。
- 旧 daemon 停止重连前保存活动 session，重连后尝试恢复 attach：`src/main/ipc-handlers.ts`。现有测试验证恢复 helper，尚非真实 daemon 停机集成测试。
- `fs.list`/`fs.read` 按后端的可选会话契约运行，保留调用方显式传入的 `scope_session_id: null`。后端仍负责 allowed roots 与敏感路径保护：`src/main/ipc-handlers.ts`，`../qaqh-backend/crates/qaqh-runtime/src/service/fs_git.rs`。
- 基于历史功能清单补回若干受会话约束的只读 RPC（如 session dashboard、todo、plan、git 查询）；仍保留白名单，不开放任意 RPC。
- `host_process_group` 使用 Electron `app.getAppMetrics()`，排除已通过 `host_memory` 统计的主进程，按 KiB 转 bytes 并保留缺测：`src/main/process-metrics.ts`。前端 `../qaqh-desktop-app/src/lib/hostmem.ts` 对 Electron 来源不再将 JS 堆重复加入合计。

## 最后验证

- Electron：`pnpm run typecheck && pnpm run build && pnpm test` 通过，44/44 tests。
- Renderer：`pnpm run typecheck && pnpm exec vitest run tests/hostmem.test.ts` 通过，16/16 tests。
- 上一阶段 SDK `pnpm test` 通过，35/35；这并不代表全功能端到端验收。
- **未运行真实 Electron 窗口 + daemon 的完整端到端测试、平台截图测试或完整 Linux 发布包验收。**进程指标转换及窗口操作当前主要有单元/编译验证，未进行跨平台 GUI 验证。

## 下一步优先事项

1. **实现原生截图与安全附件流。** 当前 `capture_screenshot` 明确报不支持（`src/main/ipc-handlers.ts`），前端 `screenshotSupported` 恒为 false（`../qaqh-desktop-app/src/lib/screenshot.ts`）。功能需求包括 selection、fullscreen、用户取消与错误区分；通过 Electron 原生能力设计，不能把整屏冒充选区。考虑 Wayland/X11/macOS/Windows 权限、显示器缩放和多屏、截图时机与遮罩、多次并发、取消和临时文件清理。截图生成的路径须以受控方式加入现有一次性附件许可（见 `approvedAttachmentPaths`），不应为 renderer 打开任意文件读取。平台不可用时诚实报错或隐藏能力，不能静默成功。先完成可测试设计，再在真实桌面环境逐平台验收。
2. **真实 Electron + daemon 冒烟与恢复验收。** 使用隔离数据目录与测试 daemon，覆盖启动/启动失败后恢复、创建与 attach、消息、流、审批、重命名、会话恢复、退出及托盘。避免未经用户确认关闭或改写用户正在使用的 daemon 和会话。`../qaqh-sdk/scripts/acceptance.mjs` 主要为协议只读验收，不能替代 Electron UI E2E；现有 `scripts/test-connection.mjs` 不能把打印成功当作全面验收。
3. **核对前端实际使用的 IPC 与后端响应。** 设置/配置、工作区、skills、todo、账户、模型、文件、配对/LAN、timeline 分页和重连需要针对真实 daemon 验证。SDK 的生成 coverage 中一些项目标记 pending，但后端当前源代码已有部分相应服务；pending 不等于服务肯定缺失，也不等于已验收。
4. **继续原生桌面能力。** 原 Tauri Git 历史可参考需求（`git show HEAD:src-tauri/src/lib.rs`、`commands.rs` 等）；原生主题/材质当前 `set_window_theme` 返回 false；Electron 进程组指标的跨平台可用性和单位需在真实应用验证。Linux 打包脚本仅支持 Linux x64（`scripts/build-all.mjs`）。
5. **自动化防回归。** 在保持发送方校验、固定白名单、token 留在主进程、审批 challenge 隔离的前提下，为前端 HostCommand/service 使用、SDK wire 与后端契约添加测试；对暂不支持的功能明确显示而非假成功。

## 重要注意

- 用户此前明确要求不要 spawn subagents；沿用该限制。
- 当前 frontend 工作区有大量迁移改动和 Tauri 删除项；这些都是工作区状态，不应自动恢复或清除。
- 本轮没有证明原 Tauri 全功能等价；不要称迁移完成。
- 每次改变源码后运行适当测试/构建；无法进行真实平台或 daemon 验收时明确说明。
