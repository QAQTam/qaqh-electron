# Provider Retry / 网络波动状态接入说明

本文记录 provider retry / 网络波动的完整链路。renderer 已迁入本仓 `webui/`，不再依赖 `../qaqh-desktop-app`。

## 已落地

### 后端

- `qaqh-domain::TimelineEvent::ProviderRetrying { attempt, max_retries, delay_secs, error }`
- `qaqh-domain::TimelineIntent::ProviderRetrying { ... }`
- `qaqh-runtime/src/agent/turn_lap/gate.rs` 的 `StreamEvent::Retrying` 分支发射上述 intent。
- 该事件是瞬态事件：不进入 timeline 快照，只进入内存 journal + SSE 回放尾。
- 因此新 attach 的客户端不会从历史快照里恢复“当前正在重试”；它会在下一次重试事件到达时开始显示。若重试立即成功，就没有必要显示历史状态。
- `timeline_store::event_kind` 输出 `provider_retrying`。

### SDK

- 重新导出的 `TimelineEvent` 联合类型包含：

```ts
{ "type": "provider_retrying", attempt: number, max_retries: number, delay_secs: number, error: string }
```

- `watchSession` / `watchTimeline` 新增可选回调：

```ts
onReconnectScheduled?: (info: { attempt: number; delayMs: number }) => void;
```

`attempt` 从 1 开始；`delayMs` 是下一次 SSE 重连前的退避延迟。

### Electron 宿主

- `timeline://entry` 原样透传 `provider_retrying`，宿主不需要额外分支。
- 新增事件 `conn://reconnect`：

```ts
{ session_id: string, attempt: number, delay_ms: number, at: number }
```

- `src/main/types.ts` 增加 `ReconnectStatusWire`。
- `src/preload/index.ts` 的事件白名单增加 `conn://reconnect`。
- `RingingClient` 把两条 watch 的 `onReconnectScheduled` 转发为 `conn://reconnect`。
- session 与 timeline 两条 watch 可能各自上报；renderer 以最新一条为准即可，不要求 UI 区分流。

## Renderer 接入（已实现）

### 1. 类型与事件订阅

- `webui/src/lib/desktop-host.ts`：`HostEvent` 增加 `"conn://reconnect"`。
- `webui/src/lib/transport/backend.ts`：
  - 增加 `ReconnectStatusWire`；
  - `StreamHandlers` 增加 `onReconnect?(info: ReconnectStatusWire): void`。
- `webui/src/lib/transport/electron.ts`：`subscribe` 中监听 `conn://reconnect`，调用 `handlers.onReconnect`。
- `webui/src/api/qaqh/TimelineEvent.ts`：加入 `provider_retrying`。

### 2. SessionStore

新增两个瞬态信号：

```ts
providerRetry = createSignal<{
  turnId: string;
  attempt: number;
  maxRetries: number;
  delaySecs: number;
  error: string;
} | null>(null);

reconnect = createSignal<{
  attempt: number;
  delayMs: number;
  at: number;
} | null>(null);
```

- `onTimelineEntry` 收到 `event.type === "provider_retrying"` 时只更新 `providerRetry`，**不要** `ensureTurn` / 不创建 step；但仍要执行 `flushFragmentsInto(draft)` 并推进 `draft.watermark` / `consumedSeq`，否则后续事件会被判成 seq 缺口。
- 任何后续内容事件（`block_opened`、`text_delta`、`tool_updated`）、`turn_sealed`、快照重建时清空 `providerRetry`。
- `connectHost` 的 handlers 增加 `onReconnect`，写入 `reconnect` 并保持 `connection = "reconnecting"`。
- `applyTimelineStatus` 在 `open` 时清空 `reconnect`；`closed` 时也清空（改用“已断开”文案）。
- `activate` / `retry` 时清空旧状态。

### 3. UI

- `webui/src/session/SessionView.tsx` 显示 `providerRetry`：
  - 文案：`上游请求失败，正在重试（第 N/M 次，D 秒后）`
  - 第二行展示 `error`（后端已脱敏/截断）。
  - 颜色用 warn，不要用 err（重试仍可能成功）。
- `webui/src/app/App.tsx` 的 `connectionNotice` 在 `connection === "reconnecting"` 且 `reconnect` 非空时显示：
  - `网络波动，正在重连（第 N 次，D 秒后）`
  - 否则保留原 `重连中`。
- `webui/src/lib/strings.ts` 增加上述两条文案。
- `webui/src/styles/components/feedback.css` 增加 `.provider-retry` 的样式。

### 4. 验证

- `pnpm --dir webui typecheck`
- `pnpm --dir webui test`（521/521）
- `pnpm --dir webui build`
- 手工/夹具：模拟 `timeline://entry` 的 `provider_retrying`，确认横幅出现并在下一个内容事件后消失；模拟 `conn://reconnect`，确认“网络波动”文案与重试按钮。
