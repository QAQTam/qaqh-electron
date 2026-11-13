# 前端插件契约

插件是**资产包**，不是 npm 依赖：一个目录 + `plugin.json`，经 `app://localhost/plugins/<id>/…`
同源供给，stat-poll（1s，mtime+size 派生 rev）驱动热更——任何写入者（esbuild/vite/手工编辑）
都是合法热更源，无需重启。

## 根目录与优先级

| 根 | 位置 | 语义 |
|---|---|---|
| bundled | 开发=仓库 `plugins/`；打包=`resources/plugins` | 缺省件，只读 |
| user | `~/.qaqh/frontend-plugin` | 导入/管理面写入，同名 id 覆盖 bundled |

禁用名单存于 user 根 `state.json`；graph 帧只含启用且校验通过的条目（graph 是"生效面"，
管理页另走 IPC 全量）。管理动作（导入/启停/删除）即时重扫推送。

## manifest（plugin.json）

```jsonc
{
  "id": "my-plugin",        // 必填，必须等于目录名，^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
  "name": "显示名",          // 可选，缺省 = id
  "version": "0.1.0",       // 可选，管理页展示
  "slot": "overlay",        // overlay | theme | syntax-theme
  "capabilities": []        // overlay 专用，白名单 facade，见下
  // slot 专属字段见各节
}
```

非法 manifest / 资产缺失 → 扫描告警跳过，**不进图**（broken bundle 不能启用）。

## slot: overlay（JS 小工具）

```jsonc
{ "slot": "overlay", "entry": "dist/entry.js", "capabilities": ["gamepad-raw"] }
```

- 入口必须是 **ESM**，`export default { mount(container, host): void | (() => void) }`。
- 宿主容器 `position:fixed; inset:0; pointer-events:none`，插件自管层级与内部
  pointer-events；返回的 dispose 必须移除全部 DOM/监听/定时器（热更与禁用都走它）。
- `host` 是按 capabilities 白名单发放的 facade，当前有：
  - `gamepad-raw` → `host.gamepadRaw(onFrame): unsubscribe`（Gamepad API 原始帧）。
  - `git-status` → `host.gitStatus(): Promise<GitStatusView>`（活动会话工作区的只读 git 状态：
    分支/上游/ahead-behind/暂存·未暂存·未跟踪/未 push 提交）。cwd 由 main 解析
    （`activeSeed` → daemon `workspace.get`），git 子进程只在 main 跑；线形契约见
    `webui/src/lib/git-status.ts`，实现见 `src/main/git-status.ts`。
- 构建：`plugins/<id>/src/entry.ts` → `pnpm plugins:build`（bun ESM，一次）
  或 `pnpm plugins`（watch）。`dist/` 不入库，新克隆先构建。
- 参考件：`plugins/qaqh-snake`（Canvas）、`plugins/qaqh-padview`（SVG）、`plugins/qaqh-git`（facade 取数）。

## slot: theme（消息区/全壳 CSS 主题）

```jsonc
{ "slot": "theme", "css": "theme.css" }
```

- 纯 CSS，无 JS。用户在 设置 → 外观 → 消息主题包 选择后以
  `<link data-qaqh-theme-pack>` 热挂，rev-bust，切回经典即热卸。
- 级联纪律：应用样式在 `@layer tokens/components`，插件 CSS **不带 @layer**，
  未分层天然压过任何层。只覆写 `--chat-*` 一族 = 消息区主题岛；
  覆写全 token 族（`--bg/--surface/--text/…`）= 全壳主题。
- 明暗双档：`:root`（light）+ `:root[data-theme="dark"]`，可加
  `prefers-color-scheme` 首帧兜底（参考 warmpaper）。
- 参考件：`plugins/qaqh-theme-warmpaper`。

## slot: syntax-theme（diff 语法高亮主题）

```jsonc
{ "slot": "syntax-theme", "light": "light.json", "dark": "dark.json" }
```

- 两份 **shiki/TextMate 主题 JSON**（`{name,type,colors,tokenColors}`），缺一不可。
- 用户在 设置 → 外观 → 代码语法主题 选择；`diff/highlight.ts` 按界面明暗取一份，
  经 app:// fetch 注册进 highlighter，注册名含 rev（热更即换名重载）。
- 包失配（删除/禁用）自动回退内置 github-light/dark 对；资产加载失败同样回退，
  高亮不因一个坏包全灭。
- 参考件：`plugins/qaqh-syntax-warmpaper`（与消息区暖纸同源色板）。

## 安全边界（现状记账）

- overlay JS 与宿主**同源无沙箱**：第三方 overlay = 全 DOM 权限。内置/自写阶段可接受；
  开放第三方分发前迁移到 widget 沙箱桥（`webui/src/widget/`，opaque-origin iframe +
  MessageChannel，现成）。
- theme/syntax-theme 是纯数据资产，无 JS 执行面。
- 协议层有路径穿越护栏（relative 检查），CSP `script-src/style-src 'self'` 覆盖。

## 开发流程

```sh
pnpm plugins:build          # 构建全部 overlay 入口（一次）
pnpm plugins                # watch
node scripts/plugin-theme.e2e.mjs   # 真壳链路 E2E（主题/overlay/语法资产）
```

管理面：工具页「前端插件」（导入 zip/目录、启停、删除、打开目录）；
导入落 user 根，即时生效。release 墙：渲染层只应用与首帧同 release 的 graph，
换版本整页刷新后生效。
