import type { RingingCommand, RingingV2PendingApprovals } from "@qaqh/sdk/protocol";
import type { ApprovalKind, RingingCommandAck } from "./types.js";

/** Canonical ids stay in the host; only details enter the approval view. */
export interface PendingApproval {
  kind: ApprovalKind;
  internalId: string;
  snapshotId: string;
  details: Record<string, unknown>;
  /** The canonical request body could not be loaded; never present approval actions. */
  detailsUnavailable?: boolean;
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as Record<string, unknown>;
}

/** The admin response has independent permission and ask/plan slots. */
export function flattenAdminApprovals(pending: RingingV2PendingApprovals): PendingApproval[] {
  const slots = record(pending, "pending_approvals");
  const items: PendingApproval[] = [];
  if (slots.pending_permission !== null) {
    const permission = record(slots.pending_permission, "pending_permission");
    const details: Record<string, unknown> = {};
    for (const key of ["tool_name", "action_summary", "reason", "paths", "category", "level", "risk", "consequence"]) {
      details[key] = permission[key] ?? (key === "paths" ? [] : null);
    }
    details.details_unavailable = permission.details_unavailable === true;
    items.push({
      kind: "tool_permission",
      internalId: requireId(permission.tool_call_id, "tool_call_id"),
      snapshotId: requireId(permission.tool_call_id, "tool_call_id"),
      details,
      detailsUnavailable: permission.details_unavailable === true,
    });
  }
  if (slots.pending_interaction !== null) {
    const interaction = record(slots.pending_interaction, "pending_interaction");
    // A permission interaction id is NOT a tool-call id. The daemon projects
    // tool permissions through the canonical pending_permission slot.
    if (interaction.kind !== "ask" && interaction.kind !== "plan") throw new Error("invalid_pending_interaction_kind");
    items.push({
      kind: interaction.kind,
      internalId: requireId(interaction.id, "interaction_id"),
      snapshotId: requireId(interaction.id, "interaction_id"),
      details: interaction.details === null ? {} : record(interaction.details, "interaction_details"),
      detailsUnavailable: interaction.details === null,
    });
  }
  return items;
}

/** Closed decision vocabulary; never forward arbitrary renderer payload keys.
 *  交互应答走 control 频道命令（ControlCommand wire 名），不是统一目录操作。 */
export function approvalCommand(
  approval: Pick<PendingApproval, "kind" | "internalId">,
  decision: string,
  payload: unknown = {},
): RingingCommand {
  const id = requireId(approval.internalId, "approval_id");
  const body = record(payload, "approval_payload");
  switch (approval.kind) {
    case "tool_permission":
      if (!["approve", "reject", "trust"].includes(decision)) throw new Error("invalid_decision");
      return { type: "tool.permission.respond", tool_call_id: id, approved: decision !== "reject", trust_folder: decision === "trust" };
    case "ask": {
      if (decision === "dismiss") return { type: "interaction.ask.dismiss", interaction_id: id };
      if (decision !== "submit") throw new Error("invalid_decision");
      if (!Array.isArray(body.answers) || body.answers.length === 0) throw new Error("invalid_answers");
      const seen = new Set<string>();
      const answers: { question_id: string; answer: string }[] = [];
      for (const value of body.answers as unknown[]) {
        const answer = record(value, "answer");
        const questionId = requireId(answer.question_id, "question_id");
        if (seen.has(questionId) || typeof answer.answer !== "string" || !answer.answer.trim()) throw new Error("invalid_answers");
        seen.add(questionId);
        answers.push({ question_id: questionId, answer: answer.answer });
      }
      return { type: "interaction.ask.respond", interaction_id: id, answers };
    }
    case "plan":
      if (decision !== "approve" && decision !== "reject") throw new Error("invalid_decision");
      if (body.message != null && typeof body.message !== "string") throw new Error("invalid_plan_message");
      return {
        type: "plan.review.respond", interaction_id: id,
        approved: decision === "approve",
        message: typeof body.message === "string" ? body.message : null,
        autonomous: false,
      };
    default:
      throw new Error("invalid_approval_kind");
  }
}

export function requireAccepted(ack: RingingCommandAck): RingingCommandAck {
  // 新 ack 状态面只有 accepted|rejected（目录操作同步完成，result 直接回带）。
  if (ack.status !== "accepted") throw new Error(`command rejected (${ack.code ?? "unknown"}): ${ack.message ?? ""}`);
  return ack;
}
