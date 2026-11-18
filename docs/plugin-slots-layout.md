# 插件槽位与窗口布局——可插入渲染面分析

> 状态:panel 槽已落地,其余为提案(ADR 前置分析)。本文盘点主窗口的全部布局区域,逐区评估
> 「是否适合开放给插件渲染」,并给出槽位契约的演进方向。

## 1. 现有槽位(已落地)

| 槽位 | 形态 | 消费面 | 能力门控 |
|---|---|---|---|
| `theme` | 纯 CSS 主题包,`<link>` 挂载 | 消息时间线视觉 | 无需 JS |
| `syntax-theme` | shiki 主题 JSON 对(light/dark) | diff 高亮 | 无 JS |
| `overlay` | 全屏 fixed 容器,插件自管层级 | 任意覆盖视觉 | 必须自兜 pointer-events |
| `dock` | 右下角插件坞:图标条 + 向上弹出渲染窗 | 快速工具(贪吃蛇/手柄映射/git 面板) | manifest 必带 icon;懒挂载常驻 |
| `panel` | 右栏工作区卡:与待办卡并列,容器随右栏开合 | 常驻信息卡(项目仪表盘) | manifest 必带 icon;契约与 dock 同构 |

dock 槽的契约(本次落地,后续槽位对齐此范式):
- manifest 必带 `icon`(emoji 文本或图标资产路径)+ `entry`;
- 插件只渲染**内容**进容器,不自管定位/层级/开关——容器归属宿主;
- `mount(container, host) → dispose`;容器不可见时插件自行挂起输入与轮询。

## 2. 窗口布局区域盘点与可插入性评估

```text
┌─ TopBar(WCO 自绘标题栏)────────────────────────────┐
├────────┬──────────────────────────────┬────────────┤
│ 左侧栏  │  会话时间线(TurnView)         │  右栏工作区  │
│ 会话列表 │   ├ 工具卡(StepRow/WorkGroup) │ (待办/goal/ │
│ (消息侧 │   ├ 正文段(AssistantContent)  │  handoff/   │
│  栏)    │   ├ WidgetMount(visualize)   │  插件卡?)   │
│         ├─ 输入区(composer)──────────────┤            │
│         ├─ 用户终端 dock(shell-dock)──────┤            │
├────────┴──────────────────────────────┴────────────┤
│ 插件坞(右下角,dock 槽)· Toast(右上)· overlay 层   │
└─────────────────────────────────────────────────────┘
```

| 区域 | 开放建议 | 槽位提案 | 理由与约束 |
|---|---|---|---|
| 时间线正文内联 | ✅ 已有事实标准 | `timeline-inline`(现状即 WidgetMount) | visualize 工具段已验证"宿主给容器、插件给内容"的模型;入口由**模型工具调用**驱动而非 manifest 静态声明,是和其他槽的本质差异 |
| 右栏工作区面板 | ✅ 已落地 | `panel`:manifest 声明 icon(name 即卡题),卡式渲染进右栏,与待办卡并列 | 容器归属明确、与 dock 同构(懒挂载+保状态);首个试点 qaqh-dashboard(git-status,零新 capability) |
| 插件坞(dock) | ✅ 已落地 | `dock` | 快速唤起类;面板尺寸/层级归宿主 |
| 用户终端 dock | ⚠️ 谨慎 | 暂不开放 | xterm 面板与数据面(ws 帧流)耦合深;开放需终端级 capability + 键盘焦点仲裁 |
| composer 输入区 | ⚠️ 谨慎 | `composer-attach`(工具按钮位) | 输入路径是核心链路;只开放"附加按钮"位,不开放输入面本身 |
| TopBar/标题栏 | ⚠️ 谨慎 | `titlebar-tray`(状态图标位) | WCO 区窗口控制归壳;只允许**只读状态图标**,交互点击转宿主事件 |
| 左侧栏(会话导航) | ❌ 不开放 | — | 核心导航;插件插入会破坏导航可靠性 |
| Toast 层 | ❌ 不开放 | — | 通知通道是壳的用户契约,开放即骚扰面 |
| overlay 全屏 | ✅ 已有(保留) | `overlay` | 限"纯视觉覆盖"(主题动效类);capability 审查从严 |

## 3. 横切纪律(所有槽位共同约束)

1. **容器归属宿主**:插件渲染进宿主给的容器,不自管 fixed 定位/层级/z-index——
   dock 迁移已确立此范式,overlay 是唯一例外(纯视觉覆盖语义)。
2. **capability 门控**:manifest.capabilities 决定 facade 键(gamepad-raw /
   git-status);新增区域必须先定义 capability 再开槽,不做"全知插件"。
3. **懒挂载 + 保状态**:面板类槽位首次使用才 mount,切走不 dispose;
   rev 失配即 teardown 重挂(热更语义不变)。
4. **不可见即挂起**:容器离 DOM(display:none)时插件应挂起输入/轮询
   (offsetParent 探测),后台态降频。
5. **偏好走唯一通道**:插件的开合/选择状态落 prefs.json(host.prefs),
   不自写 localStorage(迁移纪律同 webui 主体)。

## 4. 下一步(建议顺序)

1. ~~`panel` 槽~~:已落地(契约与 dock 同构;试点 qaqh-dashboard;stress 预览台
   `?plugins=1` 门控入画,真机冒烟走 stress 页 + playwright,一次性脚本未入库)。
2. 槽位注册表重构:loader 的 slot 分支(theme/syntax/overlay/dock/panel)收敛为
   槽位描述符表(slot → 容器策略 + 挂载时机),新槽位零改动接入。
3. `composer-attach` / `titlebar-tray`:等真实插件需求出现再立(避免
   无消费者的投机槽位)。
