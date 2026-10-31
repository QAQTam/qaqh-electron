# 用户域组件与本地 deb 版本登记（设计评估，未实现）

实施入口：[spec-install-maintenance-mvp.md](spec-install-maintenance-mvp.md)。本文件内容属于后续可选阶段，**不阻塞首版，不在本轮实现 pkexec 或登记 deb**。

## 结论

可以将自研 installer 的用户域部署与系统包版本登记组合，但这属于「系统包登记 + 自研组件管理」，不等价于 dpkg 拥有用户目录里的全部文件。不要用一个仅含元数据的同名 deb 替换当前完整 `qaqh-electron` 包；dpkg 升级会移除旧包文件清单中、新包不再携带的文件，包括仍需使用的 runtime、bootstrap 和 CLI。

## 推荐边界

- `qaqh-shell`：系统级，拥有运行时、系统 bootstrap、desktop/icon、固定权限 helper 和离线 baseline。也可暂时保留现有包名作为 shell 包。
- 用户组件：installer/updater 在普通用户权限下部署 app/backend/tools，负责摘要、活动版本、修复、回滚、环境构造。程序版本以这里的活动清单为准。
- 可选 `qaqh-release`：独立的小型登记包，记录全机目标/发布版本并依赖受支持的 shell。它不能假装表示所有用户实际运行版本。
- 如果坚持只用一个包名，每份新 deb 必须保留它拥有且仍需存在的系统文件，或先完成显式拆包与依赖迁移，不能只改 Version 字段。

## 提权

GUI installer 保持普通用户身份，不用 pkexec 启动整套 Electron/installer。只在确有系统登记变化时调用固定的 root-owned helper。helper 负责检查允许的包名、架构、依赖、版本、文件路径和维护脚本策略，并在 root-only staging 中固定待安装输入后再调用包管理器。不使用用户可修改目录里的脚本/二进制作为 root 卸载器，不将用户自报摘要当作发行方签名。

直接授权任意用户生成 deb 给 root apt/dpkg 安装，意味着授权该包内任意维护脚本以 root 执行。pkexec 只提供授权入口，不提供上述内容验证。推荐由发布流水线生成受验证的小型登记包或严格受限的数据描述，由固定 helper 转换，而非用户目录里自由生成含脚本的包。

不要直接改 `/var/lib/dpkg/status`，不要绕过 apt/dpkg 锁，不在 maintainer script 内再次启动 apt/dpkg。不需要登记的普通组件热更新不应每次要求管理员授权。

## 一致性与生命周期

用户组件切换和 dpkg 事务不是同一个原子事务。installer 应记录 operationId、installationId、uid、目标版本与两个阶段的结果；取消授权/锁忙/安装失败不能伪报已登记，dpkg 登记成功但组件激活失败也必须可恢复或显式标记 pending。可用序列为：暂存并验证组件 → 请求系统登记 → 用户域激活并健康检查 → 提交；失败保留旧活动版本并记录待恢复操作。登记包表示目标版本，而不是在提交前宣称该用户已运行目标版本。

本地安装 deb 不会自动形成 apt 仓库，后续升级仍需 installer 提供包或配置正式源。包版本遵循 Debian 版本比较规则，仓库候选与本地版本的优先策略需另定，不能用任意 git hash 比较先后。

系统登记是全机级，用户组件是每 uid 级；多用户可以运行不同组件版本，不能只靠一个 `dpkg-query Version` 代替运行版本显示。建议同时展示 shell 包版本、实际 app/backend/tools 构建和登记目标版本。

卸载时必须区分 remove/upgrade/purge。随包安装的引擎可能在 postrm remove/purge 前已经被删除，因此系统程序清理在 prerm 或稳定依赖 helper 中执行，postrm 做不依赖已移除二进制的幂等收尾。系统 purge 不遍历所有用户 HOME 清理；用户组件卸载由对应用户的卸载器负责。当前 `qaqh-maint cleanup` 缺少安装根 marker 验证，未加固前不得作为 root 路径清理接口。

## 本轮启动修复的边界

本轮只修复系统 bootstrap 在业务 main 前的 baseline 协调和路径一致性；没有实现本地登记包、pkexec helper、全目录事务、跨 runtime/协议兼容求解或在线 daemon 的自动迁移。系统包版本更高时提升用户组件；相同版本但 baseline 内容变化时覆盖一次，receipt 防止后续同版本热更新被反复覆盖。应使用可排序的发布版本消除同版本构建的时间歧义。
