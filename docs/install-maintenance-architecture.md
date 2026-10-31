# Linux 安装、卸载与更新职责定稿

状态：长期架构参考，待实现；不是当前功能说明。**快速上线的唯一执行入口为 [spec-install-maintenance-mvp.md](spec-install-maintenance-mvp.md)，范围、接口及验收以该 spec 为准。** 当前 bootstrap 修复是过渡方案。

## 1. 原 WinUI 实现调研结论

原仓库 `../qaqh-winui-app` 的 installer 是 Rust egui/eframe 程序，不是用 WinUI 写的安装器 UI。`apps/installer/scripts/finalize.ps1:43` 将安装器 EXE 与 ZIP 直接拼接；`apps/installer/src/install.rs:376` 扫描自身 EOCD 定位 ZIP，`:425` 按 bundle.json 校验并释放；无内嵌包时回退到相邻 payload/ 目录（`:253`）。

`apps/installer/src/main.rs:99` 的 `--apply-self <target>` 为无界面部署入口，但没有经过 GUI full 安装后处理 `:1243`：协议同意记录、安装根 marker、快捷方式和卸载注册不能据此视为已完成。GUI 的协议勾选在 `:715`，同意记录在 `apps/installer/src/install.rs:16`，包含文档版本、两份文档摘要和时间。现有正文 `docs/nextdev/legal/USER_AGREEMENT.zh-CN.md` 和 `PRIVACY_POLICY.zh-CN.md` 都是 `0.0.0-draft` 占位稿，不应作为正式发布条款直接复制。

卸载不是 SFX 的反向动作：原项目由已安装的 updater 承载 `maintain/uninstall` UI，复制自身到临时目录后交接 worker，校验安装根、停止关联进程、删除程序，用户数据需显式选择。见 `apps/updater/src/main.rs:39`、`maintenance.rs:24`、`:100`、`:212`。MSIX external-location 注册是单独的脚本能力，不等同于 installer 自动完成，见 `apps/installer/scripts/build-msix-shell.ps1:92`。

上述均为源码核查；本轮没有在 Linux 上声称运行了 Windows 安装器。

## 2. 核心决策

采用「系统注册底座 + 用户域真实安装 + 共用维护引擎」。

- deb 可以主要封装自解压 installer，维护脚本可以调用其无界面系统部署子命令。
- SFX 只是运输容器，不是权限、安装完成、协议同意或升级事务本身。
- apt 安装与每个用户的应用激活分离；postinst 不弹 GUI，不猜调用用户，不向 root 的 HOME 安装应用，不遍历 /home。
- 用户域 app/backend/tools 无需 root 更新。系统 runtime、安全沙箱、root helper 和全机 desktop 注册由系统包拥有。
- 系统底座与用户组件分别显示版本；版本协调不能退化为「用户目录存在就优先」。

## 3. 产物与文件所有权

### 3.1 系统 deb

系统包保留足够的声明式文件，不是字面上只有一个可执行文件：

- 固定 launcher、desktop、图标、DEP-5/第三方许可与其他必要元数据；
- 可同时提供 GUI/CLI 模式的 installer/maintenance 引擎；
- 离线 payload，可采用同一 installer 的 SFX 内嵌 ZIP；
- Electron runtime 与需要系统安全权限的文件；
- 必要时的固定 root-owned package helper 与 polkit 策略。

对 runtime 等稳定系统文件，优先直接列入 deb 文件清单，由 dpkg 解包、校验与移除。若选择「deb 仅带 SFX，由 postinst 展开系统 runtime」，则须将其视为明确的第二种系统部署实现：只允许展开到专属 root-owned 目录，安装登记、完整性校验、版本切换和 prerm 清理均由引擎负责，不能宣称 dpkg 自带清单已覆盖展开后的文件。首版优先声明式 runtime，用户应用 payload 可 SFX 化。

安装器应持久可用，不能首次解压后删掉唯一安装/卸载入口；postrm 也不能依赖已被 dpkg 删除的包内二进制。

### 3.2 用户组件根

默认 `${XDG_DATA_HOME:-~/.local/share}/QAQ-Harness`，允许通过统一安装登记与显式 override 指定专属路径。建议布局：

```text
components/app/<build-id>/
components/backend/<build-id>/
components/tools/<build-id>/bin/
active.json
install-state.json
operations/<operation-id>/
```

配置、会话、凭据、协议同意记录与可替换程序分离；不写进版本目录。安装根 marker 绑定安装身份、规范路径与用户身份，但 marker 本身不是发行方真实性证明。用户域不得放 root 需要信任执行的代码。

## 4. 各角色只负责什么

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| packer / SFX finalize | 生成 bundle、摘要、发布清单、签名及可选自解压容器 | 安装、协议同意、系统提权 |
| installer GUI | 协议/隐私说明、用户确认、路径与范围选择、首次安装、修复入口 | 在 apt 生命周期弹窗、自行修改 dpkg 数据库 |
| installer CLI | 显式 scope 下首次部署/修复/本地 baseline 提升，输出可检查结果 | 把静默解压伪装成个人同意、隐式取 root HOME |
| 共用维护引擎 | 校验、锁、安装根验证、版本计划、事务、切换、回滚、卸载文件清单 | UI 与平台包管理策略 |
| updater | 检查源、下载/导入、差异计划、暂存、协调进程退出/重启、健康检查与回滚 | 再造一套解包器、随意改协议记录或系统包文件 |
| uninstaller GUI/CLI | 选择范围和数据策略，验证根，停止本安装实例，调用共用引擎清理 | 按全局进程名杀其他安装、无验证递归删除 HOME |
| launcher/bootstrap | 读取安装登记、版本/兼容协调、缺安装转 installer、构造环境、启动明确版本 | 加载旧业务 main 后才决定升级、隐式协议同意 |
| deb scripts / root helper | 系统文件/注册/依赖/权限、系统范围维护、包事务结果 | 代全体用户同意、执行用户目录里的卸载器 |

install / repair / uninstall 可以是同一维护程序的不同子命令、共用一套 UI 外壳，不要求三个独立安装包。updater 仍有独立编排职责，即使最终链接相同引擎库。

## 5. 安装与协议流程

### 5.1 apt 安装

1. dpkg 展开系统底座、installer 与离线 payload。
2. postinst configure 调用无界面系统 provision（若需要），仅处理系统专属路径和注册；重复执行幂等，必要部署失败返回非零。
3. 此时系统底座已安装，但尚未声称任何用户完成激活或同意协议；不自动启动主业务程序。
4. 用户点击 launcher，缺少该用户安装/有效协议同意时进入 installer GUI。
5. 用户阅读并确认协议，选择路径；引擎验证 payload 后部署、提交安装登记及协议同意记录，再启动应用。

如要在 apt 安装时部署所有程序字节，可部署到共享只读基线，而不是给某个用户生成安装登记。用户的协议与首次激活仍独立完成。

### 5.2 独立 SFX 安装

同一离线 payload 用 GUI 直接在用户权限下安装到专属用户根。没有 deb 底座时还必须提供可运行的 runtime、launcher 和维护入口；不得假定机器已有 Electron。用户自带 runtime 不使用用户可写 setuid helper；user namespace 等沙箱支持需探测，不支持时报告前置条件或引导安装系统底座，不能自动退到 --no-sandbox。

### 5.3 无人值守

静默 CLI 必须显式 scope、目标和协议策略。企业管理员可通过受支持配置/debconf 预置明确的管理员部署确认，记录其主体和来源；不能记成某个未参与用户的勾选。需要个人确认的产品功能在首次使用时仍校验。缺少必要确认返回明确状态，不通过缺省 --yes 接受任意未来条款。具体条款和管理员能否代表用户接受须由产品/法务确认。

同意记录绑定文档版本、两份文档摘要、确认主体/来源、时间和 installationId。相同条款普通更新不反复询问；条款变化先要求对应确认，不让后台更新器自动写 accepted=true。尚未确认时可以暂存程序或完成系统底座安装，但不激活依赖新确认的业务功能。

## 6. 更新、版本选择与环境

统一操作链：plan → verify/download → stage → prepare processes → activate → health check → commit；失败回到 last-known-good。app 的 main/preload/renderer 配对；backend/tools 可独立版本但要满足显式兼容约束。所有写入者共用跨进程安装锁；跨用户或不同 userData 不能仅靠 Electron 单实例锁保护同一组件根。

版本目录准备完整后原子切换 active 清单，不在运行目录逐文件混写。进行中的任务固定工具版本；旧版本在引用结束后再 GC。仅修改 renderer 时受控 reload；main/preload 更新重启 Electron；daemon 按安全停止/任务保护契约重启，不强杀活跃任务。进程复用须核对实际构建与环境代际，不能把已运行进程当成新部署进程。

apt 新 baseline 也作为本地更新源提交同一计划，不能另写「首次释放一次」路径。发布先后用可排序序号/版本，buildId/摘要只判相等；同版本不同内容无法自动证明先后，必须有明确的来源/覆盖策略。显式回滚、固定版本、通道切换与安全强制更新分别建模。

launcher 统一解析组件根与选定版本，派生 app/backend/tools 路径。内部工具用绝对路径；shell 工具 PATH 在应用子进程作用域前置自带 bin，不改全局 shell 配置，不透传 daemon 凭据。自带 rg 不需要系统安装；结构化 grep 已用 ripgrep 核心库，外部 rg 主要服务 exec。安全沙箱/system helper 更新与普通工具热更新不是同一种权限级别。

## 7. 卸载生命周期

### 用户卸载

正常权限维护程序确认 installationId/所有者/marker/路径边界并检查符号链接、停止本实例；删除受管理程序和版本/暂存，默认保留用户数据。显式勾选才清理已验证的数据根和相关同意记录。不能依赖待删除 app 的 main 执行卸载；worker 应在稳定位置或先安全交接。CLI 同步返回真实完成结果；异步 handoff 只返回 operationId/started，不能把它当卸载成功。

### apt remove / purge / upgrade

- prerm remove：需要系统引擎时趁二进制尚在执行系统范围清理/停进程；如忙则按明确失败/延期策略处理，不按进程名扫全机。
- postrm remove：不依赖包内已删除二进制的幂等收尾；不删除个人数据。
- postrm purge：删除系统配置/登记/专属残留；不遍历全部 HOME，不把包 purge 等同于所有用户数据擦除。
- upgrade 及异常恢复动作：明确分支，不套用卸载语义；保留兼容 baseline 或给出缺底座状态。root 卸载只运行 root-owned 可信引擎，不运行用户更新后的引擎。

如果用户需要「彻底移除」，维护 GUI 先以该用户身份清理用户安装，再单独请求系统包删除；系统包删除不能在自己的 maintainer script 中递归调用 apt/dpkg。

## 8. 可选 deb 版本登记

遵循 `local-package-registration.md`：不得以 metadata-only 同名 deb 替代仍拥有 runtime 的现有包。登记包只表示全机目标发布；各用户运行版本另记。需要时由受限 helper 安装可信包；不要每次用户组件热更新都要求管理员授权。用户事务与 dpkg 事务写可恢复 journal，不声称跨域原子。

## 9. 实施顺序与验收

1. 从原 installer 提取需求，不直接移植 Windows 注册表/进程/路径实现；将部署和卸载安全规则收敛进本仓共享引擎。
2. 增加安装登记、跨进程锁、版本目录切换及恢复测试；先加固 cleanup 根验证。
3. 增加 Linux 维护 GUI/CLI 与正式法务文档、同意策略、无头行为；现有 WinUI --apply-self 不能原样作为完整安装入口。
4. launcher 对未激活用户先进入 installer，替代当前 bootstrap 自动释放；已激活用户的 deb baseline 升级走共用计划。
5. 更新源、进程切换、工具环境与回滚接入；最后再做可选 SFX 发布、系统 helper/登记包。

验收覆盖：首次安装/拒绝协议/新条款/无头部署、旧 deb 升级/更新后回滚/同版本重构建、不同用户和自选路径、无网络、磁盘满、中断/锁竞争、长任务不误杀、路径链接攻击、remove 后单独 purge、升级异常分支、缺 runtime 时可理解的恢复入口。只有通过隔离环境的真实 apt 生命周期与 GUI 验收后才能宣称发布就绪。
