# WinUI 动效复刻 Batch-2 规格书（win-motion 套件）

- 状态：待排期（用户拍板批次拆分后启动）
- 前置：Batch-1 已入库（`51eea3e`——运动 token、ContentDialog 入场、flyout/列表入场）
- 一手来源：`microsoft/microsoft-ui-xaml`（MIT）源码已缓存 `.tmp/winui-src/`；
  本文所有参数均从源文件/官方文档实测提取，行号见 §4 参数登记表。

## 0. 目标与非目标

**目标**
1. 补齐"退场相"——Batch-1 只有入场能骗过眼睛，退场必须同样逐帧可信；
2. 会话列表重排（archive/delete/move）的 FLIP 驱动，按官方
   `DefaultItemCollectionTransitionProvider` 语义复刻；
3. 三个高辨识度微交互：ToggleSwitch 挤压滑钮、ScrollBar reveal、back button 两段式入场；
4. 强弹性入场曲线以 `linear()` 落库，供"审批到达"这类存在感动效使用；
5. 用微软自己的 `*_perf2026.xaml` 审计并重写我们的低配禁用清单。

**非目标（结论性排除，勿再议）**
- ❌ wasm/Rust 做动画计算：DOM 微交互的瓶颈在 layout/paint 不在解算；
  cubic-bezier/FLIP 的 JS 成本是微秒级，wasm 只增边界序列化与体积。
  Rust 在本仓的正确战场是已有的 napi 协议栈。
- ❌ Houdini Animation Worklet：从未进入 stable（MDN 无条目、WICG 仓库 404），不为它设计。
- ❌ Reveal hover：微软自己在 WinUI 3 已砍，复刻它是刻错年代。
- ❌ Fluent 2 web（fd2）：面向 M365 的另一套运动 ladder，非 Windows 11 XAML 观感；
  本仓走 generic.xaml 系谱（见 `docs` 讨论与 Batch-1 注释）。

## 1. First-Design 参考（四个已验证存在的仓库）

| 仓库 | 取什么 | 用在哪 |
|---|---|---|
| `argyleink/gui-challenges` (Chrome 团队) | dialog 退场的 class 编排与 `transitionrun/cancel` 防双播；FLIP 列表实现；view-transition 配方 | M1 骨架、M2 驱动器 |
| `microsoft/fluentui-blazor` (MIT) | "XAML→CSS"翻译层的组织法：token 命名、visual-state→pseudo-class 映射 | 全局分层参考 |
| `motion-canvas/motion-canvas` (MIT) | 编排 API 形态（`sequence()`/spring DSL/关键帧命名） | `win-motion.ts` 的 TS API 形状 |
| `microsoft/WinUI-Gallery` | 验收基准：录屏逐帧对时；无源码参数时的回填 | §5 验收协议 |

工作方式固定为一条**复刻流水线**：读 XAML 源 → 填参数登记表 → 写 CSS/WAAPI →
Gallery 录屏逐帧验收（±1 帧容差）。缺参数只允许两种补法：读主模板源文件，或录屏测帧。

## 2. 里程碑

### M1 `win-motion.ts` —— 退场 hook（前置工程，其余全部依赖它）
- API：`playExit(el, { state: 'is-closing' }) => Promise<void>`；挂 `is-closing` 类、
  监听 `transitionend`（多属性取 `transitionrun` 计数与 `cancel` 冲抵），超时兜底
  = 声明时长 + 50ms；完成后调用方卸载。
- 改造点：`App.tsx` 退出弹窗 `<Show>`、`ui/toast.tsx` 队列、`ContextMenu` 卸载、
  `approval-slot` 折叠。**时间线不动**（frame-budgeted reveal 已在管，避免双播）。
- 退场参数（Batch-1 公式的反放，源码 VisualTransition To=DialogHidden）：
  - dialog：`scale 1→1.05` over `--dur`(167) `--ease-outslowin`；opacity 83ms linear 先行；
  - overlay：83ms linear；
  - toast：`translateY 0→-6px` + 83ms fade（"退场必配淡出"铁律）。
- 门闸：reduced-motion / lite 下直接跳过退场（resolve 立即）。

### M2 `win-flip.ts` —— 列表重排驱动器
- 官方语义（DefaultItemCollectionTransitionProvider.cs 全文在手）：
  Add=300ms 纯 opacity；Move=300ms offset（from 旧位 delta）；
  混合操作时新项淡入用 50%（或 66% 三操作并发）hold 关键帧让位先行。
- 实现：测量 `getBoundingClientRect` → WAAPI `animate([{transform: delta},{transform:'none'}])`
  `easing: var(--ease-point)`（0.55,0.55,0,1 即官方 point-to-point）duration 300ms；
  删除行先 fade 300ms 后摘 DOM 并让余下行走 FLIP——即 M1 的退场 hook 复用。
- 接入：`MessageSidebar` 归档/删除/重命名排序/工作区移入；`settings` 分区导航不做。
- 与 auto-animate 划界：composer 附件区保持 `@formkit/auto-animate`，
  二者不得同帧驱动同一容器（flip 注册表按容器 id 互斥）。

### M3 微交互三连
1. **ToggleSwitch**（源：`dev/CommonStyles/ToggleSwitch_themeresources.xaml`）
   - 按压滑钮挤压到 12×12 over 83ms `--ease-outslowin`（L231-236）；
   - 行程 20px（KnobTranslate X，L445）；滑动跟手（ManipulationMode TranslateX，L197）；
   - 待提取：滑动途中滑钮"拉宽 40→弹回 20"的果冻段——在
     `dev/ToggleSwitch/ToggleSwitch.xaml` 主模板（未拉，实施时补读）；
   - 落点：Kobalte Switch 的 windows 覆盖层（providers/settings 页所有开关）。
2. **ScrollBar reveal**（源：`ScrollBar_themeresources.xaml`）
   - 轨道 12px、thumb 最小宽 8px、透明度变化 83ms、展开动画 167ms、悬停 400ms 后展开；
   - CSS 现实：`::-webkit-scrollbar` 伪元素不可过渡 width →
     决策：先落"即时 8→12px 展宽 + 83ms opacity"两态（无 167 补间），
     若观感不达标，升格为 JS 叠层滚动条（工作量 ×3，单独评审，默认不做）。
3. **NavigationBackButton 两段式**（尺寸 40×36 已确认；动画在
   `dev/NavigationView/NavigationBackButton.xaml` 主模板，实施时先读）
   - 落点：`.titlebar-back` 与 `.titlebar-menu` 的出现时机（有历史栈才入场）。
4. **强弹性入场 `linear()`**（总表 3 关键帧，667ms 合成：
   cubic(0.85,0,0,1)@167 + cubic(0.85,0,0.75,1)@167 + cubic(0.85,0,0,1)@333）
   - 生成 32–48 采样点的 `linear()` 字符串存为 `--ease-elastic-in`，
     应用于审批新卡（`approval-pop` 的 windows 变体）与"高优先级 toast"。

### M4 perf2026 审计
- 拉全部 `controls/dev/**/*_perf2026.xaml`，与非 perf 版逐文件 diff；
- 产物一张表：**微软官方认定的"该停用的动画清单"** → 重写 `performance.css`
  的禁用选择器；
- 修正 Batch-1 遗留问题：perf-low 下 `#top/.message-sidebar` 不再实色化盖死 Mica
  （Mica 由 DWM 合成，零应用侧成本；实色化只保留给 lite 预设）。

## 3. 全局约束（所有里程碑共同遵守）
- 一切新观感代码放 windows 作用域（`html[data-platform="windows"]` 或 fluent.css
  motion 段），macOS/liquid-glass/zen 预设零变化；
- 合成器安全：动画属性只允许 `transform/opacity`（滚动条妥协方案除外）；
- 时长/曲线一律引用 `--dur-*` / `--ease-*` token，禁止字面量散落；
- 三闸门：`prefers-reduced-motion`（utilities 全局）、lite（零动效清单——新类必进）、
  `perf-mode-low`（M4 重写后以官方清单为准）；
- 无新 npm/crate 依赖；不引入 wasm；
- 每个模块：1 个 vitest（happy-dom + fake timers：is-closing 生命周期、FLIP delta
  计算、超时兜底）+ 1 个 cv-check 风格截图夹具（沿用 `webui/*.html` 检查页惯例）。

## 4. 参数登记表（已核实；行号对应 `.tmp/winui-src/` 缓存）

| 配方 | 值 | 来源 | 应用于 |
|---|---|---|---|
| dialog 入场 | scale 1.05→1.0 @250ms (0.1,0.9,0.2,1)；fade 83 linear | ContentDialog_themeresources.xaml L96-114 | 退出弹窗（Batch-1 已上） |
| dialog 退场 | scale 1.0→1.05 @167ms 同曲线；fade 83 linear | 同上 L73-95 | M1 |
| 列表淡入 | 300ms opacity-only；Add/Move 混合 hold @50%/66% | DefaultItemCollectionTransitionProvider.cs | M1/M2 |
| point-to-point | cubic-bezier(0.55,0.55,0,1)，167/250/333 | Motion in Windows 总表 | M2 |
| gentle out | cubic-bezier(1,0,1,1) @167 | 同上 | 退场位移 |
| fade 档 | 83ms linear（faster） | 同上 + ControlFasterAnimationDuration | 全部淡变 |
| switch 按压 | 滑钮 12×12 @83ms (0.1,0.9,0.2,1) | ToggleSwitch_themeresources.xaml L231-236 | M3.1 |
| switch 行程 | X=20px | 同上 L445 | M3.1 |
| scrollbar | 轨道 12 / thumb 8 / fade 83 / expand 167 / 悬停 400 后展开 | ScrollBar_themeresources.xaml L173-188 | M3.2 |
| back button | 40×36；入场动画 ⚠ 待读主模板 | NavigationBackButton_themeresources.xaml | M3.3 |
| 强弹性 | (0.85,0,0,1)/167 → (0.85,0,0.75,1)/167 → (0.85,0,0,1)/333 | Motion in Windows 总表 | M3.4 |

## 5. 验收协议
- 每项以 WinUI-Gallery 对应页录屏为基准，逐帧对比：时长 ±1 帧（16.7ms）、
  终帧几何一致、曲线拐点目检无反相；
- 性能红线：动效期间主线程无强制 layout（DevTools Performance 断言
  `Recalculate style` 不随帧出现——transform/opacity 只在合成线程）；
- 60Hz 下连续 3 次触发无掉帧 >2；
- 回归：`just check` 全绿 + 三预设（default/lite/zen）截图夹具 diff 仅 windows 层变化。

## 6. 排期建议
- M1 → M2 → M3（三小项可拆三 PR）→ M4，各一个 PR、按序依赖（M2 用 M1 的退场 hook）；
- 实施第一天先读两份主模板（ToggleSwitch.xaml / NavigationBackButton.xaml），
  把 ⚠ 参数补齐进 §4；
- 预估：M1 半天、M2 一天、M3 每项半天、M4 半天（纯审计）。
