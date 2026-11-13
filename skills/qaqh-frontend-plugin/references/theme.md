# slot: theme（纯 CSS 主题包）

```jsonc
{ "slot": "theme", "css": "theme.css" }
```

无 JS。装载器按用户选择挂 `<link data-qaqh-theme-pack=<id>>`，
href = `app://localhost/plugins/<id>/<css>?rev=<rev>`；切回经典即摘 link。
选择存 localStorage `qaqh.theme-pack`（空串 = 经典），入口：设置 → 外观 → 消息主题包。
参考件：`plugins/qaqh-theme-warmpaper/theme.css`（三档齐全，可直接抄结构）。

## 级联纪律（决定成败）

壳的层序在 `webui/src/styles/app.css:5`：`@layer reset, tokens, base, components, utilities;`

- 插件 CSS **不要写 `@layer`**：未分层样式天然压过任何分层。
- 写了 `@layer` 反而可能被壳的层序压住；不要用 `!important` 去救分层错误。

## 两种覆盖面

1. **消息区主题岛**：只覆写 `--chat-*` 一族。接缝在 `webui/src/styles/shell/layout.css:128` 起，
   `.workspace-content` 子树把 `--bg/--surface/--text…` 重映射到 `--chat-*`，
   顶栏/会话列表/待办栏继续走壳的 Mica。
   族成员：`--chat-bg` `--chat-mica` `--chat-surface` `--chat-surface-2` `--chat-surface-user`
   `--chat-surface-code` `--chat-text` `--chat-muted` `--chat-border` `--chat-code-veil` `--chat-err-soft`。
   缺省定义在 `webui/src/styles/tokens/base.css`（`--chat-bg: var(--bg)` 等；`--chat-mica` 缺省 = `--chat-bg`）。
2. **全壳主题**：覆写基础 token 族（`--bg/--surface/--text/--muted/--border…`），影响整个壳。

## 明暗双档 + 首帧兜底

```css
:root { /* light */ }
:root[data-theme="dark"] { /* dark */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) { /* dark */ }
}
```

第三段是 JS 未落定的首帧兜底，与壳 tokens 的双路规则同构；漏了它首帧会闪一下错色。
界面明暗档存 localStorage `qaqh.theme`（定向 E2E 就是强制写它来固定 light 档）。

## 验证

改完看设置页是否选中该包，再跑 `node scripts/plugin-theme.e2e.mjs`：它验真壳里
link 挂载 → CSS 真实 fetch+解析 → 未分层 `--chat-*` 覆写压过 `@layer tokens`。
