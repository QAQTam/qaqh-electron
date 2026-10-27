# QAQ-Harness 壳层布局与窗口自绘 Spec

- 状态：Draft v0.1（待评审）
- 日期：2026-10-27
- 范围：`qaqh-electron` 宿主 + `../qaqh-desktop-app` renderer
- 相关：`docs/interaction-semantics.md`、`HANDOFF.md`
- 规范词：**MUST** / **SHOULD** / **MAY**（按 RFC 2119 语义）
- 代码缩写：`E/` = `qaqh-electron/src`，`R/` = `qaqh-desktop-app/src`

---

## 0. 摘要

把当前 **4 垂直 × 4 水平** 的嵌套壳，收敛为 **2 行 × 3 列** 的单一壳 grid：

- 窗口改为无边框（frameless），由 renderer 用 CSS 自绘 1px 外框与 pane 分隔线。
- 原生标题栏 + Electron application menu + renderer `#top` 合并为 **一个 48px TopBar**。
- 左侧 64px `GlobalNav` 合并进 `MessageSidebar`，形成 **288px Sidebar**（nav + 会话）。
- `WorkspacePanel` 从 `.session-column` 内部提升为 `#app` 的 **第三列 RightRail**。
- `SessionHeader` 从 `#session` 的 40px 行移入 TopBar，会话页只剩 messages + composer 两段。
- 菜单动作（模型 picker / 关于 / 退出）迁移到 TopBar 溢出菜单；tray 菜单保留。

目标平台以 Linux x64 为先，Windows/macOS 保留回退路径。

---

## 1. 背景

### 1.1 现状：4×4 是三层嵌套 grid 叠出来的

```
当前视觉（Linux/Windows 会话页）:
┌ 系统标题栏 QAQ-Harness ──────────────────────────┐  ← 垂直 1
├ 应用菜单 QAQ-Harness / 模型 ─────────────────────┤  ← 垂直 2
├ #top 40px “消息” ────────────────────────────────┤  ← 垂直 3
│ nav 64 │ sidebar 244 │ main │ right rail 320/40  │  ← 垂直 4（body）
└──────────────────────────────────────────────────┘
水平：64 + 244 + main + 320 = 4 列
```

来源：

- `#app`：`64px + 1fr`（`R/styles/shell/layout.css:5`）
- `.workspace.workspace-messages`：`244px + 1fr`（`R/styles/shell/layout.css:37`）
- `.session-column`：`minmax(0,1fr) + auto`（`R/styles/components/timeline.css:15-21`）
- `#session`：`40px + minmax(0,1fr) + auto`（`R/styles/components/timeline.css:28`）
- `#top` 40px 标题栏（`R/app/App.tsx:460-468`；`R/styles/shell/layout.css:9-31`）
- Electron application menu 两个顶级菜单（`E/main/index.ts:245-272`）

### 1.2 问题

1. **垂直 chrome 过厚**：系统标题栏 + 应用菜单 + `#top` 约 96px；800px 高窗口占 12%。
2. **水平列过多**：nav、sidebar、main、right rail 四列；嵌套 grid 让“收口”无处发生。
3. **标签重复**：`#top` 的“消息”与 nav 的“消息”重复；标题还压在 64px nav 上方，不对齐内容。
4. **右栏被埋在会话列里**：`WorkspacePanel` 在 `.session-column` 第二列，无法独立响应壳宽度。
5. **会话内还有 40px 标题行**：`SessionHeader` 让 main 变成 header + messages + composer 三段。
6. **原生菜单独占模型入口**：native picker 只在 application menu/tray 中（`E/main/index.ts:254-296`），TopBar/启动 chip 没有同一入口。
7. **无自绘边框**：窗口外框、分隔线、标题栏都由 OS/Electron 画，视觉上无法与 1px token 体系统一。

### 1.3 目标

- 壳结构 **2 行 × 3 列**；列内最多 2 段。
- 窗口无边框，自绘 1px 外框/分隔线；TopBar 是唯一窗口 chrome。
- 保留现有功能：会话列表、会话切换、模型 picker、设置、tray、退出确认、右栏待办。
- 让 scope（目录/模型/权限）在发射台可见（行为不变量见 §8）。
- 改动可分段落地、可回退；Linux/Wayland 风险先 spike。

### 1.4 非目标

- 不重做消息时间线、Markdown、Diff、审批卡的内部视觉。
- 不新增 agent 能力、不改变 daemon 契约、不改变审批语义（见 `docs/interaction-semantics.md`）。
- 不解决模型/权限数据层的“单一真相”全部实现；本 spec 只规定壳必须暴露的入口与显示位置，数据 plumbing 另立工作流（§8.4/§8.5）。
- 不做移动端原生 app；`<800px` 只保证 renderer 预览/窄窗可用。

---

## 2. 术语与计数规则

### 2.1 结构层（structural layer）

指应用壳的 **`#app` grid 行**。本 spec 只允许 2 行：

1. `TopBar`
2. `body`（Sidebar / Main / RightRail 所在行）

### 2.2 Pane（列）

指 `#app` grid 的 **列**。本 spec 最多 3 列：

1. `Sidebar`
2. `Main`
3. `RightRail`

### 2.3 Column section（列内段）

指某个 pane 内部的垂直分区。每个 pane **MUST ≤ 2 段**：

- Sidebar：nav + 会话列表
- Main：内容（messages/startup/tools/...）+ composer
- RightRail：header + body

`SessionHeader` 不再作为 Main 的独立段；它移入 TopBar（§6.4）。

### 2.4 Content block（内容块）

hero、配置栏、建议卡片、消息回合、审批卡、toast 等。**不计入结构层/列内段**；否则任何聊天页都不止 2 段。

### 2.5 自绘边框（self-drawn border）

- 窗口外框：`#app` 的 1px `border` + 可选 `border-radius`，由 renderer CSS 绘制。
- Pane 分隔线：TopBar 下边、Sidebar 右边、RightRail 左边各 1px。
- 不使用 native title bar / native menu bar 作为可见 chrome。
- 不要求圆角；圆角是可选增强，必须有实底/方角回退（§5.7）。

### 2.6 计数口径

- “垂直最多 2” = 壳行数 ≤ 2；列内段 ≤ 2。
- “水平最多 3” = 壳列数 ≤ 3。
- 抽屉/浮层（drawer/overlay）**不计为列**，但同一时刻最多一个抽屉打开。
- 顶栏内部的左/中/右是同一行内的排版，不计为壳列。
- 本 spec 采用严格口径：`SessionHeader` 也算垂直段，因此移入 TopBar。

---

## 3. 目标结构

### 3.1 目标图

```
┌ TopBar 48px（拖拽 + 标题 + 模型/权限 + ⋯ + — □ ✕）─────────────┐  row 1
├ Sidebar 288 ┬ Main 1fr ─────────────────────┬ RightRail 320/40 ┤  row 2
│ nav 2×2     │ messages                      │ 任务              │
│ 会话 list   │ composer                      │                   │
└─────────────┴───────────────────────────────┴───────────────────┘
```

### 3.2 组件树

```
#app
├─ #topbar        (TopBar: brand/back, session title, model/permission, overflow, window controls)
├─ #sidebar       (Sidebar: Nav 2×2 + SessionList)
├─ #main          (SessionView + Composer | StartupView | ToolsPage | OAuthPage | SettingsView)
├─ #right-rail    (RightRail: WorkspacePanel → TaskPanel)
└─ #overlays      (fixed/absolute: toast, context menu, quit dialog, diff drawer; NOT a shell row/column)
```

### 3.3 精确 grid

```css
#app {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) auto;
  grid-template-rows: var(--topbar-height) minmax(0, 1fr);
  width: 100%; height: 100%;
  min-width: 0; min-height: 0;
  overflow: hidden;
  background: var(--bg);
  border: 1px solid var(--window-border);
  border-radius: var(--window-radius);
}

#topbar     { grid-column: 1 / -1; grid-row: 1; }
#sidebar    { grid-column: 1; grid-row: 2; border-right: 1px solid var(--pane-divider); }
#main       { grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; }
#right-rail { grid-column: 3; grid-row: 2; width: var(--rail-width); border-left: 1px solid var(--pane-divider); }
```

Token 默认值：

```css
:root {
  --topbar-height: 48px;
  --sidebar-width: 288px;
  --rail-width: 320px;
  --rail-collapsed-width: 40px;
  --window-radius: 12px;
  --window-border: color-mix(in srgb, var(--border) 70%, var(--muted));
  --pane-divider: var(--border);
}
```

### 3.4 TopBar 内部 grid

```css
#topbar {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) auto;
  align-items: center;
  min-width: 0;
  background: var(--surface);
  border-bottom: 1px solid var(--pane-divider);
  -webkit-app-region: drag;
}
```

- 左格：app mark / 返回按钮 / 窄窗菜单按钮；宽度对齐 Sidebar。
- 中格：会话标题 / 页面标题；**左缘对齐 Main**，不再压在 nav 上方。
- 右格：模型 chip、权限 chip、连接状态、`⋯`、窗口控制。
- 所有 button / chip / input / menu **MUST** `-webkit-app-region: no-drag`。

---

## 4. 布局契约（normative）

### 4.1 单一壳 grid

- `#app` **MUST** 是唯一定义壳行/列的元素。
- `#app` 的 **in-flow** 直接子元素 **MUST** 只有：`#topbar`、`#sidebar`、`#main`、`#right-rail`。
- 瞬态浮层（`ToastHost`、`ContextMenuHost`、`DiffReviewDrawer`、退出确认、`ApprovalStack`）**MUST** 为 `position: fixed`/`absolute`，或挂到单一 `#overlays` 容器；它们 **MUST NOT** 产生 grid track。审计时只检查 in-flow 子元素。
- **MUST NOT** 再出现 `#top`。
- **MUST NOT** 在 `.workspace`、`.workspace-content`、`.session-column` 上定义 `grid-template-columns`（单列除外，如 `grid-template-columns: minmax(0,1fr)` 可以，但不得形成第二组可见列）。
- **MUST NOT** 出现第 4 个可见列；右栏在窄窗只能以 drawer/overlay 出现，不占列。

### 4.2 行契约

- `#app` 恰好 2 行：`var(--topbar-height)` + `minmax(0,1fr)`。
- body 行 **MUST** `min-height: 0`；滚动只发生在 pane 内部，不允许壳级纵向滚动。
- TopBar **MUST** 48px（±2px 可按平台调整，但必须单一值）。
- 会话页 **MUST NOT** 再有 40px `SessionHeader` 行；标题在 TopBar。

### 4.3 列契约

- ≥1280px：3 列，`288px + minmax(0,1fr) + 320px`。
- 800–1279px：2 列，`288px + minmax(0,1fr)`；RightRail 作为 drawer，不占列。
- <800px：1 列（Main）；Sidebar 与 RightRail 都是 drawer，不占列。
- `#app.no-rail`：`grid-template-columns: var(--sidebar-width) minmax(0,1fr)`；RightRail `display:none`。
- Sidebar 宽度 **SHOULD** 保持 288px；在 800–959px 可降到 240px，但必须由 token 控制，不得散落魔法数。

### 4.4 Pane 内部段数

| Pane | 段 1 | 段 2 | 约束 |
|---|---|---|---|
| Sidebar | Nav 2×2 | 会话列表（header + groups） | 2 段；nav 固定，列表滚动 |
| Main | 内容区 | Composer | 2 段；内容区滚动，composer 固定 |
| RightRail | Header（任务 + count + collapse） | Todo body | 2 段；body 滚动 |
| TopBar | 左 / 中 / 右 | — | 单行 3 格，不计列 |

- 启动页：Main 的“内容区”= setup block（hero/scope/config/suggestions）；Composer 是第二段。建议卡片是 content block，不是独立段。
- Tools/OAuth/Settings：Main 只有 1 段（内容区），无 composer；RightRail 隐藏。

### 4.5 页面模式矩阵

| 模式 | Sidebar | Main | RightRail | TopBar 标题 |
|---|---|---|---|---|
| messages / startup | Nav + 会话列表 | StartupView（setup + composer） | 隐藏 | 新会话 |
| messages / session | Nav + 会话列表 | messages + composer | 任务（≥1280 列；<1280 drawer） | 会话标题 |
| tools | 仅 Nav | ToolsPage | 隐藏 | 工具 |
| oauth | 仅 Nav | OAuthPage | 隐藏 | 接入 |
| settings | 仅 Nav | SettingsView（或 overlay） | 隐藏 | 设置 |

- Settings **MAY** 保持 overlay；如果 overlay，**MUST NOT** 新增壳行/列；TopBar 与 Sidebar 保持可见。
- 非消息页 **MUST** 隐藏会话列表与 RightRail；Main 占满剩余列。

### 4.6 断点

| Viewport | 壳列 | Sidebar | RightRail | TopBar |
|---|---|---|---|---|
| ≥1280px | 3 | 288 常驻 | 320 真实列；可收 40 | 288 / 1fr / auto |
| 800–1279px | 2 | 288 常驻 | drawer（不占列） | 288 / 1fr / auto |
| <800px | 1 | drawer | drawer | auto / 1fr / auto（含菜单按钮） |

- 断点 **MUST** 以 `#app` 的实际宽度为准，不能只看 `window.innerWidth`；窗口 chrome/缩放会影响实际内容宽度。
- 由于 `#app` 不能查询自身，实现 **MUST** 用 `@media` + `ResizeObserver` 切换 `#app` 的 class（如 `.cols-3`/`.cols-2`/`.cols-1`），或在 `#root` 上建立 container 后由 `@container` 控制；两种方式都必须让 §12.1 的 computed-track 断言通过。
- `<800px` 时，现有 `@media (max-width:720px)` 把 `GlobalNav` 放到底部第 3 行（`R/styles/utilities.css:23-32`）的规则 **MUST** 删除；导航改由 Sidebar drawer 承载，壳保持 2 行。
- RightRail 在 <1280px **MUST NOT** 自动展开；只显示 badge/触发按钮，用户手动打开 drawer。

### 4.7 内容宽度与容器查询

- `--content-width: 760px` 保留（`R/styles/tokens/base.css:110`）；Main 内内容列继续居中。
- `@container workspace` 目前挂在 `.workspace-content`（`R/styles/shell/layout.css:41`）；**MUST** 迁到 `#main`（container 名可保留 `workspace` 以少改样式）。
- 启动页 4 卡片断点、composer 宽度、suggestion 列数 **MUST** 以 Main 宽度计算，不再以整个 workspace 计算。
- `WorkspacePanel` 的 `NARROW_RAIL_MAX=720` 现在量 `.session-column`（`R/workspace/WorkspacePanel.tsx:71-80`）；**MUST** 改为量 `#main` 或 `#app`，并重新标定阈值。
- 启动页 **SHOULD** 让 composer 成为最宽/最重的元素；hero 不再使用产品名（见 §8.7）。

### 4.8 禁止模式（review checklist）

- [ ] `#app` 之外出现壳级 `grid-template-columns` 的多列布局。
- [ ] `.session-column` 仍把 RightRail 放在第二列。
- [ ] `#top` 仍存在或仍占 40px 行。
- [ ] `<720px` 仍把 GlobalNav 放到底部第 3 行。
- [ ] ≥1280px 时 RightRail 用 overlay 覆盖正文。
- [ ] 顶栏按钮/输入没有 `no-drag`，导致无法点击/输入。
- [ ] 壳表面使用 `backdrop-filter`（性能与边框清晰度都受损；抽屉/浮层除外）。

---

## 5. 窗口与自绘边框

### 5.1 BrowserWindow

目标配置（Linux/Windows；macOS 见 §5.7）：

```ts
new BrowserWindow({
  width: 1200,
  height: 800,
  minWidth: 800,
  minHeight: 600,
  frame: false,
  resizable: true,
  hasShadow: true,
  backgroundColor: initialThemeBackground, // 从已存主题/nativeTheme 取，避免深色闪白/浅色闪黑
  // transparent: true, // 仅在需要圆角且平台支持时启用；默认关闭
  webPreferences: { /* 不变 */ },
});
```

- `frame: false` 是“垂直 2 层”的前提：没有 native title bar，也没有窗口内 menu bar。
- `transparent` **MUST NOT** 作为默认；默认实底 + 1px 边框 + 方角。圆角是可选增强。
- `minWidth: 800` 与 §4.6 的 2 列模式对齐；若产品要求始终 3 列，则 `minWidth` 提高到 1280，但本 spec 不要求。

### 5.2 外框与分隔线

- `#app`：`border: 1px solid var(--window-border)`；`border-radius: var(--window-radius)`；`overflow: hidden`。
- TopBar 下边、Sidebar 右边、RightRail 左边：各 1px `var(--pane-divider)`。
- 外框颜色 **MUST** 在 light/dark 下都可辨认；不要只用 `--border`（可能与背景过近）。
- 壳表面 **MUST** 不透明：TopBar/Sidebar/RightRail 用 `var(--surface)`，Main 用 `var(--bg)`；不要用玻璃/backdrop-filter。
- 可选：`box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 55%, transparent)`（light）/ `inset 0 1px 0 rgb(255 255 255 / 6%)`（dark），只做 1px 高光，不做大阴影。

### 5.3 TopBar

- 高度 48px；`-webkit-app-region: drag`；所有交互元素 `no-drag`。
- 左格：app mark（“QAQ-Harness” 12–13px，muted）或返回按钮；<800px 时换成菜单按钮（打开 Sidebar drawer）。
- 中格：会话标题 / 页面标题；左缘与 Main 对齐；标题过长省略，`title` 提供全文。
- 右格：模型 chip、权限 chip、连接状态、`⋯` 溢出菜单、窗口控制。
- 双击 TopBar 空白区 **MUST** 切换最大化；标题文本/按钮/输入框 **MUST NOT** 触发最大化。
- 会话标题的双击重命名：标题文本 `no-drag`，双击重命名；标题周围的空白仍可拖拽/双击最大化。两者不得冲突。
- TopBar **MUST NOT** 再显示“消息/工具/接入/设置”这类与 Sidebar active 项重复的页面名；中格显示具体会话/页面标题。

### 5.4 窗口控制

- 3 个按钮：最小化、最大化/还原、关闭；每个至少 44×32 命中区，图标 12px，垂直居中。
- 关闭按钮 hover：`--err` 背景 + `--on-accent` 图标；最小化/最大化 hover：`--surface-2`。
- `aria-label`：`最小化`、`最大化`/`还原`、`关闭到托盘`；`focus-visible` 环可见。
- 最小化 → `win.minimize()`；最大化 → `win.isMaximized() ? unmaximize() : maximize()`；关闭 → `win.close()`。
- 关闭语义 **MUST** 与当前 native 行为一致：关闭窗口 = 隐藏到 tray（`E/main/index.ts:224-228`），不是退出。退出走 `⋯` 菜单的“退出…”，调用 `requestRendererQuit()`（`E/main/index.ts:317`）。
- 最大化状态 **MUST** 由 main 的 `maximize`/`unmaximize` 事件推送到 renderer（如 `window://maximized`），按钮图标随之切换。
- 双击 TopBar 切换最大化；`Esc` 不改变窗口状态。

### 5.5 菜单迁移

当前 application menu（`E/main/index.ts:245-272`）：

- `QAQ-Harness` → 关于、退出…
- `模型` → 选择新会话默认模型…、更改当前会话模型…

目标：

- Linux/Windows **MUST** 移除可见 application menu（`Menu.setApplicationMenu(null)`）；tray 菜单保留。
- TopBar `⋯` 菜单 **MUST** 提供：
  - 选择新会话默认模型…
  - 更改当前会话模型…
  - 分隔线
  - 设置…
  - 关于 QAQ-Harness
  - 分隔线
  - 退出…
- `model-picker:open` 已在 main 注册（`E/main/ipc-handlers.ts:215-219`），但 preload 只暴露 load/save（`E/preload/index.ts:30-32`）；**MUST** 在 `DesktopHostBridge.modelPicker` 增加 `open(args?)`，并允许 TopBar 模型 chip 直接打开 native picker。
- 快捷键 **MUST** 保留：
  - `Ctrl+Shift+M` 打开模型 picker（原 application menu accelerator）。
  - `Ctrl+,` 设置（renderer 已有）。
  - `Ctrl+Q` 退出确认（原 menu accelerator；renderer 或 main `before-input-event`）。
  - `Ctrl+T/W/Tab/1-9` 按 §8.1/§8.2 的新语义。
- macOS **MAY** 保留系统 application menu（关于/退出/编辑角色）；窗口内仍用 TopBar `⋯` 提供模型/设置入口。
- 移除 menu 前 **MUST** 先完成 TopBar 菜单与快捷键，避免“动作消失”。

### 5.6 主题

- `createMainWindow` 当前 `backgroundColor: "#18181b"`（`E/main/index.ts:199`）；浅色主题首帧会闪黑。**MUST** 从已存主题/`nativeTheme` 取初始背景。
- 模型 picker 当前硬编码深色（`E/main/model-picker.ts:14`）；**MUST** 使用与主窗口一致的 light/dark（传 query、读 `nativeTheme`，或改为 renderer 路由）。
- 外框/分隔线/窗口控制 **MUST** 使用 token，不写死颜色；light/dark 都要检查对比度。
- 主题切换时只过渡壳表面（TopBar/Sidebar/RightRail/Main 背景），不要过渡消息树。

### 5.7 平台回退

| 平台 | 方案 | 备注 |
|---|---|---|
| Linux X11 | `frame:false` + 自绘控制 | 先 spike 边缘缩放；WM 一般可用 |
| Linux Wayland | 先 spike | 无边框边缘缩放可能不可用；回退见下 |
| Windows | `frame:false` + 自绘控制；测 `thickFrame` | 保留 snap/最大化动画；自绘按钮位置符合 Windows |
| macOS | `titleBarStyle:"hiddenInset"` + 原生交通灯 | 不自绘交通灯；TopBar 左留 78px；菜单留在系统栏 |

回退顺序：

1. `frame:false` 自绘（首选）。
2. `titleBarStyle:"hidden"` + 原生 resize/shadow，renderer 画内部 1px 边框（层数仍 2，边框部分自绘）。
3. 保留 native frame，仅画内部边框（最后回退；不满足“窗口外框自绘”，但保证可用）。

- `transparent:true` 不可用时：`--window-radius: 0`，实底 + 1px 边框；不得出现黑角。
- Wayland 下如果拖拽/缩放都不可用，**MUST** 在 spec 评审中记录并选择回退 2 或 3；不能静默发布“拉不动”的窗口。

---

## 6. 各 pane 规格

### 6.1 Sidebar（288px）

结构（2 段）：

1. **Nav 2×2**：消息 / 工具 / 接入 / 设置；每项 ≥44px 高，图标 18px，label 12–13px；active 用 `--accent-soft` + `--accent`；`aria-current="page"`。
2. **会话列表**：
   - header：“会话” + 非归档会话数 + `+`（新建会话，打开 Startup）。
   - 分组：工作区名 + 会话数；沿用现有稳定排序、keyed 列表、hover 显示 `…` 的行为（`R/app/MessageSidebar.tsx`）。
   - 行内：状态点（running）、待响应卡（permission/ask/plan）、`…` 菜单（移动到工作区 / 移出 / **关闭会话**）。
   - 关闭会话 **MUST** 有草稿确认；不得静默丢弃草稿。
   - 空工作区：**SHOULD** 显示（带“在此新建会话”），或明确标注“仅显示有会话的工作区”；不能注册后完全消失。
3. 非消息页：只显示 Nav；会话列表隐藏；Main 占满剩余列。
4. 滚动：Nav 固定；会话列表 `min-height:0; overflow:auto`；不允许整列滚动带走 Nav。
5. 宽度：288px；`--sidebar-width` 控制；不要散落 244/288 两个魔法数。
6. <800px：Sidebar 变 drawer（覆盖 Main，宽 288，背景实底，Esc/遮罩关闭）；不占列。

### 6.2 Main（1fr）

- 会话页：`grid-template-rows: minmax(0,1fr) auto`（messages + composer）；`SessionHeader` 不在 Main 内。
- 启动页：`StartupView` 作为内容区；composer 在 StartupView 内或作为第二段；setup block 可滚动，composer 固定。
- 工具/接入/设置：单段内容；`overflow:auto` 由页面自己管理。
- `#main` **MUST** `min-width:0; min-height:0`；内容列 760px 居中。
- `@container workspace` 挂在 `#main`；启动页 4 卡片/composer 断点按 Main 宽度。
- 会话标题、重命名、复制 ID/路径移到 TopBar；Main 顶部不再有 40px header。

### 6.3 RightRail（320 / 40 / drawer）

- ≥1280px：真实第三列；宽 320；可收 40（图标栏）；**MUST NOT** overlay 正文。
- <1280px：不占列；通过 TopBar/右缘按钮打开 drawer；**MUST NOT** 自动展开。
- 结构：header（“任务” + count + collapse）+ todo body；沿用 `WorkspacePanel` 的 todo 状态视觉。
- 命名：**MUST** 从“工作区”改为“任务”（或“待办”），避免与 Sidebar 的“工作区”分组冲突。
- 数据：仍用 `store.todos`；不改 todo RPC。
- 测量：`NARROW_RAIL_MAX` 改为量 `#main`；≥1280 时右栏开合只推挤 Main，不覆盖消息。
- 无 todo 时：≥1280 默认收起 40 或隐藏；<1280 不显示触发按钮（或 badge=0 隐藏）。

### 6.4 TopBar 会话标题

- 复用 `SessionHeader` 的数据/交互：folder icon、title、双击重命名、`…`（重命名/复制 ID/复制路径）。
- 放在 TopBar 中格；标题文本 `no-drag`；输入框 `no-drag`；菜单 `no-drag`。
- 标题为空时显示“新会话”；启动页显示“新会话”，不显示产品名。
- 重命名提交仍走 `session.rename` + 本地覆盖；错误 toast 保留。
- `SessionHeader` 的 `role="banner"` 语义移到 TopBar；Main 不再有 banner。

---

## 7. 页面模式与响应式

### 7.1 messages / startup

- TopBar：左 app mark；中“新会话”；右模型/权限 chip + `⋯` + 窗口控制。
- Sidebar：Nav + 会话列表（有会话时）；`+` 打开 Startup（不是立即建空会话）。
- Main：setup block（scope summary + config + suggestions）+ composer。
- RightRail：隐藏（没有会话/todo）。
- 启动页 **SHOULD** 在 composer 上方常驻一行 scope summary：
  `qaqh-electron · /home/.../qaqh-electron · workspace-write · deepseek-v4.1 · high`
  目录显示可消歧的父目录/末段名；模型显示解析后的值；权限只读，点击跳设置。

### 7.2 messages / session

- TopBar：中格会话标题；右格模型/权限/状态。
- Sidebar：Nav + 会话列表；active 行高亮；待响应卡。
- Main：messages + composer。
- RightRail：≥1280 真实列；<1280 drawer。
- 关闭：Sidebar 行菜单 + `Ctrl+W`；有草稿确认。

### 7.3 tools / oauth

- Sidebar：仅 Nav；active 对应项。
- Main：页面内容；单段滚动。
- RightRail：隐藏。
- TopBar：中格“工具”/“接入”；左格返回按钮（回消息）。

### 7.4 settings

- **MAY** 作为 Main 内页面，或覆盖 Main 的 overlay；无论哪种，**MUST NOT** 新增壳行/列。
- Sidebar：仅 Nav；设置 active。
- TopBar：中格“设置”；左格返回。
- RightRail：隐藏。

### 7.5 窄窗/抽屉

- <1280px：RightRail 变 drawer；触发按钮在 TopBar 右格（badge=待办数）；不自动打开。
- <800px：Sidebar 变 drawer；TopBar 左格菜单按钮；drawer 覆盖 Main，Esc/遮罩关闭；壳仍 2 行。
- 抽屉 **MUST** 有焦点管理（打开聚焦第一个可交互项，关闭回焦触发按钮）。
- 不允许在窄窗把 Nav 放到底部第 3 行（删除 `utilities.css:23-32` 的旧规则）。

---

## 8. 行为不变量（壳改造不得回退）

> 这些是上一轮分析中确认的“承诺/行为”问题。壳改造会触碰入口，必须一并定稿；数据层实现可另立任务。

### 8.1 新建会话（P0）

- Sidebar `+` 与 `Ctrl+T` **MUST** 都打开 Startup（`openStartup`），不得立即 `createSession` 产生空会话。
- 只有首条消息提交时才创建会话；失败保留草稿。
- 当前 `Ctrl+T` 走 `createSession()`（`R/app/App.tsx:305-309`），**MUST** 改为 `openStartup()`；旧 `createSession` 仅保留给显式“空会话”路径（如果产品仍需要）。

### 8.2 关闭会话与草稿（P0）

- Sidebar 行 `…` 菜单 **MUST** 提供“关闭会话”；`Ctrl+W` 同语义。
- 有非空草稿时 **MUST** 确认；确认后可以丢弃，但不得静默。
- `closeTab` 当前会 `delete drafts[seed]`（`R/tabs/store.ts:298-312`）；**MUST** 要么保留草稿到 localStorage 并在重开时恢复，要么在确认文案中明确“草稿将丢失”。

### 8.3 启动页状态（P1）

- 同一屏的 `draftText` / `selectedProfile` / `startupAttachments` / `newSessionCwd` **MUST** 有一致持久化策略：
  - 文本、profile、附件、cwd 至少跨页面导航保留；
  - 文本/profile/cwd **SHOULD** 跨重启保留（localStorage）；
  - 成功提交后清空。
- 当前 `draftText`/`selectedProfile` 是组件局部（`R/session/StartupView.tsx:65-66`），切页即丢；`emptyDraft` 是死代码（`R/app/App.tsx:95,402-410`）。**MUST** 收敛为一个 `startupDraft` store。

### 8.4 模型（P0/P1）

- 启动页/TopBar 的模型 chip **MUST** 显示“新会话/当前会话实际会用的解析结果”，不能只显示 `config.load` 的全局 profile/model 而忽略 `model-selection-default.json`（`E/main/ipc-handlers.ts:369-395`）。
- 模型 chip **MUST** 能打开 native picker（`model-picker:open`）；native picker 是 provider/model/effort 的完整入口。
- 不允许出现“屏幕显示 A、实际用 B”的两套真相；如果数据层暂未合并，至少 chip 要标注“全局配置”/“新会话默认”并显示两者差异。
- 模型 picker 主题 **MUST** 与主窗口一致（§5.6）。

### 8.5 权限（P1）

- TopBar/启动页 **MUST** 有只读权限 chip：`read-only` / `workspace-write` / `skip-permissions`。
- 点击 chip 打开 Settings > 权限档位；**MUST NOT** 做 per-session 切换（与 `R/composer/Composer.tsx:66-70` 的设计理由一致）。
- `skip-permissions` **MUST** 用 warn 色 + 文案提示；首次使用/切换时保留设置页的打字确认。
- 工具白名单/子代理范围 **SHOULD** 在权限 chip 的 tooltip 或设置页摘要中可见。

### 8.6 命名（P1）

- Sidebar header **MUST** 叫“会话”，不再叫“工作区”；计数是会话数。
- 工作区只用于分组/目录；RightRail **MUST** 叫“任务/待办”。
- 启动页 chip 叫“新会话目录”，显示可消歧路径；空工作区要么显示，要么明确“仅显示有会话的工作区”。
- 同一屏不出现两个都叫“工作区”的控件。

### 8.7 启动页层级（P2）

- TopBar 已显示产品名/会话标题，启动页 hero **MUST NOT** 再用 28px 产品名当主标题；改成“新会话”或直接省略。
- 作用域摘要（目录/模型/权限）**SHOULD** 是 14–16px 的一行，位于 composer 上方；composer 是最宽/最重的元素。
- 建议卡片保留但降级；点击仍只填入输入框，不直接执行。
- 辉光装饰 **SHOULD** 移除；空态留白用最近会话/项目摘要填充，而不是光晕。

---

## 9. 可访问性

- 窗口控制：`aria-label`、`focus-visible`、≥44×32 命中区；关闭按钮的“关闭到托盘”语义写进 label/title。
- TopBar `⋯` 菜单：`aria-haspopup="menu"`、`aria-expanded`、Escape 关闭并回焦、方向键导航。
- Sidebar Nav：`aria-current="page"`；2×2 项的 tab 顺序按视觉顺序；active 不能只靠颜色（同时有背景/字重）。
- 会话列表：active `aria-current`；待响应卡的 `aria-label` 保留；`…` 菜单键盘可达。
- Drag 区域：不可聚焦、不拦截键盘；所有交互元素 `no-drag`。
- 抽屉：焦点陷阱 + 关闭回焦；`aria-modal`（如果遮罩）；Esc 关闭。
- `prefers-reduced-motion`：抽屉/边框/主题过渡降级；`forced-colors` 下边框仍可见。
- 字号：Nav label 12–13px，计数/提示 ≥11px 且乘 `--font-scale`；不要再用 10px 硬编码（§8.7 的字体 token 收口）。

---

## 10. 性能

- 壳表面 **MUST** 不透明；移除 TopBar/Sidebar/RightRail 的 `backdrop-filter`（玻璃只留给临时抽屉/浮层）。
- `#app` grid 固定 2 行；pane 内部滚动；不要因抽屉开合改变壳行数。
- `@container` 挂在 `#main`；`ResizeObserver` 只观察 Main/App，组件卸载时 disconnect。
- 右栏开合只改 `--rail-width` / `display`，不重建 Main；保持 `WorkspacePanel` 的 `store.todos` 订阅。
- TopBar 不订阅流式消息树；会话标题只订阅 `title`/`catalog` 的窄信号，避免每帧重算。
- 主题切换只过渡壳表面，不触发消息树重排（沿用现有 `theme-transition` 思路）。
- 窗口最大化/还原只改外框 radius/shadow，不重挂 pane。

---

## 11. 迁移计划

| 阶段 | 内容 | 退出条件 | 回退 |
|---|---|---|---|
| 0. Spike | `frame:false` + TopBar 拖拽 + 自绘控制 + 边缘缩放，X11/Wayland/Windows 实测 | 记录每个平台的拖拽/缩放/最大化/圆角结果；选定 A/B/C 回退 | 不改生产 |
| 1. 菜单迁移 | TopBar `⋯` + `modelPicker.open` + `Ctrl+Shift+M` + 关于/退出/设置 | 所有 native menu 动作可从 TopBar/tray 触达；快捷键可用 | 保留 native menu |
| 2. 拆嵌套 grid | `WorkspacePanel` 移到 `#app` 第三列；`.session-column` 拍平；`#app` 2×3 | 无第 4 列；≥1280 右栏真实列；截图通过 | 保留旧 `.session-column` 分支 |
| 3. 合并 nav/sidebar | 新 `Sidebar`：Nav 2×2 + 会话列表；删 64px rail；宽度 token 化 | 无 64px rail；非消息页只留 Nav；800–1279 2 列 | 恢复 GlobalNav |
| 4. TopBar + SessionHeader | 删 `#top`；`SessionHeader` 移入 TopBar；frameless + 自绘边框/控制 | 壳 2 行；窗口可拖/缩放/最大化/关闭到托盘；无 native menu | 回退 §5.7 方案 2/3 |
| 5. 响应式/视觉 | 断点、抽屉、TopBar 收窄、实底、1px 边框、12–13px label、启动页 hero 降级 | 1920/1280/800 截图；无横向滚动；a11y 检查 | 按阶段回退 |
| 6. 行为不变量 | Ctrl+T→Startup、Sidebar 关闭、startupDraft、模型/权限 chip（按 §8 范围） | 验收清单 §12 行为项通过 | 独立 feature flag |

- 阶段 2–4 应可独立合并；如果阶段 0 的 frameless 缩放失败，阶段 2/3 仍可落地，阶段 4 走回退 2/3。
- 每阶段更新 `HANDOFF.md` 的“已完成/未验证”，不要把未做的 GUI 验收写成完成。

---

## 12. 验收

### 12.1 布局

- [ ] `getComputedStyle(#app).gridTemplateRows` 恰好 2 条 track。
- [ ] ≥1280px：`gridTemplateColumns` 恰好 3 条；800–1279：2 条；<800：1 条（抽屉不计）。
- [ ] `#app` 直接子元素只有 `#topbar`、`#sidebar`、`#main`、`#right-rail`；无 `#top`。
- [ ] `.workspace`/`.session-column` 不再产生可见列。
- [ ] 会话页 Main 只有 messages + composer；无 40px `SessionHeader` 行。
- [ ] 1920×1080、1280×800、800×600 截图：无横向滚动、无第 4 列、TopBar 48px、Sidebar 288、RightRail 320/0。
- [ ] 每个 pane ≤2 段；抽屉不计列。

### 12.2 窗口/边框

- [ ] Linux/Windows 窗口内无 native title bar / application menu bar。
- [ ] `#app` 外框 1px 在 light/dark 下可见；Pane 分隔线可见。
- [ ] 拖拽 TopBar 移动窗口；双击空白最大化/还原；标题双击重命名不冲突。
- [ ] 最小化/最大化/还原/关闭按钮可用；关闭 = 隐藏到 tray；`⋯` → 退出… = 退出确认。
- [ ] 边缘/角落缩放可用（按阶段 0 结论）；最大化后无圆角裁切/黑角。
- [ ] `transparent` 不可用时方角实底，无黑角。
- [ ] 模型 picker 主题与主窗口一致。

### 12.3 菜单/快捷键

- [ ] `⋯` 菜单包含模型两项、设置、关于、退出；键盘可达。
- [ ] `Ctrl+Shift+M` 打开模型 picker；`Ctrl+,` 设置；`Ctrl+Q` 退出确认。
- [ ] tray 菜单仍可用（打开/模型/退出）。
- [ ] 移除 native menu 后无动作丢失。

### 12.4 行为

- [ ] Sidebar `+` 与 `Ctrl+T` 都打开 Startup；首条消息前不产生空会话。
- [ ] Sidebar 行菜单与 `Ctrl+W` 都能关闭会话；有草稿时确认；无静默丢失。
- [ ] 启动页文本/profile/附件/cwd 跨页面导航保留；成功提交后清空。
- [ ] 模型 chip 显示解析后的新会话/当前会话值；点击打开 native picker。
- [ ] 权限 chip 只读，点击跳设置；无 per-session 切换；skip-permissions 有 warn。
- [ ] 命名：Sidebar“会话”、分组“工作区”、RightRail“任务”；无两个“工作区”控件。
- [ ] 启动页 hero 不再用产品名当主标题；composer 是最宽/最重元素。

### 12.5 A11y/性能

- [ ] 键盘可完成：打开 Nav、切会话、打开 `⋯`、开合抽屉、关闭窗口。
- [ ] 窗口控制/菜单/抽屉有 label、focus ring、Esc/回焦。
- [ ] `prefers-reduced-motion`/`forced-colors` 下可用。
- [ ] 壳表面无 backdrop-filter；流式消息时 TopBar/Sidebar 不重算。
- [ ] 抽屉/右栏开合不重挂 Main；无 ResizeObserver 泄漏。

### 12.6 测试

- 如已有 visual capture 脚本（`visual-capture.mjs` 被 SettingsView 引用），增加 1920/1280/800 三档截图与 `#app` grid 断言。
- Electron IPC 测试增加 window control / `model-picker:open` 的 sender 校验与失败路径。
- 不把单元/编译测试当作 GUI 验收；在隔离数据目录跑真实 Electron + daemon 冒烟（参考 `HANDOFF.md` 下一步 2）。

---

## 13. 风险与开放问题

### 13.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Linux/Wayland frameless 边缘缩放不可用 | 窗口拉不动 | 阶段 0 spike；回退 §5.7 方案 2/3 |
| 删 native menu 丢动作/快捷键 | 模型/退出不可达 | 阶段 1 先迁移；验收 §12.3 |
| 关闭按钮语义与用户预期不符 | 以为退出实际进 tray | label/title 写明“关闭到托盘”；`⋯` 提供退出 |
| TopBar 标题双击重命名 vs 双击最大化 | 交互冲突 | 标题文本 no-drag 双击重命名；空白区拖拽/最大化 |
| 800px 下 2 列仍偏挤 | Main 512px | Sidebar 可降 240；RightRail 抽屉；内容列自适应 |
| `#top` 被主题/性能 CSS 大量引用 | 样式静默失效 | 全仓 grep `#top`，同步清理 `themes/*`、`performance.css`、`utilities.css` |
| 容器查询仍挂旧 `.workspace-content` | 卡片/composer 断点错误 | 迁到 `#main`；截图验证 |
| 模型 picker 深色硬编码 | 浅色用户刺眼 | 传主题/改 renderer 路由 |
| `WorkspacePanel` 量错容器 | 右栏开合逻辑错误 | 改量 `#main`；重标 `NARROW_RAIL_MAX` |
| 抽屉焦点/滚动穿透 | 键盘/触控不可用 | 焦点陷阱、Esc、`inert` 背景 |

### 13.2 开放问题（评审需拍板）

1. **“垂直 2”是否包含 `SessionHeader`？** 本 spec 采用严格口径（包含），因此移入 TopBar。若只算窗口 chrome，可保留 40px header，阶段 4 简化。
2. **圆角/透明是否必须？** 本 spec 默认方角实底 + 1px 边框；圆角是可选。若必须圆角，需要确认 Linux/Wayland 合成器支持与黑角回退。
3. **Linux/Wayland 回退是否接受 native frame + 内部边框？** 本 spec 接受（§5.7 方案 3），但“窗口外框自绘”会降级为“内部边框自绘”。
4. **关闭按钮是隐藏到 tray 还是退出？** 本 spec 保持现状（隐藏到 tray），退出走 `⋯`。若产品要求关闭即退出，需要改 `mainWindow.on("close")` 与文案。
5. **800–1279px 的 RightRail 用 drawer 还是 40px 列？** 本 spec 选 drawer，避免 Main 被挤到 <672；若坚持 3 列，可改成 40px 列，但 Main 更窄。
6. **Sidebar Nav 用 2×2 还是竖排？** 本 spec 推荐 2×2（省高度、label 可读）；竖排更传统但占 4×44px。
7. **TopBar 是否同时放模型 + 权限两个 chip？** 本 spec 推荐 ≥1280 放两个，窄窗收成图标；若太挤，权限只放启动页 scope summary。
8. **启动页建议卡片保留几张？** 本 spec 保留 4 张但降级；若 Main 在 1280 只有 672px，建议 2×2。

---

## 14. 代码触点

| 文件 | 现状 | 目标 |
|---|---|---|
| `E/main/index.ts` | native frame、application menu、`backgroundColor:#18181b` | `frame:false`、自绘控制 IPC、移除/隐藏 menu、主题背景 |
| `E/preload/index.ts` | `modelPicker.load/save` | 增加 `modelPicker.open`、`windowControls` |
| `E/main/ipc-handlers.ts` | `model-picker:open` 已存在 | 暴露给 preload；加 window control sender 校验 |
| `E/main/model-picker.ts` | 硬编码深色 | 主题化（query/nativeTheme） |
| `R/app/App.tsx` | `#top` + `.workspace` + `.session-column` 嵌套 | 新 `#app` 2×3；TopBar/Sidebar/Main/RightRail 直接子元素；Ctrl+T→Startup、Ctrl+W→关闭、Ctrl+Shift+M→picker、Ctrl+Q→quit |
| `R/lib/desktop-host.ts` | `DesktopHostBridge.modelPicker.load/save` | 增加 `modelPicker.open` 与 `windowControls` 类型 |
| `R/app/GlobalNav.tsx` | 64px 竖排 rail | 合并进 `Sidebar` 的 Nav 2×2（可保留组件，改布局） |
| `R/app/MessageSidebar.tsx` | 244px 会话侧栏 | 288px `Sidebar` 的会话段；header 改“会话”；加关闭会话 |
| `R/session/SessionHeader.tsx` | `#session` 40px header | 移入 TopBar 中格；保留重命名/复制菜单 |
| `R/session/SessionView.tsx` | 渲染 `SessionHeader` + messages | 去掉 header 行；messages 从 body 顶部开始 |
| `R/workspace/WorkspacePanel.tsx` | `.session-column` 第二列 | `#app` 第三列；量 `#main`；改名“任务” |
| `R/styles/shell/layout.css` | `#app` 2×2 + `.workspace` 嵌套 | 新 2×3；删 `#top`/`.workspace` 列轨 |
| `R/styles/components/timeline.css` | `.session-column` 2 列、`#session` 3 行 | 单列；`#session` 2 行 |
| `R/styles/shell/sidebar.css` | 64px global-nav + message-sidebar 视觉 | 288px Sidebar；Nav 2×2；会话列表 |
| `R/styles/components/workspace-panel.css` | 右栏 320/40 | 第三列/drawer；header 改“任务” |
| `R/styles/utilities.css` | ≤720px 底部 nav 第 3 行 | 删除；改 drawer；断点按 §4.6 |
| `R/styles/themes/*`、`performance.css` | 引用 `#top` | 同步清理/替换 |
| `R/styles/tokens/base.css` | `--content-width:760` | 增加 `--topbar-height/sidebar-width/rail-width/window-*` |
| `R/scripts/visual-capture.mjs` | 已有截图钩子 | 增加 1920/1280/800 + grid 断言 |
| `E/scripts/*.test.mjs` | IPC/打包测试 | 增加 window control/model-picker open 回归 |

---

## 15. 附录

### 15.1 当前 vs 目标

```
当前：
rows = native title + app menu + #top + body        (4)
cols = nav 64 + sidebar 244 + main + rail 320       (4)

目标：
rows = TopBar 48 + body                             (2)
cols = Sidebar 288 + main + rail 320/0              (3)
```

### 15.2 组件树

```
#app
├─ TopBar
│  ├─ Brand/Back
│  ├─ SessionTitle (SessionHeader logic)
│  └─ ModelChip + PermissionChip + Status + Overflow + WindowControls
├─ Sidebar
│  ├─ Nav (2×2)
│  └─ SessionList (header + groups)
├─ Main
│  ├─ SessionView (messages)
│  └─ Composer
├─ RightRail
│  ├─ Header (任务 + count + collapse)
│  └─ TodoList
└─ #overlays (fixed/absolute; toast/context menu/quit/diff; not a shell row/column)
```

### 15.3 层数审计

```js
const app = document.querySelector('#app');
const rows = getComputedStyle(app).gridTemplateRows.split(' ').filter(Boolean);
const cols = getComputedStyle(app).gridTemplateColumns.split(' ').filter(Boolean);
console.assert(rows.length === 2, 'shell rows must be 2', rows);
console.assert(cols.length <= 3, 'shell cols must be <= 3', cols);
console.assert(document.querySelector('#top') == null, '#top must be removed');
const shellIds = new Set(['topbar', 'sidebar', 'main', 'right-rail']);
const inFlow = [...app.children].filter((el) => {
  const position = getComputedStyle(el).position;
  return position !== 'fixed' && position !== 'absolute';
});
console.assert(
  inFlow.every((el) => shellIds.has(el.id)),
  'only in-flow shell children allowed',
  inFlow.map((el) => el.id)
);
```

开发期可加临时 overlay：

```css
html[data-shell-debug] #app > * { outline: 1px dashed color-mix(in srgb, red 60%, transparent); }
```

### 15.4 窗口控制 IPC 草图

```ts
// main
ipcMain.handle("window:control", (event, action: "minimize" | "toggle-maximize" | "close") => {
  if (!isTrustedRenderer(event.senderFrame?.url ?? "")) throw new Error("untrusted");
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win == null) return;
  if (action === "minimize") win.minimize();
  else if (action === "toggle-maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
  else win.close(); // close handler hides to tray
});

// preload
window.qaqhHost.windowControls = {
  minimize: () => ipcRenderer.invoke("window:control", "minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:control", "toggle-maximize"),
  close: () => ipcRenderer.invoke("window:control", "close"),
  onMaximized: (cb) => ipcRenderer.on("window://maximized", (_e, v) => cb(v)),
};
```

- `window:control` 的 sender 校验必须与 `qaqh:invoke` 同级；不能接受 picker 窗口或任意 frame。
- `close` 走 `win.close()`，由 `mainWindow.on("close")` 决定隐藏到 tray；不要直接 `app.quit()`。

### 15.5 评审记录（待填）

| 日期 | 结论 | 决策人 |
|---|---|---|
|  |  |  |

---

**变更记录**

- 2026-10-27 v0.1：初稿；基于当前 4×4 壳与 `#top`/menu/`SessionHeader` 分析，定义 2×3、自绘边框、断点、迁移阶段与验收。
