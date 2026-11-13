# Electron is the canonical desktop host and the only supported packaging entry point.
# `just` exports source identity and optional explicit version overrides.
# build-all reserves a daily deb revision before exporting it to every build stage.
# Do not add packaging entry points to package.json.
set shell := ["bash", "-euo", "pipefail", "-c"]
# Windows 上由 pwsh 7 执行 recipe 与 backtick，无需 Git Bash。
# 注意：just 会把每行 recipe 行单独交给 pwsh（-Command），行尾裸 `&&` 是 pwsh 解析错误
# 且吞掉全部输出（just 1.59 实测，exit 1 零输出）。多步 recipe 必须用行尾 `\` 把多行
# 拼成一条命令，再以 `&&` 串联实现首败即停（bash 侧同样成立）。
set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

release_version := `node -p "require('./package.json').version"`
release_date := `node -p "require('./package.json').version.split('.')[2].split('-')[0]"`
build_date := env_var_or_default("QAQH_BUILD_DATE", "")
build_version := env_var_or_default("QAQH_BUILD_VERSION", "")
# 后端主仓（main）：打包/契约导出/check 一律走 ../qaqh-backend；
# 改验证另一份后端时用 QAQH_BACKEND_DIR 覆盖（相对仓根或绝对路径）。
backend_dir := env_var_or_default("QAQH_BACKEND_DIR", "../qaqh-backend")
build_commit := `git rev-parse HEAD`
build_short := `git rev-parse --short=8 HEAD`
# 跨 shell 写法：pwsh/bash 下等价，避免依赖 bash 的 if/printf。
build_dirty := `node -p "require('child_process').execSync('git status --porcelain').length ? 1 : 0"`

export QAQH_BUILD_DATE := build_date
export QAQH_BUILD_VERSION := build_version
export QAQH_GIT_COMMIT := build_commit
export QAQH_GIT_DIRTY := build_dirty
export QAQH_BUILD_ID := build_commit
export QAQH_BACKEND_DIR := backend_dir

default:
    @just --list

# 打印本次构建将注入的版本、日期、提交与脏状态。
info:
    @echo 'version  {{if build_version == "" { "automatic for deb/all; " + release_version + " otherwise" } else { build_version }}}'
    @echo 'date     {{if build_date == "" { "derived from build version" } else { build_date }}}'
    @echo 'commit   {{build_commit}}'
    @echo 'short    {{build_short}}'
    @echo 'dirty    {{build_dirty}}'

# 完整打包；Linux: all|dir|AppImage|deb|tar.gz，Windows: nsis。
build target="all" *options:
    @node scripts/build-all.mjs '{{target}}' {{options}}

# Windows x64 NSIS 安装包；需在 Windows x64 + pwsh 7 环境运行。
nsis *options:
    @node scripts/build-all.mjs nsis {{options}}

# 前端-only 滚动打包：版本号由 .tmp/deb-version.json 账本自动分配（北京日期+当天修订），
# 不重编后端、不走 sdk-check；--wizard 出带安装目录选择的安装包。
# 打包前自动强制重建 main bundle + renderer（新鲜度守卫，不会打旧 dist）。
frontend-rolling *options:
    @node scripts/package-frontend.mjs {{options}}

# 本地前端热更新闭环：构建 renderer/shell → 单文件 app.asar bundle → 发布到本地
# update-source（默认 %LOCALAPPDATA%\QAQ-Harness\update-source，可用 QAQH_UPDATE_SOURCE
# 覆盖）。壳启动/设置页「检查更新」扫到后即可暂存并重启应用。
frontend-update *options:
    node scripts/make-bundles.mjs --skip-backend {{options}} && \
    node scripts/make-update-source.mjs --publish

# 宣传片渲染管线：虚拟时间逐帧出 PNG（playwright-core+无头Edge）→ 代码合成音效 → ffmpeg 合成。
# 时间轴唯一事实源 webui/src/promo/scenes.json；成片 .tmp/promo/promo.mp4。
promo:
    node scripts\promo\render.mjs && \
    node scripts\promo\sfx.mjs && \
    node scripts\promo\encode.mjs

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

# 安装依赖；build 默认也会按需安装。
install:
    pnpm install --frozen-lockfile && \
    pnpm --dir webui install --frozen-lockfile

# 本地开发（先执行一次 just build dir 准备 daemon/renderer/native 资源）。
dev:
    @node scripts/dev.mjs

# 宣传片录屏：真壳（Electron）直连 mock 舞台，加载 live promo.html（自动播放+循环）。
# 纯浏览器路线无需本条：起 vite 后开 http://127.0.0.1:5173/promo.html 即可。
dev-promo:
    @node scripts/dev.mjs --promo

# 独立质量闸；打包本身只做必要类型检查，不重复跑全量测试。
check:
    pnpm run typecheck && \
    pnpm test && \
    pnpm --dir webui run typecheck && \
    pnpm --dir webui run test && \
    cargo test -p qaqh-client --lib --manifest-path {{backend_dir}}/Cargo.toml && \
    cargo check --manifest-path crates/qaqh-napi-client/Cargo.toml

# 显式重新生成 SDK 契约并同步 WebUI DTO；打包只检查，不修改源码。
sdk-sync:
    @node scripts/sdk-contract.mjs sync

# 单独运行打包前的 SDK 契约校验。
sdk-check:
    @node scripts/sdk-contract.mjs check
