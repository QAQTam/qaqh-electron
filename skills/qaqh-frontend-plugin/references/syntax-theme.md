# slot: syntax-theme（diff / 代码高亮主题）

```jsonc
{ "slot": "syntax-theme", "light": "light.json", "dark": "dark.json" }
```

两份 shiki/TextMate 主题 JSON，**缺一不可**（缺字段或缺文件 → 扫描跳过）。纯资产，无 JS 无 CSS。
参考件：`plugins/qaqh-syntax-warmpaper`（与消息区暖纸同源色板）。

## JSON 形状

```jsonc
{
  "name": "qaqh-warmpaper-light",
  "type": "light",
  "colors": { /* 编辑器 UI 色，可以很少 */ },
  "tokenColors": [
    { "scope": ["comment", "punctuation.definition.comment"],
      "settings": { "foreground": "#8A8578", "fontStyle": "italic" } }
  ]
}
```

- `type` 与档位对应：`light.json` → `"light"`，`dark.json` → `"dark"`。
- `name` 只是包内标识：真正注册名由宿主改写为 `qaqh:<id>:<mode>:<rev>`
  （`webui/src/diff/highlight.ts:81`），热更即换名重载，不用担心 name 撞车。
- `tokenColors` 是语法着色主体；样例 light.json 只有 2 个 `colors` + 14 条 `tokenColors`，够用。

## 消费链

设置 → 外观 → 代码语法主题，选择存 localStorage `qaqh.syntax-pack`（空串 = 内置 github-light/github-dark）。
`loader.syntaxPackRef()` 给出两份 rev-bust URL；`diff/highlight.ts` 按界面明暗 fetch 一份 →
`highlighter.loadTheme({ ...theme, name })`。只影响 diff/代码高亮，不改壳配色（那是 theme slot 的事）。

## 回退语义（不要试图"修"它）

- 包被删/禁用 → `syntaxPackRef()` 返回 `null` → 内置 github 对。
- fetch/解析失败 → `console.warn` + 回退内置对，高亮不因一个坏包全灭。

所以「改了 JSON 没变化」按此顺序查：进图了吗 → 被选中了吗 → rev 推进了吗（改文件即推进）→
当前界面明暗档对应的那份是不是你改的那份。
