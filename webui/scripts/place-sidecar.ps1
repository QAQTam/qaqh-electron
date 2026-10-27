# 把 daemon 构建产物放置为 Tauri sidecar（目标三元组命名，带存在性断言）。
#
# 本仓**不构建** daemon：daemon 的权威构建在后端仓。脚本从后端仓的 target 目录
# 搬运产物，落到 `src-tauri/binaries/<name>-<triple>[.exe]`（Tauri `externalBin`）。
#
# 后端仓位置：`$env:QAQH_BACKEND_ROOT`，缺省 = 本仓的同级目录 `../qaqh-backend`。
#
# 用法:
#   pwsh -File scripts/place-sidecar.ps1 [debug|release] [target-triple]
# 三元组留空 = `rustc --print host-tuple`（不带 --target 的原生构建）；显式传时
# 产物按 `target/<triple>/<mode>/` 取，sidecar 后缀也用同一个三元组。
# 前置:
#   在后端仓跑 `cargo build [-p qaqh-daemon --release] [--target <triple>]`（见本仓
#   justfile 的 `desktop-dev` / `desktop-build`，它们会代为执行）。
# POSIX 平台用 scripts/place-sidecar.sh（macOS/Linux 不自带 pwsh），两者语义必须一致。
param(
    [Parameter(Mandatory = $false)][ValidateSet('debug', 'release')][string]$Mode = 'debug',
    [Parameter(Mandatory = $false)][string]$Target = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = if ($env:QAQH_BACKEND_ROOT) {
    $env:QAQH_BACKEND_ROOT
} else {
    Join-Path (Split-Path -Parent $repoRoot) 'qaqh-backend'
}
if (-not (Test-Path $backendRoot)) {
    throw "backend repo not found: $backendRoot (设 QAQH_BACKEND_ROOT 指向 qaqh-backend)"
}

$triple = if ($Target) { $Target } else { (rustc --print host-tuple).Trim() }
$daemonName = if ($IsWindows) { 'qaqh-daemon.exe' } else { 'qaqh-daemon' }
$sidecarName = if ($IsWindows) { "qaqh-daemon-$triple.exe" } else { "qaqh-daemon-$triple" }
# 带 --target 编译时产物落在 target/<triple>/<mode>/,sidecar 后缀必须与之一致。
$srcDir = if ($Target) { "target/$Target/$Mode" } else { "target/$Mode" }
$src = Join-Path (Join-Path $backendRoot $srcDir) $daemonName

if (-not (Test-Path $src)) {
    $hint = if ($Target) { " --target $Target" } else { '' }
    throw "daemon binary not found: $src (先在 $backendRoot 跑 cargo build -p qaqh-daemon$hint)"
}

$destDir = Join-Path $repoRoot 'src-tauri/binaries'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item $src (Join-Path $destDir $sidecarName) -Force
Write-Output "sidecar: $src -> src-tauri/binaries/$sidecarName"
