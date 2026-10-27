# Electron is the canonical desktop host and desktop build entry point.
default:
    @just --list

# 完整打包：依赖、SDK、daemon、前端、Electron、包内校验；target: all|dir|AppImage|deb|tar.gz。
build target="all" *options:
    node scripts/build-all.mjs '{{target}}' {{options}}

# 兼容隔壁仓的常用命令名。
alias desktop-build := build

# 本地开发（先执行一次 just build dir 准备资源）。
dev:
    pnpm run dev

# 独立质量闸；打包本身只做必要类型检查，不重复跑全量测试。
check:
    pnpm run typecheck
    pnpm test
    pnpm --dir ../qaqh-sdk test
    pnpm --dir ../qaqh-desktop-app typecheck
    pnpm --dir ../qaqh-desktop-app test
