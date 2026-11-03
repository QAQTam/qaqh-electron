# Electron / WebUI v3 客户端验证交接

日期:2026-11-04。本文记录在 [协议影响清单](./backend-v3-protocol-impact-2026-11-03.md) 第 8 节"尚未重验"状态之上的本轮续作:哪些已跑绿、改了什么、还剩什么。给下一个执行环境(人或工具)使用;命令与路径均为本机绝对事实。

## 1. 状态摘要

| 项 | 状态 |
| --- | --- |
| Electron main `npm run typecheck` / `npm test` | ✅ 通过(81/81) |
| WebUI `npm run typecheck` / `npm test` | ✅ 通过(440/440,64 文件) |
| `webui/scripts/layout-check.mjs` | ✅ 10/10 全 PASS(修复后完整跑通;确认稳定性的一次复跑被中断,未完成) |
| `webui/scripts/settings-check.mjs` | ✅ 11/11 PASS(需 `SETTINGS_URL=http://localhost:5173/settings-check.html`,见 §4) |
| `webui/scripts/oauth-shot.mjs` | ⬜ 本轮未重跑,待办 |
| backend B01–B09 | ⬜ 未动;backend 工作树保持只读干净(`b144398d`) |
| SDK 重新生成 / contract check | ⬜ 未动(上一轮通过记录见影响清单 §8.1,均早于本轮夹具修改) |
| 真机 daemon 验收 / 打包 | ⬜ 未动 |
| git 提交 | ⬜ 工作树约 300 个未提交文件;本会话未做任何 commit |

## 2. 本会话修改的文件(仅两处)

之前轮次遗留的未提交改动(约 300 文件)不在此列;以下为本会话为跑绿验证所做:

### 2.1 `webui/src/settings-check.tsx` — 三处夹具修复(真实 bug)

1. **`profile.list` 夹具形状过时**:夹具仍返回旧 snake_case 文档(`{provider, reasoning_effort, context_length}`),而 `settings/registry.ts` 本轮已切到 `ProfileSummaryDto` camelCase 摘要(按 `baseUrl` 对回 provider 目录、无 provider 指针)。后果:`readRegistry` 里 `summary.baseUrl` 为 undefined → provider 归属为空串 → `defaultProfile` 为 null → 引导遮罩(`onboarding-overlay`)常驻并挡住返回按钮 → layout-check `backVisible` 断言失败。修复:夹具 profiles 改为 `ProfileSummaryDto` 形状;`syncProbeProjection`、`profile.create`、`profile.delete`、`model.selection.set_default` 处理器同步适配(baseUrl 反查 providerId)。
2. **两个 provider 共用同一 `base_url`**:baseUrl 反查永远命中第一个 provider,fast 存档挂到 default-provider 下导致其模型不可解析、"设为默认"不发命令。修复:fast-provider 改用 `https://opencode.ai/zen/fast/v1`(摘要、旧目录、新目录三处同步)。
3. 其余夹具注释同步。

### 2.2 `webui/scripts/layout-check.mjs` — 一处夹具自愈(绕过应用层竞态)

**症状**:思考/推理场景间歇性失败(约 50%),事件(`__composerProbe.emit('projection://event', …)`)已发出但 store 无人接收。

**已定位根因(应用层,未修)**:`tabs/store.ts` 的 `activateTab` 把 `setActiveId` + **其它 store 的 `deactivate()`** 包在 `withViewTransition` 回调里;`platform: "electron"` 下走 `doc.startViewTransition`,回调被排到下一帧。headless Edge 帧节流使旧回调**迟到**,执行时把"刚激活的当前 store"也 `deactivate` 掉(订阅被拆)。证据链:失败时 dump 显示 emit 已执行(`eventSeqs[composer-4]=2` 恰为思考事件 seq 1,2)、`#messages` 存在但 timeline 全空;恢复性复跑(vite 冷启动/重开页面)时同一代码通过。`tabs/store.ts:195` 的注释本身就记载过这类"标签高亮但 store 从不 activate"竞态。

**夹具修复(保留)**:发思考事件前,像真实用户一样显式重开目标会话——点侧栏目标会话行 → 以 `probe.attaches.at(-1) === 目标 seed` 等宿主 attach 到达,保证订阅在场。为此 probe 增加 `attaches` 台账(attach mock 里 push)。若要真修,方向:把 `deactivate()` 移出 VT 回调、或 VT 回调只做视觉信号写入(与 `activationTargetId` 同源的同步护栏已有,问题只出在 deactivate 的执行时机)。

诊断用的临时插桩已全部还原;`layout-check.mjs` 当前 diff 仅含上述台账+重开逻辑。

## 3. 复跑命令(全部实测可用)

```bash
# dev server(必须;只绑 IPv6 回环,见 §4)
cd /home/qaqtamsy/Projects/qaqh-electron/webui && npm run dev &

# layout-check(约 90s;QAQH_EDGE 必须指向本机 Edge)
QAQH_EDGE=/usr/bin/microsoft-edge node scripts/layout-check.mjs

# settings-check(必须带 localhost 覆盖,默认 127.0.0.1 连不上)
QAQH_EDGE=/usr/bin/microsoft-edge SETTINGS_URL="http://localhost:5173/settings-check.html" \
  node scripts/settings-check.mjs

# oauth-shot(待跑,同样建议先确认其 URL 默认值;同目录脚本)
QAQH_EDGE=/usr/bin/microsoft-edge node scripts/oauth-shot.mjs

# 单元与类型检查(单独跑,内存紧张时 vitest 加 --no-file-parallelism)
npm run typecheck && npm test                    # Electron main(仓库根)
cd webui && npm run typecheck && npm test        # WebUI
```

## 4. 环境事实

- **vite 只监听 `[::1]:5173`**(IPv6 回环);`127.0.0.1` 拒绝连接。检查脚本里凡默认 `127.0.0.1` 的都要用 `localhost` 覆盖(layout-check 默认即 `localhost` 所以没踩到;settings-check 默认 `127.0.0.1` 必须覆盖)。这是之前 settings-check "夹具页面未就绪" 的根因,不是夹具问题。
- Edge:`/usr/bin/microsoft-edge`(v156,headless=new 可用);脚本默认的 Windows 路径必须用 `QAQH_EDGE` 覆盖。
- **内存**:7.9G 总量,浏览器检查期间 headless Edge ≈560MB PSS + vite ≈168MB;vitest 默认 64 workers 是更大的尖峰。跑重活前先 `pkill -f vite`、逐个跑。
- 后台 vite 用 `(npm run dev &)` 挂后台可能随 shell 退出而死,建议工具的原生后台任务方式。
- Bun 1.4.4 已装(`~/.bun/bin/bun`)。

## 5. 换路参考:Bun.WebView 评估结论(已调研,未实施)

- 本机 Bun 1.4.4 内置 `Bun.WebView`(实验性)。**Linux 上不是 WebKitGTK**:唯一后端是经 CDP 驱动 Chrome/Edge(`backend:"webkit"` 仅 macOS,Linux throw)——它替代的是手写 CDP 客户端,引擎本体不省。
- API 可覆盖检查所需(`evaluate` await+返回值、`type()`=InsertText、`press`、`screenshot`、`resize`、console 捕获);两个缺口可用 `view.cdp()` 逃生口补:`Page.addScriptToEvaluateOnNewDocument`(宿主 mock 必须先于 app 模块注入)与 `Runtime.exceptionThrown`。
- 实测内存:vite ~168MB + Edge ~560MB PSS。省内存的杠杆排序:vitest/cargo 并行度 > chrome-headless-shell 替代完整 Edge(估计 560→~300MB)> vite 静态化(另可消灭"中途 re-optimize 拆 module graph"的偶发源)> 换驱动层(≈0)。
- 若走 Bun.WebView:改造三个检查脚本约 2–4 小时;`docs/runtime/webview` 为准。

## 6. 下一步(建议顺序)

1. 补跑 `oauth-shot.mjs`;再把三套浏览器检查连续各跑 2 次确认无 flake(本轮 layout-check 修复只完整验证了 1 次)。
2. Electron main / WebUI typecheck+tests 各重跑一遍作最终定格(当前最后一次均为绿)。
3. **决定提交策略**:工作树约 300 文件未提交(含本会话 2 个文件);建议按影响清单 §8.3 的步骤拆分提交,不要混入 backend。
4. 后端侧仍按 [实施 handoff](./backend-v3-implementation-handoff-2026-11-03.md):先裁定 B01 水位语义、B05 receipt、B06 目录语义,再动 `crates/qaqh-session/src/owner.rs` 等;B02(coverage 假 URL)是最小先手项。
5. backend 改动后:exporter `check --against ../qaqh-sdk/src/protocol/generated` → SDK 重新生成+`npm test` → WebUI 205 个镜像类型同步(逐字节一致检查)→ 三方 typecheck。
6. 真机验收:隔离数据目录(不用用户目录/令牌),按影响清单 §8.3 第 7 条清单跑;最后 `just` 打包入口。
7. 遗留观察项:layout-check 的应用层 VT 竞态(§2.2)值得单独修,夹具自愈只是绕过;另外 vite dev 中途 re-optimize 曾导致一次假失败,静态化或锁 dep 缓存可消。

## 7. 本轮明确"未做"

- 未修改 backend / SDK 任何文件;未跑 contract exporter;未做真机 daemon 联调与打包。
- 未 commit/push 任何东西。
- B01–B09 的产品裁定(B01 水位二选一、B06 profile 退场与否、B09 是否承诺无损 resync)仍未决,动手前必须先定,见实施 handoff §建议实施顺序。
