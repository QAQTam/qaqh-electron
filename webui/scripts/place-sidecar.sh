#!/bin/sh
# 把 daemon 构建产物放置为 Tauri sidecar（与 place-sidecar.ps1 同语义的 POSIX 版）。
#
# 为什么要有它：macOS/Linux 不自带 pwsh，而 Tauri 只认 `binaries/qaqh-daemon-<TARGET_TRIPLE>`
# 这一个文件名。放置步骤挂了，`just check-shell` 与 `tauri build` 会一起卡在 build.rs
# 的 sidecar 断言上，报的还不是真因。
#
# 用法: sh scripts/place-sidecar.sh [debug|release] [target-triple]
# 前置: 在后端仓跑过
#   cargo build -p qaqh-daemon [--release] [--target <triple>]
# 后端仓位置：$QAQH_BACKEND_ROOT，缺省 = 本仓同级目录 ../qaqh-backend
set -e

mode=${1:-debug}
target=${2:-}

repo_root=$(cd "$(dirname "$0")/.." && pwd)
backend_root=${QAQH_BACKEND_ROOT:-$(cd "$repo_root/.." && pwd)/qaqh-backend}
if [ ! -d "$backend_root" ]; then
    echo "backend repo not found: $backend_root (设 QAQH_BACKEND_ROOT 指向 qaqh-backend)" >&2
    exit 1
fi

# 带 --target 编译时产物落在 target/<triple>/<mode>/,否则 target/<mode>/。
if [ -n "$target" ]; then
    triple=$target
    src="$backend_root/target/$target/$mode/qaqh-daemon"
else
    triple=$(rustc --print host-tuple)
    src="$backend_root/target/$mode/qaqh-daemon"
fi

if [ ! -f "$src" ]; then
    echo "daemon binary not found: $src (先在 $backend_root 跑 cargo build -p qaqh-daemon,三元组 $triple)" >&2
    exit 1
fi

dest_dir=$repo_root/src-tauri/binaries
mkdir -p "$dest_dir"
# sidecar 必须是可执行位齐备的裸二进制：binaries/ 已在 .gitignore 里,不会误入库。
cp "$src" "$dest_dir/qaqh-daemon-$triple"
chmod 755 "$dest_dir/qaqh-daemon-$triple"
echo "sidecar: $src -> src-tauri/binaries/qaqh-daemon-$triple"
