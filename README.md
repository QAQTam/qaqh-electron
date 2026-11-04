# QAQ-Harness Electron (canonical desktop host)

`qaqh-electron` is the first-class and only supported desktop shell. It hosts the SolidJS renderer in `webui/`, owns all OS privileges, daemon discovery credentials and lifecycle, and uses `@qaqh/sdk` for Ringing v2 communication. The renderer receives a narrow `window.qaqhHost` API; Node, Electron primitives, daemon bearer tokens, and unrestricted IPC are not exposed to it.

## Architecture

```text
webui renderer (Chromium)
  → contextBridge window.qaqhHost (fixed command + event contract)
  → Electron main process (runtime sender checks, service allowlist, native OS work)
  → @qaqh/sdk (Ringing v2, leases, commands, streams, pairing, graceful stop)
  → qaqh-daemon
```

There is no Tauri compatibility runtime. Main IPC is sender-validated and accepts an enumerated set of host commands; the service RPC bridge has a runtime allowlist and active-session scoping. Model-picker IPC is separately restricted to its native picker window. Electron keeps the daemon client and credentials in main.

The SDK owns protocol work: Ringing handshake/lease renewal, service methods, command idempotency, SSE bootstrap/resumption, content transfer, device management and stop semantics. Electron owns windows, tray, lifecycle, dialogs, external URL policy, local discovery, process launch/restart, user skills scanning and renderer IPC.

## Development

Requirements: Node.js >=22.12, pnpm, Rust/Cargo, `just`, and sibling repositories `qaqh-sdk` and `qaqh-backend`. The renderer lives in this repository under `webui/`. `just` is the only supported packaging entry point; `pnpm` remains the package manager and runs the JavaScript internals.

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

`just` reads the release version and its date from `package.json`, resolves the git commit once, then exports `QAQH_BUILD_DATE`, `QAQH_BUILD_VERSION`, `QAQH_GIT_COMMIT`, `QAQH_GIT_DIRTY` and `QAQH_BUILD_ID` to every stage. The Node bundles embed that identity, Cargo injects it into the daemon, and electron-builder writes it into the packaged `package.json` via `extraMetadata.version`. There are intentionally no packaging scripts in `package.json`; invoking the pipeline around `just` would bypass this identity injection.

For an explicit build override, keep the date consistent with the full version:

```bash
QAQH_BUILD_DATE=20261031 QAQH_BUILD_VERSION=2.1.20261031-1 just build
```

The packaging script rejects unsupported host architectures rather than silently cross-compiling. It validates the packaged ASAR content and daemon resources before replacing `release/`. A successful package check is not a GUI smoke test; start the packaged app on each target distribution before publishing.

Windows x64 NSIS builds run on a native Windows host with Bash, just, Node.js, pnpm and Rust/MSVC installed:

```bash
just nsis
```

## Installation implementation spec

Linux installer/uninstaller/updater fast-release implementation scope and minimal
acceptance checks: [SPEC](docs/spec-install-maintenance-mvp.md). This is a future
implementation specification, not a claim that those maintenance flows exist today.

## Writable components and deb upgrades

`just deb` builds the shell package (`release-shell/`); `just build deb` and
`just deb-full` build the full package. The shell's system-owned bootstrap acquires
the single-instance lock and reconciles `resources/baseline/baseline.json` **before**
loading user application code. Existing `install-state.json` is not a permanent
skip flag: older components are upgraded, missing entry files are repaired, and
higher numeric component versions are retained. On reconciliation failure this
launch uses the packaged app/backend and retries next launch.

For equal versions, a changed content-addressed system baseline wins once. A
`baseline-receipt.json` records that baseline so subsequent same-version hot
updates survive unchanged-package launches. Without a publication sequence there
is no chronological ordering between two different same-version builds; use a
higher `QAQH_BUILD_VERSION` for unambiguous newer hot releases. This is not a
runtime/protocol compatibility solver or a directory-level atomic update system.

Bootstrap, daemon and updater share `QAQH_COMPONENT_ROOT`, defaulting to
`${XDG_DATA_HOME:-~/.local/share}/QAQ-Harness`. `QAQH_APP_DIR` is an explicit
non-managed development override; bootstrap-generated values inherited across
relaunches do not bypass reconciliation. `QAQH_BASELINE_SEED=0` disables baseline
writes, not stale-overlay detection. A second instance does not rewrite running
application files. Existing detached daemons are not forcibly terminated by this
migration; use the application's controlled daemon restart when needed.

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
