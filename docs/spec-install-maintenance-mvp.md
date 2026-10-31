# SPEC：Linux 安装 / 卸载 / 更新快速上线

状态：可执行实施规格，尚未实现。优先级：P0。目标平台：Linux x64 deb。

本文件是本轮实施的唯一入口；取代 `install-maintenance-architecture.md` 的首版范围与实施顺序。`local-package-registration.md` 仅保留为后续登记包设计参考。不要求先完成长期架构再发布。

## 1. 发布目标与裁剪

一次交付实现：deb 安装系统底座 → 用户首次打开安装向导确认协议 → 用户域部署 → 后续本地组件更新 → 用户卸载；deb 升级不再被 local 旧代码遮蔽。

### 必做

- 保留包名 `qaqh-electron`、现有 Electron runtime、desktop、图标和许可证元数据，由 dpkg 管理。
- 共用 Rust 维护引擎；同一 Electron 维护窗口提供安装 / 修复 / 卸载模式，不新增 egui/GTK 技术栈，不移植 Windows 注册表或进程实现。
- 在系统 bootstrap 加载业务 main 之前检查安装登记、协议与版本，维护窗口不依赖 daemon、SDK 或用户 app。
- 用户组件使用完整快照目录 + 一个活动指针；安装、更新、回滚、卸载共用锁和文件安全规则。
- 接入现有本地目录更新源；预留 tools/bin 路径，支持随组件携带工具，不要求首版实际打包 rg。

### 本版不做

- 独立 Linux SFX 可执行文件、EXE 尾部 ZIP 格式移植：首版 installer 与独立 ZIP 放在 deb 中，共用同一引擎；这叫离线安装，不宣称已经支持单文件自解压发布。
- pkexec、metadata deb、拆包、自动维护 apt 仓库、runtime 自更新。
- 在线更新服务、二进制 delta、纯 renderer 无重启热替换、后台自动升级。
- 任意安装位置选择、管理员代用户确认、删除用户数据、自动 GC、自动杀 daemon、复杂兼容性求解。
- 多发行版矩阵、全量端到端框架、新测试基础设施、旧 WinUI 安装器构建。

首版默认用户路径固定；可继续提供开发用 `QAQH_COMPONENT_ROOT`。这些裁剪不得留下暗中启用的半成品入口。

## 2. 各组件职责（不得交叉实现）

| 组件 | 职责 |
| --- | --- |
| deb / postinst / postrm | 系统底座、依赖与沙箱权限；不弹 GUI，不写个人 HOME，不替用户接受协议 |
| 系统 bootstrap | 单实例、登记/恢复/协议门禁、版本决策、维护窗口或业务入口选择、注入本次启动路径 |
| 维护 GUI | 展示协议、确认安装/修复/卸载、进度和结果；只调用固定受校验命令 |
| `qaqh-maint` | 安装/修复/卸载、安装根安全、快照与指针事务；不做网络、不控制 apt |
| `qaqh-update` | plan/stage、导入本地更新、等待进程退出/重启；激活和回滚调用共用引擎 |
| 业务 main | 加载明确选中的 app，连接 daemon；不再决定首次释放或自行改安装根 |

UI 的“已提交后台 worker”不等于完成。CLI 同步命令返回真实结果，异步更新返回 operationId，重启后由 bootstrap 完成恢复/验证。

## 3. 安装布局与唯一事实源

系统包继续使用 `/opt/QAQ-Harness`（沿用 builder 实际路径），包括 runtime、系统 bootstrap、维护 UI/preload、双 CLI、baseline ZIP 与清单、协议正文。保留包内 app 作为修复来源；它不得绕过协议直接启动业务。

用户布局：

```text
${QAQH_COMPONENT_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/QAQ-Harness}/
  .deepx-install-root.json     # 引擎校验的安装根 marker
  installation.json           # installationId、uid、schemaVersion
  active.json                 # 当前与上个已确认快照、pending 验证状态
  legal-consent.json          # 当前用户明确确认的版本/摘要
  maintenance.lock            # 独立于待删目录；所有写入者同一 OS 文件锁
  generations/<operationId>/
    app/                      # package.json + dist + renderer
    backend/qaqh-daemon
    tools/bin/                # 可为空
    install-state.json        # 沿用 Rust v2 组件状态，属于本快照
  staging/                    # 当前既有更新暂存可迁入这里
  legacy/                     # 可选迁移备份，首版不自动删除
```

- 快照 ID 由引擎生成；目录 segment 仅允许 `[A-Za-z0-9_-]+`，不得接受 catalog 提供的任意绝对目标。
- active.json 只引用快照 ID，不接受任意 app 路径。每个快照都自包含，不用硬链接到旧快照，否则写新版本可能破坏旧版本。
- 原子 JSON 写入：同目录临时文件 → flush → rename；激活只替换 active.json。失败时保留旧指针，不先删除旧文件。
- `active.json` 最小字段：`schemaVersion=1`、`current`、`previous`（可空）、`pendingOperation`（可空）、`blockedBaseline`（可空）。pendingOperation 记录 old/new/phase 和触发源身份；失败 baseline 记录为 blockedBaseline，避免每次启动反复安装崩溃版本。用户点击重试/修复才解除。
- `installation.json` 和同意记录不放进快照，不因组件升级丢失。配置、会话、凭据仍留在原业务数据目录，本版不搬、不删。同意记录匹配的是待启动版本要求的协议摘要，不是无条件匹配最新系统文档；新协议被拒绝时可退出或继续已有且条款仍有效的旧版，不激活新版本。
- `component-paths.ts` 是 Node 路径唯一入口；Rust 接收显式 root，内部验证身份和所有者。禁止另写固定 HOME 拼接。
- updater 的 `--install-root` 由用户注册根转换为选中的快照根；不得继续往旧 `<root>/app` 写。UI 读取的 install-state 同样来自 current 快照。

## 4. 安装根与写入纪律

先做这些再接 UI：

1. 用户安装/更新/清理拒绝 euid=0；系统维护子命令不接收用户 root，不复用 cleanup 接口。
2. 验证目标不是 `/`、HOME、XDG 数据父目录或其危险祖先；不跟随安装根/受管理路径中的符号链接。已有非空未知目录且无有效 marker 时拒绝采用或删除。
3. 验证目录属于当前 uid；marker 与规范路径绑定。marker 只是防误操作，不充当签名。
4. 全部写入命令持有同一个 OS advisory 文件锁，进程退出自动释放；锁忙返回 busy，不删除锁文件“解锁”。Electron 单实例锁不能代替它。
5. 仅写管理的目录；ZIP 目标继续使用现有 safe_join 校验，拒绝绝对路径、`..`、链接与特殊文件；现有大小/摘要/执行位校验不得裁掉。
6. cleanup 先验证，再仅清 generations/staging/已识别 legacy 与安装登记；保留根目录及锁文件。协议同意记录随用户安装登记清理，业务数据不动。

## 5. CLI 契约（本 spec 要实现，不是现有命令声明）

延用 `qaqh-maint` / `qaqh-update`，不另造三套二进制：

```text
qaqh-maint inspect --root <root> --json
qaqh-maint install --root <root> --baseline <dir> --accept-legal <exact-version> --json
qaqh-maint repair --root <root> --baseline <dir> --json
qaqh-maint confirm --root <root> --operation <id> --json
qaqh-maint rollback --root <root> --json
qaqh-maint uninstall --root <root> --json
qaqh-maint system-check --resources <system-resources>
```

- `inspect` 只读，返回 installed/consentRequired/current/previous/pending/actual component builds；不能靠目录存在返回 installed。
- install 校验 `--accept-legal` 等于随包 legal 清单版本，记录当前 uid、installationId、两份文档 sha256、确认时间与来源。GUI 只有明确点击同意才能传此参数。repair 不接受新条款，缺有效同意返回 consent_required。
- `system-check` 只检查调用的 root-owned 系统底座/CLI/离线载荷/权限；不接受个人安装根，不写同意。
- 既有低层 unpack 保留作引擎内部/开发入口，生产 UI 和 bootstrap 不直接调它；旧 cleanup 收敛到安全 uninstall，未知根必须拒绝。
- 状态码固定：0 完成；2 参数错误；3 busy；4 consent_required；5 invalid_root；6 invalid_payload/不兼容；1 其他失败。JSON 统一 `{ok, operationId?, code?, message?, state?}`，不要输出敏感环境。
- 既有 updater plan/stage/apply-staged 的外部接口尽量保留，内部改为快照事务。已存在的旧 staged-operation 先识别为 legacy 并要求重新 stage，不错误套用新路径。

## 6. 首次启动 / 老用户迁移 / deb 升级

### 首次启动

bootstrap 在协议注册等 Electron 必须的早期初始化之后、业务 main 之前完成分流；不得因等待 app.ready 而错过特权协议注册时机。维护窗口使用独立固定 preload + 最小 IPC 白名单、contextIsolation，禁用 NodeIntegration；不沿用业务通用 invoke 接口。

1. 取得单实例锁，inspect 用户安装；未安装/协议无效则只打开维护窗口，不启动 daemon 或业务 renderer。
2. 用户同意 → maint install 从系统离线 baseline 部署新快照 → 原子提交 pending 指针 → 正常重启进入选定 app。
3. 用户拒绝/关闭：退出，不创建 accepted=true，不启动业务。已解压的未激活暂存可下次重用。
4. 初版界面只做“协议 / 安装或修复 / 完成”和“卸载确认”几屏；不复制 WinUI 原视觉，不新增动画。

### 老布局迁移

遇到旧 `<root>/app`、`backend`、`install-state.json`：只在验证原 marker 和当前 uid 后读取；未验证旧目录不自动删除。先显示新的协议确认，之后从新 baseline 安装或导入有效旧组件。

旧用户组件版本高于 baseline 时，保留其内容并复制进新快照，缺失组件由 baseline 补齐；相同版本按已有 baseline receipt 规则决定一次性提升。迁移成功才提交新 active；旧目录原地保留但不再作为启动候选。未知/损坏旧安装显示修复，不静默加载旧 main。

### deb 升级与普通启动

- 已激活用户每次启动都对照 baseline；更旧组件升级、更高版本用户组件保留；同版本重构建沿用内容身份 + baseline receipt 规则。
- 自定义高版本若与 runtime/controlProtocol 不符，停止激活并提示升级底座，不盲目加载；首版仅做明确的 runtimeMajor 与 controlProtocol 相等检查，不建求解器。新 bundle/baseline 必须携带此信息，旧热更新包缺信息时拒绝新激活并提示重新打包。
- baseline 引入新协议文档时先进入维护窗口确认；后台只能暂存。
- 协调失败时只运行 last-known-good；没有有效旧版本则显示维护错误。包内 fallback 不得绕过协议门禁。
- legacy 顶层目录、继承的 QAQH_APP_DIR 均不能压过当前 active；显式开发 override 仅开发模式允许。

## 7. 快照激活、恢复与更新

共用事务只实现一种：

1. 持锁读取 current，创建新 generation；部分组件更新时先普通复制旧快照，再应用 bundle 到新目录，完整组件包先移除新快照中该组件旧树以免残留旧 hash 文件。
2. 现有引擎校验全部文件和必需入口，生成新快照 install-state；不修改 current 的字节。
3. 用户明确选择“应用并重启”后暂停新任务；daemon 安全停止返回 busy 时保留 staged，提示结束任务后重试，绝不强杀。
4. app 变更等 Electron 退出后，由系统 CLI 持锁重检活动版本未变化，再写 active pending 指向新快照。后台 worker 的 exec 环境移除旧已解析 app 路径。
5. 激活时 pending.phase=`prepared`。bootstrap 首次读到 prepared，持锁改为 `booting` 后才加载新 main；业务 renderer 成功加载、daemon 建连成功后调用 confirm 清除 pending。此次进程内 30 秒未就绪则回滚并正常退出/重启，尝试一次即可。后续启动仍读到 booting 才表示上次未提交并回滚；prepared 不得被误判为失败。confirm 后的普通运行崩溃不自动回滚。
6. 回滚只恢复指针，保留失败快照和可见错误；因 baseline 自动提升失败时记录 blockedBaseline。不上自动重试死循环，不引入 GC。

原 backend-only 更新也走这条一致链路，首版允许统一重启 Electron以减少分支；不承诺 UI 无感热更新。工具路径由所选 generation 派生，内部调用绝对路径；子进程 PATH 前置 tools/bin，只改本应用环境，不放开凭据白名单。复用 daemon 前核对实际构建/环境代际，不一致须走安全停止；活跃任务阻止切换。

## 8. 系统安装与卸载

- `postinst` 仅在 configure 运行 system-check 和必要沙箱权限设置；必要检查失败非零，不把失败吞成成功。移除无消费者的 `/var/lib/qaqh-harness` seed 生成。
- `postrm` 按 remove/purge/upgrade/其他恢复动作显式分支；移除全局 pkill 和不加验证的 rm -rf，不执行用户引擎，不扫 HOME。删除系统文件由 dpkg 负责。
- 清理旧系统 seed 仅允许固定 `/var/lib/qaqh-harness`：检查不是链接、root 所有、有效 marker 且没有未知条目后删除；不满足只警告保留。purge 后也不依赖已删除的包内 CLI。
- 用户卸载由系统维护 GUI/CLI 在当前用户权限下执行；必须已停止本实例和 daemon，busy 时退出。只清用户组件，明确告知“系统底座仍由 apt 管理，用户数据已保留”；本版不提供“删全部数据”或自动 apt purge 按钮。
- apt remove/purge 不声称卸载所有用户组件；再次安装仍须正常版本/协议协调。

## 9. 实施顺序与落点

按顺序执行，不等待全量重构：

1. **Rust 引擎**：`crates/qaqh-update/` 新增维护/快照模块；加根安全、OS 锁、inspect/事务/回滚/uninstall；底层 apply 复用；变更 maint/update CLI。
2. **打包元数据**：`scripts/make-baseline.mjs`、`make-bundles.mjs` 统一生成兼容约束与 legal 清单；`verify-package.cjs` 校验随包文件；不为 SFX 增加第二条流水线。
3. **系统维护窗口**：新增 `src/maintenance/`（独立主进程控制、preload、简单本地 HTML/CSS/JS）；`scripts/bundle.mjs` 和 shell yml 收录，完全独立于用户业务 app。
4. **入口接线**：`bootstrap.ts` 用 inspect/协议/active 决策替代自动 unpack；`component-paths.ts` 增加 resolved generation；`daemon.ts`、`updater.ts`、`ipc-handlers.ts`、业务加载路径一致改为新根；接 ready/confirm 与错误恢复。
5. **deb 收尾**：收敛 postinst/postrm、移除系统 seed；保留现有包名和 runtime 布局。设置页增加“维护 / 用户卸载”入口，实际打开系统维护窗口。
6. **构建发布**：`just deb` 唯一首版验收入口；bundle 命令沿用。旧 full/AppImage/tar 暂不改架构，明确不作为本次协议/安装能力发布目标。

不要删现有已通过的回归测试，也不必为上述每个函数补单测。协议正文由用户/产品提供，禁止模型生成条款冒充正式文件：开发构建可带醒目标记 draft；production 构建发现缺文档/占位稿必须失败。这是唯一外部发布阻塞项，不阻塞其余实现。

## 10. 最小验收（只做这些，不扩张测试）

### 自动检查：一次运行

- `pnpm run typecheck`。
- 一份聚焦维护测试：5 个场景足够，使用临时目录和真实引擎：首次安装、旧版本提升/新版本保留、激活未确认回滚、未知根/符号链接拒绝、双写入者 busy。可复用原 baseline 测试，无需造大型夹具。
- `just deb --skip-install` 构建一次；只有明确知道后端未改时允许附加 `--skip-backend`，报告中注明复用。

### 人工冒烟：一个隔离 Linux 环境，串行一轮

1. 安装 deb → 关闭/拒绝协议不启动业务 → 同意后能正常进入 UI；断网仍可安装。
2. 用第二个发布身份验证 baseline 提升或本地 bundle 更新，重启后实际 app/backend 身份正确；已确认版本不被旧包覆盖。至少一次人为中断 pending 后启动能回旧版。
3. GUI 用户卸载 → 业务数据保留、未知文件未删；apt remove 后再单独 purge，无已丢失 CLI 依赖、不删个人目录。

发布闸：上述通过 + 正式协议就位。无须跑 webui/SDK/后端全量测试、性能测试或跨发行版矩阵；若改动越过安装边界再补对应局部检查。减少覆盖范围，不取消路径验证、协议门禁、失败回滚或真实包生命周期冒烟。完成报告只写执行结果与未验证项，不把未实现功能列为已上线。
