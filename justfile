# Electron is the canonical desktop host and the only supported packaging entry point.
# `just` exports source identity and optional explicit version overrides.
# build-all reserves a daily deb revision before exporting it to every build stage.
# Do not add packaging entry points to package.json.
set shell := ["bash", "-euo", "pipefail", "-c"]

release_version := `node -p "require('./package.json').version"`
release_date := `node -p "require('./package.json').version.split('.')[2].split('-')[0]"`
build_date := env_var_or_default("QAQH_BUILD_DATE", "")
build_version := env_var_or_default("QAQH_BUILD_VERSION", "")
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
    @printf 'version  %s\n' '{{if build_version == "" { "automatic for deb/all; " + release_version + " otherwise" } else { build_version }}}'
    @printf 'date     %s\n' '{{if build_date == "" { "derived from build version" } else { build_date }}}'
    @printf 'commit   %s\n' '{{build_commit}}'
    @printf 'short    %s\n' '{{build_short}}'
    @printf 'dirty    %s\n' '{{build_dirty}}'

# 完整打包；Linux: all|dir|AppImage|deb|tar.gz，Windows: nsis。
build target="all" *options:
    @node scripts/build-all.mjs '{{target}}' {{options}}

# Windows x64 NSIS 安装包；需在 Windows x64 + Bash 环境运行。
nsis *options:
    @node scripts/build-all.mjs nsis {{options}}

# 常用目标的短命令，等价于 just build <target>。
dir *options:
    @just build dir {{options}}

appimage *options:
    @just build AppImage {{options}}

# 标准 deb:安装目录中的 app.asar + resources/bin/qaqh-daemon,产物在 release/。
deb *options:
    @node scripts/build-all.mjs deb {{options}}

tarball *options:
    @just build tar.gz {{options}}

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

# 显式重新生成 SDK 契约并同步 WebUI DTO；打包只检查，不修改源码。
sdk-sync:
    @node scripts/sdk-contract.mjs sync

# 单独运行打包前的 SDK 契约校验。
sdk-check:
    @node scripts/sdk-contract.mjs check
