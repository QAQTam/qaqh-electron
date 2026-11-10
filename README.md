# QAQ-Harness Electron (canonical desktop host)

`qaqh-electron` is the first-class and only supported desktop shell. It hosts the SolidJS renderer in `webui/`, owns all OS privileges, daemon discovery credentials and lifecycle, and speaks Ringing v2 through the native `qaqh-napi-client` addon (Rust `qaqh-client`, shared with the TUI / Android / HarmonyOS shells). The renderer receives a narrow `window.qaqhHost` API; Node, Electron primitives, daemon bearer tokens, and unrestricted IPC are not exposed to it.

## Architecture

```text
webui renderer (Chromium)
  → contextBridge window.qaqhHost (fixed command + event contract)
  → Electron main process (runtime sender checks, service allowlist, native OS work)
  → qaqh-napi-client addon (Ringing v2, leases, commands, streams, pairing, graceful stop)
  → qaqh-daemon
```

There is no Tauri compatibility runtime. Main IPC is sender-validated and accepts an enumerated set of host commands; the service RPC bridge has a runtime allowlist and active-session scoping. Model-picker IPC is separately restricted to its native picker window. Electron keeps the daemon client and credentials in main.

The Rust client owns protocol work: Ringing handshake/lease renewal, service methods, command idempotency, SSE bootstrap/resumption, content transfer, device management and stop semantics. Electron owns windows, tray, lifecycle, dialogs, external URL policy, local discovery, process launch/restart, user skills scanning and renderer IPC.

## Development

Requirements: Node.js >=22.12, pnpm, Rust/Cargo, `just`, and sibling repositories `qaqh-sdk` and `qaqh-backend`（打包冻结期使用 `qaqh-backend-lts`：napi 路径依赖与 `just` 的 `QAQH_BACKEND_DIR` 默认值都指向它，临时切回活跃仓用 `QAQH_BACKEND_DIR=../qaqh-backend just ...`）. The renderer lives in this repository under `webui/`. `just` is the only supported packaging entry point; `pnpm` remains the package manager and runs the JavaScript internals.

```bash
just install             # install all three workspaces
just dev                 # Vite renderer + Electron main/preload, live development window
just check               # Electron, renderer and SDK typecheck/tests
```

The renderer is loaded from Vite at `http://127.0.0.1:5173` in development. `app://localhost` serves packaged resources in production. The Electron main process starts/reuses the backend daemon and initializes the SDK client before loading the renderer so IPC routes exist at frontend boot.

### Linux sandbox note

`release/linux-unpacked` is an unpacked development artifact. Its
`chrome-sandbox` is owned by the build user with mode `755`, so Electron refuses
to start with:

```text
FATAL: ... The SUID sandbox helper binary was found, but is not configured correctly.
```

Run the unpacked build with the dev-only flag:

```bash
./release/linux-unpacked/qaqh-electron --no-sandbox
```

Or fix the helper once (then the normal command works):

```bash
sudo chown root:root release/linux-unpacked/chrome-sandbox
sudo chmod 4755 release/linux-unpacked/chrome-sandbox
```

`just dev` passes `--no-sandbox` automatically for the same reason: the npm
Electron binary also ships an unpacked helper. Do not use that flag for a
production installer; install the `.deb`/AppImage and launch through the
desktop entry so the packaged sandbox policy applies. If an older
`/opt/QAQ-Harness` app is running, the single-instance lock makes a second
build exit immediately; quit the old app or use a separate
`--user-data-dir=/tmp/qaqh-electron-test`.

## Canonical build (currently Linux x64)

```bash
just build                # daemon + SDK + renderer + Electron, then AppImage/deb/tar.gz
just dir                  # unpacked app, no installer archive
just appimage             # AppImage only
just deb                  # deb only
just tarball              # tar.gz only
just info                 # print the version/date/commit that will be injected
just check                # Electron/renderer/SDK typecheck and tests
```

`just` resolves the source commit and optional version overrides. Before compilation,
`deb`/`all` reserve a daily `3.0.YYYYMMDD-N` revision in Asia/Shanghai; other targets
use the manifest version. The resolved identity is exported to Node, Cargo and
electron-builder. The actual Debian Version is checked after packaging. CI reserves
globally unique release numbers; local builds keep their own ignored ledger.
See [release versioning and the planned signed APT repository](docs/deb-release-and-apt.md).

For an explicit build override, keep the date consistent with the full version:

```bash
QAQH_BUILD_DATE=20261031 QAQH_BUILD_VERSION=2.1.20261031-1 just build
```

The packaging script rejects unsupported host architectures rather than silently cross-compiling. It validates the packaged ASAR content and daemon resources before replacing `release/`. A successful package check is not a GUI smoke test; start the packaged app on each target distribution before publishing.

Windows x64 NSIS builds run on a native Windows host with PowerShell 7 (`pwsh`; recipes and backticks run under pwsh via `set windows-shell`, no Bash needed), just, Node.js, pnpm and Rust/MSVC installed:

```bash
just nsis
```

## Installation implementation spec

Linux installer/uninstaller/updater fast-release implementation scope and minimal
acceptance checks: [SPEC](docs/spec-install-maintenance-mvp.md). This is a future
implementation specification, not a claim that those maintenance flows exist today.

## Debian packages

`just deb` and `just build deb` use the standard electron-builder layout and write
artifacts to `release/`. dpkg owns the application in `/opt/QAQ-Harness`:
`resources/app.asar` contains main/preload/renderer, and `resources/bin/qaqh-daemon`
is the only bundled executable component. The package entrypoint is
`dist/main/index.cjs`.

Startup does not unpack or load programs from `~/.local/share/QAQ-Harness`.
Old overlays, receipts, and generation pointers are unused. Component hot-update
controls and baseline installation have been removed; install a new system package
to update the application. Same-version rebuilds are checked against packaged file
contents, not a user-directory version cache. After reinstalling, fully exit the
running desktop application and launch it again. On Linux, startup checks the
running daemon's executable inode against the bundled binary; an obsolete idle
daemon is stopped through `stop-if-idle` before the bundled replacement starts.

## Backend v3 data compatibility

The backend v3 daemon uses session SQLite schema 5. It rejects older SQLite
schemas with `SchemaTooOld` and does not import the legacy JSONL session log or
`workspaces.json` data. Electron does not delete or rewrite those files. This
release does not provide an automatic data migration; preserve the existing
files if startup reports a schema error.

## Runtime behavior

- Closing the window hides it to the tray on Linux/Windows; macOS keeps normal application-window behavior. Tray/menu exit opens the renderer's quit-confirmation flow.
- Ordinary shell exit leaves the daemon alive. If the user explicitly asks to stop it, the SDK stop-if-idle operation protects active work; only an explicit force-confirmed choice uses unconditional stop.
- LAN mode restarts the daemon via the Electron host, waits for the new discovery/endpoint, then reconnects and restores the active seed. Pairing tokens are requested and assembled in main; token material is returned only inside the one-time QR payload for the user.
- Native screenshot capture and native window materials are not currently implemented in Electron; the UI hides the screenshot action and falls back to CSS themes. Process-tree memory enumeration is explicitly reported unsupported rather than fabricated.

## User interactions

Ask, tool permission requests and plan reviews share the renderer approval surface but use distinct Ringing commands. The host owns the one-shot challenges, validates decisions and payloads, and explicitly targets the session that issued the challenge. See [interaction semantics and acceptance](docs/interaction-semantics.md) for the decision matrix, trust/autonomous boundaries, recovery policy and remaining GUI checks.

`pnpm test` includes host IPC regressions and real-SDK serialization/SSE tests over an in-memory fetch transport, in addition to packaging guards. These tests do not replace a live-daemon or GUI acceptance run.

## Security notes

The renderer uses context isolation and no Node integration. `app://` responses carry a restrictive CSP; external links are limited to `http(s)` plus the specific macOS screen-recording preference deep link. The preload exposes no raw `ipcRenderer`, arbitrary event channel, or arbitrary invoke API. Main validates the calling frame and service method names.

### 契约同步

协议运行时已由原生绑定（`crates/qaqh-napi-client` → `qaqh-client`）直接编译进
主进程，与打包的 daemon 同源；renderer 消费的 TS 类型来自 backend exporter 的
唯一镜像（`webui/src/api/qaqh`）。打包会从冻结仓 `../qaqh-backend-lts`（由
`just` 导出的 `QAQH_BACKEND_DIR` 决定，默认见 justfile）导出契约并逐
文件校验该镜像，漂移时列出全部差异、不自动修改源码。后端提交或契约变更后：

```bash
just sdk-check  # 独立检查，无需开始打包
just sdk-sync   # 重新导出后端契约并同步 WebUI DTO 镜像
just check      # 含 native 绑定与方法白名单的一致性测试
just deb
```

`just sdk-sync` 只修改 `webui/src/api/qaqh`，请审查该目录 git diff。后端工作区
干净时打包记录当前提交做来源校验；有未提交变更时按 development/dirty 处理。
不要手工编辑生成文件；新增 service 方法或命令变体时，同步维护
`src/main/types.ts` 的 `MAIN_SERVICE_METHODS` 与 `src/main/ipc-handlers.ts` 的
`RINGING_COMMAND_TYPES`（两侧一致性有双向测试守门）。
