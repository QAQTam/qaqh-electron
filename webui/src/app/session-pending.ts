/**
 * 会话「需要人类响应」的呈现映射 —— 纯函数,无 Solid / 无 DOM。
 *
 * 后端 `SessionRunStatus`(8 态,`src/api/qaqh/SessionRunStatus.ts`)里,有三态
 * 的语义就是「球在用户这边」:等工具授权、等回答、等计划评审。侧栏给这三态
 * 弹一张卡,其余五态(`not_running` / `idle` / `working` / `canceled` / `error`)
 * 一律不弹——`canceled`/`error` 是上一回合的终态驻留,不是待办。
 *
 * 判据与宿主 `session_is_busy`(`src-tauri/src/commands.rs:155`)同源但**不等价**:
 * 那边多算一个 `working`(「还挂着事」),这边只取要人动手的三个。
 */
import type { SessionRunStatus } from "../api/qaqh/SessionRunStatus";
import type { SidebarSession } from "../tabs/store";
import type { ApprovalView } from "../lib/transport";
import { STR } from "../lib/strings";

export type PendingKind = "permission" | "ask" | "plan";

/** 卡片形态:`pending` = 待人响应;`working` = 回合在跑(沿用旧状态点)。 */
export type PendingPhase = "pending" | "working";

export interface PendingPresentation {
  kind: PendingKind;
  /** 卡内跑马灯文案;标题另行渲染,不混进来。 */
  label: string;
  /** 无障碍名:标题 + 待办,读屏不必逐字听跑马灯。 */
  ariaLabel: string;
  phase: PendingPhase;
}

/**
 * 旧 daemon 兼容:新契约里 `status` 是权威,但升级窗口内可能只有
 * `running: bool` / `busy`。两者都缺时按 `idle` 处理(不弹卡)。
 *
 * 注意 `busy === true` 无法区分「在跑」与「等人」——这正是把 `status` 加进
 * 侧栏投影的原因,见 `src-tauri/src/commands.rs` 的 `SidebarSession`。
 */
export function runStatusOf(session: Pick<SidebarSession, "status" | "busy">): SessionRunStatus {
  if (session.status != null) return session.status;
  return session.busy === true ? "working" : "idle";
}

/** `status` 或本地实时审批(fast path) → 待响应呈现;非待人态返回 null。 */
export function pendingPresentation(
  session: Pick<SidebarSession, "title" | "status" | "busy">,
  fastApproval?: Pick<ApprovalView, "kind"> | null,
): PendingPresentation | null {
  const title = session.title?.trim() || "该会话";
  if (fastApproval != null) {
    switch (fastApproval.kind) {
      case "tool_permission":
        return { kind: "permission", label: STR.pendingPermission, ariaLabel: `${title}:${STR.pendingPermission}`, phase: "pending" };
      case "ask":
        return { kind: "ask", label: STR.pendingAsk, ariaLabel: `${title}:${STR.pendingAsk}`, phase: "pending" };
      case "plan":
        return { kind: "plan", label: STR.pendingPlan, ariaLabel: `${title}:${STR.pendingPlan}`, phase: "pending" };
    }
  }
  switch (runStatusOf(session)) {
    case "waiting_permission":
      return { kind: "permission", label: STR.pendingPermission, ariaLabel: `${title}:${STR.pendingPermission}`, phase: "pending" };
    case "waiting_ask":
      return { kind: "ask", label: STR.pendingAsk, ariaLabel: `${title}:${STR.pendingAsk}`, phase: "pending" };
    case "waiting_plan":
      return { kind: "plan", label: STR.pendingPlan, ariaLabel: `${title}:${STR.pendingPlan}`, phase: "pending" };
    default:
      return null;
  }
}

/**
 * 未进待响应时的兜底状态点:`working` 沿用旧的小圆点(§5.2)。
 *
 * 待人态刻意**不**落进这里:那时卡片本身就是提示,再点一个圆点就是两个信号
 * 说同一件事,而且圆点还会和卡片抢右端的位置。
 */
export function workingOnly(
  session: Pick<SidebarSession, "status" | "busy">,
  hasFastPending = false,
): boolean {
  if (hasFastPending) return false;
  return runStatusOf(session) === "working";
}