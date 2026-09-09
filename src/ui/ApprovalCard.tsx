// ApprovalCard：120s 倒计时审批卡（spec §9）。浮出 composer 上方，一次只显最早一条。
// 三按钮 → tool_permission_respond{approved, trust_folder}。超时灰化"已过期"。
import { Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Component } from "solid-js";
import type { ToolPermissionRequest } from "qaqh-js-sdk";

const TTL_MS = 120_000;
const URGE_MS = 20_000;

export interface ApprovalActions {
  respond: (callId: string, approved: boolean, trustFolder: boolean) => void;
}

export const ApprovalCard: Component<{
  request: ToolPermissionRequest;
  arrivedAt: number;
  actions: ApprovalActions;
}> = (props) => {
  const [now, setNow] = createSignal(Date.now());
  const [expired, setExpired] = createSignal(false);
  const [answered, setAnswered] = createSignal(false);

  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    const expireAt = props.arrivedAt + TTL_MS;
    const expireTimer = setTimeout(() => setExpired(true), Math.max(0, expireAt - Date.now()));
    const removeTimer = setTimeout(
      () => setAnswered(true), // 过期 10s 后自动移除（由父级过滤 rendered）
      Math.max(0, expireAt - Date.now() + 10_000),
    );
    return () => {
      clearInterval(timer);
      clearTimeout(expireTimer);
      clearTimeout(removeTimer);
    };
  });

  const remainMs = createMemo(() => Math.max(0, props.arrivedAt + TTL_MS - now()));
  const remainSec = createMemo(() => Math.ceil(remainMs() / 1000));
  const urgent = createMemo(() => remainMs() <= URGE_MS);
  // 倒计时环
  const frac = createMemo(() => remainMs() / TTL_MS);
  const R = 16;
  const C = 2 * Math.PI * R;

  const answer = (approved: boolean, trustFolder: boolean) => {
    if (expired() || answered()) return;
    props.actions.respond(props.request.toolCallId, approved, trustFolder);
    setAnswered(true);
  };

  return (
    <div class={["approval-card", { expired: expired() }]}>
      <div class="approval-main">
        <div class="approval-title-row">
          <span class={["risk-badge", props.request.risk]}>{props.request.risk}</span>
          <span class="approval-tool">{props.request.toolName}</span>
        </div>
        <div class="approval-reason">{props.request.reason}</div>
        <Show when={props.request.paths.length > 0}>
          <div class="approval-paths">{props.request.paths.join("  ·  ")}</div>
        </Show>
        <div class="approval-meta">
          <span class="approval-cat">{props.request.category}</span>
          <span>{props.request.consequence}</span>
          <Show when={expired()}>
            <span style={{ color: "var(--danger)", "font-weight": 600 }}>已过期</span>
          </Show>
        </div>
        <div class="approval-actions">
          <button class="approval-btn" disabled={expired()} onClick={() => answer(false, false)}>
            拒绝
          </button>
          <button class="approval-btn primary" disabled={expired()} onClick={() => answer(true, false)}>
            允许一次
          </button>
          <button class="approval-btn trust" disabled={expired()} onClick={() => answer(true, true)}>
            信任此目录
          </button>
        </div>
      </div>
      <Show when={!expired()}>
        <div class={["countdown", { urgent: urgent() }]}>
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r={R} fill="none" stroke="var(--border)" stroke-width="2.5" />
            <circle
              cx="20"
              cy="20"
              r={R}
              fill="none"
              stroke={urgent() ? "var(--danger)" : "var(--accent)"}
              stroke-width="2.5"
              stroke-dasharray={String(C)}
              stroke-dashoffset={String(C * (1 - frac()))}
              stroke-linecap="round"
            />
          </svg>
          <span class="cd-num">{remainSec()}</span>
        </div>
      </Show>
    </div>
  );
};
