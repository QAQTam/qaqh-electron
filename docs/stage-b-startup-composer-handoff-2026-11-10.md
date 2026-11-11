# 阶段B(启动页 = 共用 Composer + 预检态)交接

日期:2026-11-10。基线 `HEAD = eb3f31c`(阶段A/inherit 那笔已提交,见该 commit message)。
本轮改动**全部未提交**,且工作树里混着**另一路并行的「回合插话/交接」工作**(见 §4)——
给下一个执行环境:先等对方落定,再复验、单笔提交阶段B。

## 1. 状态摘要

| 项 | 状态 |
| --- | --- |
| B-2 `Composer.sending?()`(busy 转 loader,不走 running→停止) | ✅ 落地并验 |
| B-3 `startupPreflight` 信号(`tabs/store`,落 localStorage)+ 两卡本地读写口 | ✅ 落地并验 |
| B-4 `submitStartupSession` 组装 `model_selection(+options)/tool_mode/custom_tools`;删「请先选择服务商和模型」硬闸 | ✅ 落地并验 |
| B-5 启动页附件 `string[]` → `PendingAttachment[]` | ✅ 落地并验 |
| B-6 StartupView 手搓输入区删除,渲染共用 `Composer` | ✅ 落地并验 |
| WebUI `pnpm run test`(85 文件 / 506 例) | ✅ 全绿(19:22 实测,已含对方中间态) |
| 根包 `pnpm typecheck` / `pnpm test`(69 例) | ✅ 全绿 |
| 新视觉场景 `startup-composer-shared` | ✅ 端到端通过并出图 |
| WebUI `pnpm run typecheck` | ⚠ **红 16 处,全部来自并行 handoff/插话文件**,阶段B 文件零报错(清单见 §4) |

## 2. 本轮改了什么(提交范围 = 下面这 10 个文件)

| 文件 | 改动 |
| --- | --- |
| `webui/src/composer/startup-preflight.ts` | **新增**。预检态纯函数判合:`normalizePreflight`(坏 JSON 塌回 `EMPTY_PREFLIGHT`,空形返回唯一权威引用)、`writePreflightModel/Effort/MaxTokens/ToolMode`、`preflightCreateArgs`、`readPreflight/writePreflight`(key `qaqh.startup.preflight`;空预检不落存)。语义写死在文件头:换模型清叶子(resolver 会 400 拒跨模型档位,§3 事实)、无整对设叶子=以存档默认对为底(与会话页 `setSessionModel` 的补偿同规)、custom 空白名单在写口挡下(`params.rs:21-23`) |
| `webui/src/tabs/store.ts` | `startupPreflight` 信号 + `setStartupPreflight`(落存);`startupAttachments` 升 `PendingAttachment[]`(键=路径、恒 `ready`、`reference=null`,发送时才上传);`CreateSessionOptions.toolMode/customTools` 与 `session.create` 两字段;`StartupSubmitOptions.modelSelection` 改可选、`attachmentPaths`→`attachments` |
| `webui/src/composer/Composer.tsx` | 新 prop `sending?: () => boolean`:发送钮 `IconLoader.icon-spin`、disabled、`submit()` 早退;注释写明**不得**用 `running` 顶替 |
| `webui/src/session/StartupView.tsx` | 手搓输入区(textarea/chips/工具条/发送钮)整段删除,渲染 `Composer`(预检读写口 7 个闭包注入);配置条保留但接同一预检信号(下拉选整对清叶子;新增「跟随存档默认」清除项);`handleSubmit` 删硬闸,预检 null=省略 `model_selection` |
| `webui/src/session/store.ts` | `attachmentName` 改为导出(**仅此一行**) |
| `webui/scripts/visual-capture.mjs` | 新探针 `startupComposer`(结构四断言 + 真点开强度卡)+ 新场景 `startup-composer-shared`(`ready` 指 `.startup-composer-box #composer .composer-surface`) |
| `webui/src/stress.tsx` | `view=startup` 夹具支:`startupMode` 信号、messages 分支/WorkspacePanel 互斥门、泵早退并喂 `refreshWorkspaces/setNewSessionCwd/stageStartupAttachments`(演示仓库路径) |
| `webui/tests/startup-preflight.test.ts` | **新增** 8 例(判合/组装/落存往返) |
| `webui/tests/composer-sending.test.ts` | **新增** 3 例(sending 门与钮形;happy-dom + dev 构建双 mock,见下 §5 陷阱 1) |
| `webui/tests/startup-send-batch.test.ts` | **新增** 3 例(chip 形状/去重、`session.create` 载荷含 `tool_mode/custom_tools`、老调用形兼容) |

## 3. 后端事实(本轮新核,勿重挖)

- `session.create` 入参含 `tool_mode/custom_tools`(`crates/qaqh-runtime/src/service/handlers/session.rs:158-185`);`optional_tool_mode`:**省略或空串 = 未指定**(列空 = standard 零迁移,`service/params.rs:13-19`);`custom` 空白名单 → Err(`:21-23`)。所以组装规则:`""`/`standard` 都不发。
- `model_selection: null` → 回落 `default_model_selection`,无默认才报「请先在电脑端设置默认服务商和模型」(`session.rs:173-176`)。硬闸删掉是安全的:错在该出声的地方(创建失败)才出声。
- `RingingCommand`(前端镜像 `webui/src/api/qaqh/RingingCommand.ts:13`)已含全部字段——**未动契约**,LTS 冻结纪律不涉及。

## 4. 与并行工作的混占(提交前必须先解)

另一路「回合插话/交接」工作正在进行(19:31 仍在写文件),与本批**重叠的文件**:
`tabs/store.ts`(对方加 `handoff-journal` 导入与 `onHandoffDetected` 挂钩)、
`session/store.ts`(对方加 `HandoffFact` 面)、`stress.tsx`(对方插话夹具)、
`Composer.tsx`/`StartupView.tsx`(暂未见对方改动,提交前用 `git diff` 复核)。

当前 typecheck 的 16 处红**全部**属于对方:`session/handoff-journal.ts`(蛇形/驼峰混用)、
`session/store.ts`(缺 `HandoffFact` 导入、两个未读私有字段)、`stress.tsx:630` 与
`turn/segments.ts:13-14`(`InterjectionStep.endedAt`)。新文件 `session/handoff.ts`、
`turn/interjection.ts`、`session/handoff-journal.ts` 也是对方的。
**判别式:对方提交后(工作树里上述文件不再 modified),复跑 typecheck——那时应当全绿;若仍红,报错定位应全在本批 10 文件内,先修再提。**

## 5. 陷阱(本轮实测)

1. happy-dom UI 用例仍需双 dev mock(`solid-js`/`@solidjs/web` 指 dev 构建),同阶段A文档 §5.1。
2. `Composer` 的 `sending` 钮断言吃的是 `button.send` 上的 `.icon-spin`——IconLoader 的 class 透传是这条断言的锚,改图标实现要连查。
3. 视觉探针里的 evaluate 表达式是**模板字符串**,`new Promise(...)` 后面多打一对 `()` 会得到
   `TypeError: (intermediate value) is not a function`(本轮真实踩过;`Runtime.evaluate` 原样发送,本地
   `node -e "eval(expr)"` 可先复现再上浏览器)。
4. 预检落存的空形约定:空预检 = `removeItem`,读出必是 `EMPTY_PREFLIGHT` 同一引用——测试 `toBe` 吃这条。
5. 启动页 Composer 的 `onStop` 是空函数:没有会话就没有回合,`running` 恒 false 时「停止」分支根本不渲染。别拿它接真实取消。

## 6. 复验命令(对方落定后)

```powershell
cd D:/Projects/qaqh-electron/webui
pnpm run typecheck                     # 期望 0 错
pnpm run test                          # 期望 85 文件 / 506 例全绿(对方若加了用例以全绿为准)
cd D:/Projects/qaqh-electron
pnpm typecheck; pnpm test              # 根包 69 例
# 视觉(dev server 若未起:pnpm exec vite --host 127.0.0.1 --port 5173)
cd webui
$env:QAQH_VISUAL_FILTER="startup-composer-shared|sidebar-workspace-create"; pnpm exec node scripts/visual-capture.mjs
```

关键断言值(实测):startup 场景日志 `startup composer ok {"model":"qaqh-visual-preview","track":true}`;
截图应见配置条两钮(演示仓库 / 跟随存档默认 · Preview · Visual Preview)、强度卡展开(三档轨道、
`本会话 · 模型跟随存档 · 强度跟随模型默认` note)、附件 chip `visual-fixture.md`、发送钮为箭头非停止。

## 7. 提交与后续

1. 单笔(沿用阶段A的「全部一笔」裁定,除非另行指示):
   `git add` §2 表内 10 个路径(不含对方文件!),提交前 `git diff --cached --stat` 核对无夹带。
   建议 subject:`feat(composer): startup page reuses shared Composer with preflight model/tool state`。
   body 必写:未选=省略 `model_selection` 由后端回落;custom 空名单挡在写口;`sending` 不走停止路径;
   预检落存 key `qaqh.startup.preflight`;`startupAttachments.ready` = 已暂存待传,非「已上传」。
2. 提交后即进 **阶段C**(provider/model 目录并入 `EffortCard` 模型行、摘配置条那颗下拉与 composer
   profile chip——顺序纪律照原交接 §7:先合并、后摘 chip,§4.5/预检的「以存档默认为底」才是唯一退路)。
3. 原交接文档 `docs/workspace-new-session-handoff-2026-11-10.md` §7 的阶段B小节可视为已完成;
   其 §5.1-5.7 陷阱清单仍然全部有效。
