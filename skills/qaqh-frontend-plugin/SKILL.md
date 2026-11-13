---
name: qaqh-frontend-plugin
description: Author or debug QAQ-Harness frontend plugins — asset packs with plugin.json under plugins/ or ~/.qaqh/frontend-plugin, covering overlay JS widgets, CSS theme packs and shiki syntax themes. Use when creating a plugin, picking slot/capabilities, or fixing a pack that never enters the graph or will not hot-reload. Not for Claude/Codex plugin packages or MCP servers.
metadata:
  short-description: Build QAQ frontend plugins
---

# QAQ 前端插件

插件是**资产包**，不是 npm 依赖：一个目录 + `plugin.json`，经 `app://localhost/plugins/<id>/…` 同源供给。
main 侧 1s stat-poll（mtime+size 派生 rev）驱动热更，任何写入者（bun/手工编辑）都是合法热更源，**改完不重启**。

## 事实源

| 面 | 文件 |
|---|---|
| 扫描 / rev / graph 帧 | `src/main/plugins.ts` |
| 用户根 / 导入 / 启停 / 删除 | `src/main/frontend-plugins.ts` |
| 装载器（mount / link / 目录 signal） | `webui/src/plugins/loader.ts` |
| 资产供给 + CSP | `src/main/index.ts` `registerAppProtocol` |
| 构建 | `scripts/plugins-watch.mjs` |
| 语法主题消费 | `webui/src/diff/highlight.ts` |
| 管理面 / 选择面 | `webui/src/app/ToolsPage.tsx`「前端插件」 / `webui/src/settings/SettingsView.tsx` 外观节 |

`docs/plugins.md` 只是概览，且已有一处过时：它写构建器是 esbuild，实际 spawn 的是 **bun**。冲突时以代码为准。

## 落位与优先级

- bundled 根：开发 = 仓库 `plugins/`，打包 = `resources/plugins`。**开发期把插件写在这里**。
- user 根：`~/.qaqh/frontend-plugin`，管理面导入落这里，同名 id 覆盖 bundled。
- 禁用名单：user 根 `state.json` 的 `{ "disabled": [...] }`。
- graph 只含「启用 + 校验通过」的条目；管理页另走 IPC 拿全量（含禁用）。

已核实的供给缺口：`registerAppProtocol` 的 `baseDir` 只取 `pluginsRoot()`（bundled），没有 user 根回退
（`src/main/index.ts:504`）。user 根导入的包会进 graph、出现在管理页，但资产 URL 仍解析到 bundled 根 → 404。
所以新插件一律先在仓库 `plugins/` 下开发验证；要修这个缺口就改协议层按 graph 的同源优先级解析 `/plugins/<id>/`，
不要在插件侧绕。

## manifest 契约

```jsonc
{
  "id": "my-plugin",     // 必填，必须 === 目录名，^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
  "name": "显示名",       // 可选，缺省 = id
  "version": "0.1.0",    // 可选，只在管理页展示
  "slot": "overlay",     // overlay | theme | syntax-theme，其它值直接跳过
  "capabilities": []     // overlay 专用白名单："gamepad-raw" | "git-status"
}
```

slot 专属字段：overlay → `entry`；theme → `css`；syntax-theme → `light` + `dark`（两份文件都必须存在）。
manifest 不可读 / id ≠ 目录名 / slot 未知 / 专属字段缺失 / 资产文件不存在 → `console.warn` 跳过，**不进图**。
注意管理页只校验 id，所以坏包会出现在管理页却不在图里——这不是矛盾，是两套判据。

## 选 slot

| 目标 | slot | 细则 |
|---|---|---|
| 浮动小工具 / 游戏 / 覆盖层（要跑 JS） | `overlay` | [references/overlay.md](references/overlay.md) |
| 消息区或全壳配色（纯 CSS） | `theme` | [references/theme.md](references/theme.md) |
| diff / 代码高亮配色（纯 JSON） | `syntax-theme` | [references/syntax-theme.md](references/syntax-theme.md) |

只读当前任务需要的那一份。

## 热更与 rev

- rev 由 main 算：overlay/theme = `max(manifest,资产 mtime):资产size:manifestSize`；
  syntax-theme = `max(三份 mtime):light+dark size:manifestSize`。改文件即推进，不 hash 内容。
- 帧通道 `qaqh:event:plugins://graph`，payload `{ release: app.getVersion(), entries }`。
- **release 墙**：装载器只应用与首帧同 release 的图；换宿主版本必须整页刷新，否则帧被丢弃并 warn。
- overlay：rev 变 → `dispose()` + 移除容器 → rev-bust 重新 import → 重 mount。mount 抛错记进
  `pluginStatus.failed`，下一帧自动重试。
- 管理动作（导入/启停/删除）走 `notifyPluginsChanged()` 立刻重扫，不等 1s tick。

## 构建与验证

```sh
pnpm plugins:build                  # 单次构建全部 overlay 入口（bun 需在 PATH）
pnpm plugins                        # watch
node scripts/plugin-theme.e2e.mjs   # 定向真壳 E2E：graph→主题 link→CSS 解析→未分层压层→overlay 挂载
```

- 约定 `plugins/<id>/src/entry.ts` → `plugins/<id>/dist/entry.js`（ESM，target browser）；
  没有 `src/entry.ts` 的目录跳过构建（theme/syntax 是纯资产）。
- `dist/` 被 .gitignore 忽略：新克隆先构建，否则扫描报「不存在（先跑构建）」并跳过。
- 只改插件资产时**不要**跑全局测试套（`node --test scripts/*.test.mjs`）；用上面的定向 E2E，
  加上工具页「前端插件」的装载器自述状态（收图帧数 / 图内 id / 已挂载 / 失败原因 / 主题面）。
- 主题与语法包是否生效还要看选择：localStorage `qaqh.theme-pack` / `qaqh.syntax-pack`，空串 = 内置。

## 不进图 / 不生效的排查顺序

1. 目录名 === `manifest.id`？id 匹配正则？
2. slot 拼写对？专属字段齐全且文件真实存在（overlay 先构建出 `dist/`）？
3. 被 user 根同 id 覆盖了？在 `state.json` 禁用名单里？
4. 工具页装载器状态：图内有它吗？`failed` 里有它吗（那里有真实异常文本）？
5. 资产 404 → 是不是只存在于 user 根（见上面的供给缺口）？
6. 刚换过宿主版本没整页刷新 → release 墙丢帧。

## 安全边界

overlay JS 与宿主**同源无沙箱**，等于全 DOM 权限；CSP `script-src 'self'`、`frame-src 'none'`，
不能引远程脚本、不能开 iframe。theme/syntax-theme 是纯数据资产，无 JS 执行面。
要开放第三方分发，先把 overlay 迁到 `webui/src/widget/` 的 opaque-origin iframe + MessageChannel 沙箱桥，
别在现有同源面上堆补丁。
