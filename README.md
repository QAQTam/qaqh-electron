# QAQ-Harness Electron 客户端定制方案与构建指南

针对 Linux 环境下 Tauri 2 的不稳定问题（WebKitGTK 渲染器崩溃、DMA-BUF 闪烁、中文输入法支持欠缺、发行版动态库依赖碎片化），本项目为 **`qaqh-backend`** 与 **`qaqh-desktop-app`** 定制了一套完整的 **Electron** 宿主与构建流水线。

---

## 目录
1. [背景：为什么 Tauri 在 Linux 下不稳定？](#1-背景为什么-tauri-在-linux-下不稳定)
2. [架构设计：Electron 替换方案](#2-架构设计electron-替换方案)
   - [进程模型与安全隔离](#进程模型与安全隔离)
   - [前端零改动 Preload 虚拟化适配](#前端零改动-preload-虚拟化适配)
   - [Ringing v2 客户端与 SSE 事件流转发](#ringing-v2-客户端与-sse-事件流转发)
   - [Daemon 生命周期与多开防护](#daemon-生命周期与多开防护)
3. [构建流水线设计 (CI/CD Pipeline)](#3-构建流水线设计-cicd-pipeline)
4. [项目结构说明](#4-项目结构说明)
5. [常用命令与使用指南](#5-常用命令与使用指南)

---

## 1. 背景：为什么 Tauri 在 Linux 下不稳定？

Tauri 2 在 Windows (WebView2) 和 macOS (WKWebView) 表现良好，但在 Linux 上基于系统的 **WebKitGTK** (`webkit2gtk-4.1`)，存在以下固有缺陷：

| 痛点维度 | Tauri 2 (Linux WebKitGTK) | Electron (Chromium + Node.js) |
|---|---|---|
| **渲染内核版本** | 取决于操作系统安装的库版本，老版本系统无法支持现代 CSS（如 `:has()`, `color-mix()`） | 自包含固定、现代版本的 Chromium，渲染表现 100% 确定一致 |
| **GPU / DMA-BUF 渲染稳定性** | NVIDIA 专有驱动/Intel 新集显/Wayland 下高频出现 DMA-BUF 崩溃、白屏、黑屏、窗口闪烁 | 经过 Chromium 成熟的沙盒与硬件加速调优，Wayland/X11 支持极佳 |
| **输入法 (IME) 体验** | fcitx5 / ibus 候选框经常脱离光标甚至无法调起，输入法回车上屏事件常被吞噬 | 原生级别的 IME 支持，输入法候选框定位精确 |
| **打包与系统依赖** | 打包出来的 deb/AppImage 依然动态链接系统 `libwebkit2gtk-4.1.so.0`，缺少库则无法运行 | 真正的自包含二进制打包（AppImage/deb 开箱即用，零额外环境依赖） |

---

## 2. 架构设计：Electron 替换方案

### 进程模型与安全隔离

```text
┌─────────────────────────────────────────────────────────────┐
│                    Electron 渲染进程 (Chromium)             │
│   SolidJS 2.0 WebUI (来自 qaqh-desktop-app/out/renderer)    │
│   调用 @tauri-apps/api (invoke / listen)                    │
└──────────────────────────────▲──────────────────────────────┘
                               │ IPC (contextBridge)
┌──────────────────────────────▼──────────────────────────────┐
│                    Preload 脚本 (Preload Bridge)            │
│   注入 window.__TAURI_INTERNALS__ (完全模拟 Tauri 2 IPC 契约) │
│   拦截 plugin:event|listen 并维护 callback 表               │
└──────────────────────────────▲──────────────────────────────┘
                               │ Electron IPC (tauri:invoke / tauri:event)
┌──────────────────────────────▼──────────────────────────────┐
│                    Electron 主进程 (Node.js)                │
│   1. DaemonManager (读写 daemon.json、探活、按需拉起 sidecar)  │
│   2. RingingClient (HTTP/SSE Ringing v2 握手、Lease 续租)   │
│   3. ChallengeManager (审批 challenge 64位十六进制隔离)      │
│   4. 原生对话框 (pickDirectory, pickAttachments, openExternal)│
│   5. 托盘图标与单实例锁 (requestSingleInstanceLock)          │
└──────────────────────────────▲──────────────────────────────┘
                               │ HTTP / SSE (Ringing v2 单流)
┌──────────────────────────────▼──────────────────────────────┐
│                    qaqh-daemon (Rust 后台进程)              │
│   Axum HTTP/SSE 服务、多会话 Agent 循环、沙箱、工具执行     │
└─────────────────────────────────────────────────────────────┘
```

### 前端零改动 Preload 虚拟化适配
`qaqh-desktop-app` 内部原本调用 `@tauri-apps/api/core` 的 `invoke` 以及 `@tauri-apps/api/event` 的 `listen`。
在 Electron 的 `src/preload/index.ts` 中：
- 暴露 `window.__TAURI_INTERNALS__.invoke`：将命令透传给 Electron 主进程的 `ipcRenderer.invoke('tauri:invoke', cmd, args)`；
- 拦截 `plugin:event|listen` 与 `plugin:event|unlisten`：在 Preload 中管理回调 ID，并将主进程推送的 `tauri:event` 包装为 Tauri 规范的 `{ event, id, payload }` 回调给前端组件；
- **效果**：`qaqh-desktop-app` 的编译产物 `out/renderer` **无需修改任何一行业务代码**，直接无缝跑在 Electron 中！

### Ringing v2 客户端与 SSE 事件流转发
Node.js 侧实现的 `RingingClient` 承担：
- **握手与 Lease 维护**：调用 `POST /ringing/v2/clients/open` 获取 Lease，并以 15 秒间隔调用 `POST /ringing/v2/leases/renew` 维持租约；
- **单活动流 (Active Seed Stream)**：前端 `attach(seed)` 时切换活动流，建立 `GET /ringing/v2/sessions/{seed}/events` 与 `GET /ringing/v2/sessions/{seed}/timeline` 两个 SSE 长连接；
- **事件转发**：解析收到的 SSE 数据包并实时发送至渲染进程：
  - `timeline://entry`（时间线增量）
  - `timeline://status`（连接状态 open / closed / reconnecting）
  - `timeline://snapshot`（快照数据）
  - `projection://event`（投影事件）
  - `projection://reset`（投影重置）
  - `conn://liveness`（心跳探活）

---

## 3. 构建流水线设计 (CI/CD Pipeline)

全流水线构建分为四个严格衔接的阶段：

```bash
[阶段 1: qaqh-backend]
  cargo build --release -p qaqh-daemon
  -> 拷贝产物至 resources/bin/qaqh-daemon

[阶段 2: qaqh-desktop-app]
  pnpm run build (Vite + SolidJS)
  -> 拷贝 out/renderer/ 到 renderer/

[阶段 3: qaqh-electron]
  esbuild 打包 main (src/main/index.ts -> dist/main/index.cjs)
  esbuild 打包 preload (src/preload/index.ts -> dist/preload/index.cjs)

[阶段 4: electron-builder]
  打包为 Linux AppImage / deb / tar.gz
  产出目录: release/
```

使用 `node scripts/build-all.mjs` 或 `pnpm run build:all` 即可一键完成跨仓全流程编译打包。

---

## 4. 项目结构说明

```text
qaqh-electron/
├── package.json              # 项目依赖与打包脚本
├── tsconfig.json             # TypeScript 配置
├── electron-builder.yml      # Linux 产物打包配置（AppImage, deb, extraResources 等）
├── .npmrc / pnpm-workspace.yaml # pnpm 构建安全策略配置
├── scripts/
│   ├── bundle.mjs            # esbuild 高性能多目标 bundle 脚本
│   ├── build-all.mjs         # 跨仓全流程一键构建脚本
│   └── dev.mjs               # 本地开发与调试启动器
├── src/
│   ├── main/
│   │   ├── index.ts          # 主进程生命周期、窗口管理、Wayland/IME 调优
│   │   ├── daemon.ts         # qaqh-daemon 自动发现、健康探测与子进程拉起
│   │   ├── ringing-client.ts # Node 原生 Ringing v2 HTTP/SSE 客户端
│   │   ├── challenges.ts     # 审批安全隔离 Challenge 管理
│   │   ├── native-dialogs.ts # 原生系统对话框、外部链接与附件上传
│   │   ├── skills-scanner.ts # 本地 ~/.qaqh/skills 扫描
│   │   ├── ipc-handlers.ts   # IPC 命令路由与 session_list 格式对齐
│   │   └── types.ts          # 类型定义
│   └── preload/
│       └── index.ts          # Tauri 2 虚拟化适配与 Electron 暴露网关
└── build/
    └── icons/                # 跨平台图标资源
```

---

## 5. 极端受限硬件（双核老奔腾/弱核显）极致轻量化调优

针对类似 **Intel Pentium G2020（双核双线程、无超线程、Ivy Bridge 老集显）** 这类极端受限环境，本项目实施了深度轻量化调优策略：

| 调优维度 | 优化措施 | 收益与作用 |
|---|---|---|
| **并发与进程数收敛** | 注入 `--renderer-process-limit=1` 与 `--disable-site-isolation-trials` | 杜绝 Chromium 为多标签/跨站派生多进程，消除双核软中断卡死 |
| **V8 堆内存硬约束** | 注入 `--max-old-space-size=256 --optimize-for-size --expose-gc` | 限制老生代堆内存最大 256MB，以字节码紧凑换取低内存常驻 |
| **功能剥离降负** | 禁用 3D/WebGL (`--disable-3d-apis`)、语音 (`--disable-speech-api`)、拼写检查 (`spellcheck: false`) | 纯代码文本应用无需 3D，关掉拼写检查直接减少 40MB+ 词库常驻并消除打字 CPU 峰值 |
| **I/O 与缓存节流** | 严格限制磁盘缓存 16MB (`--disk-cache-size=16777216`)、多媒体缓存 8MB | 避免磁盘密集 I/O 导致系统 Swap 剧烈颠簸 |
| **后台挂起与主动 GC** | 开启 `backgroundThrottling: true`，监听 `minimize` 主动清理缓存并执行 `global.gc()` | 最小化或切后台时挂起非必要动画与定时器，空闲 CPU 占用趋近于 0% |
| **SSE 长流安全保护** | 单帧数据设定 4MB 防御式安全上限 | 阻断大流量消息累积导致的内存突发暴涨 |

---

## 6. 常用命令与使用指南

### 开发模式
```bash
# 启动本地开发（自动注入低内存环境）
pnpm run dev
```

### 仅编译主进程与预加载脚本
```bash
pnpm run build
pnpm run typecheck
```

### 全流程跨仓一键构建与打包
```bash
# 执行完整流程（编译后端 daemon -> 编译前端 webui -> 编译 electron -> 打包 Linux 安装包）
pnpm run build:all
```

### 单独打包指定格式
```bash
# 打包 Linux 免安装解压目录
pnpm run package:dir

# 打包 Linux 通用 AppImage
pnpm run package:appimage

# 打包 Debian / Ubuntu deb 安装包
pnpm run package:deb
```
