# Electron is the canonical desktop host and the only supported packaging entry point.
# `just` resolves build identity once (local pack date + git commit) and exports it
# to Node, Cargo and electron-builder. Do not add packaging entry points to package.json.
set shell := ["bash", "-euo", "pipefail", "-c"]

build_date := env_var_or_default("QAQH_BUILD_DATE", datetime("%Y%m%d"))
build_version := env_var_or_default("QAQH_BUILD_VERSION", "2.0." + build_date)
build_commit := `git rev-parse HEAD`
build_short := `git rev-parse --short=8 HEAD`
build_dirty := `if [ -n "$(git status --porcelain)" ]; then printf '1'; else printf '0'; fi`

export QAQH_BUILD_DATE := build_date
export QAQH_BUILD_VERSION := build_version
export QAQH_GIT_COMMIT := build_commit
export QAQH_GIT_DIRTY := build_dirty
export QAQH_BUILD_ID := build_commit

default:
    @just --list

# 打印本次构建将注入的版本、日期、提交与脏状态。
info:
    @printf 'version  %s\n' '{{build_version}}'
    @printf 'date     %s\n' '{{build_date}}'
    @printf 'commit   %s\n' '{{build_commit}}'
    @printf 'short    %s\n' '{{build_short}}'
    @printf 'dirty    %s\n' '{{build_dirty}}'

# 完整打包；target: all|dir|AppImage|deb|tar.gz（默认 all）。
build target="all" *options:
    @node scripts/build-all.mjs '{{target}}' {{options}}

# 常用目标的短命令，等价于 just build <target>。
dir *options:
    @just build dir {{options}}

appimage *options:
    @just build AppImage {{options}}

# shell 口径 deb(定稿架构):系统包装运行时 + plain-dir baseline + 双 CLI,
# 维护脚本见 scripts/maint/,产物在 release-shell/。
deb *options:
    @node scripts/build-all.mjs deb --shell {{options}}

# 旧口径全量 deb(asar 单包),shell 口径的对照/退路。
deb-full *options:
    @node scripts/build-all.mjs deb {{options}}

tarball *options:
    @just build tar.gz {{options}}

# 组件热更新包(不产生系统安装包):前端=app 代码,后端=daemon。
# 产物在 .qaqh-bundles/<releaseId>/bundles/,由 updater/qaqh-maint 应用到
# ~/.local/share/QAQ-Harness/{app,backend}(见 scripts/make-bundles.mjs)。
bundle-frontend *options:
    @node scripts/make-bundles.mjs --skip-backend {{options}}

bundle-backend *options:
    @node scripts/make-bundles.mjs --skip-frontend {{options}}

bundle-components *options:
    @node scripts/make-bundles.mjs {{options}}

# 只从既有 bundle 产物重组 update-source(bundles/ + catalog.json),不重新构建。
# 产物即 qaqh-update stage 的输入端(--release/--out 可透传)。
update-source *options:
    @node scripts/make-update-source.mjs {{options}}

# 兼容隔壁仓的常用命令名。
alias desktop-build := build

# 安装三处依赖；build 默认也会按需安装。
install:
    pnpm install --frozen-lockfile
    pnpm --dir webui install --frozen-lockfile
    pnpm --dir ../qaqh-sdk install --frozen-lockfile

# 本地开发（先执行一次 just build dir 准备 daemon/renderer 资源）。
dev:
    @node scripts/dev.mjs

# 独立质量闸；打包本身只做必要类型检查，不重复跑全量测试。
check:
    pnpm run typecheck
    pnpm test
    pnpm --dir ../qaqh-sdk test
    pnpm --dir webui run typecheck
    pnpm --dir webui run test
