import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requireId, type PendingApproval } from "./approvals.js";
import type { ApprovalView, ApprovalKind } from "./types.js";

export interface StoredChallenge {
  challengeId: string;
  sessionId: string;
  kind: ApprovalKind;
  internalId: string;
  expiresAt: number;
  details: Record<string, unknown>;
  detailsUnavailable: boolean;
  verified: boolean;
}

export const APPROVAL_TTL_MS = 300_000;
export const MAX_PENDING_APPROVALS = 16;

export class ChallengeManager {
  private challenges: Map<string, StoredChallenge> = new Map();

  constructor(private readonly now: () => number = Date.now) {}

  issueViews(sessionId: string, pendingItems: PendingApproval[]): ApprovalView[] {
    requireId(sessionId, "session_id");
    const now = this.now();
    // Reconcile only this session against its authoritative successful read.
    // A failed read must never reach here and revoke a still-pending card.
    const next = new Map([...this.challenges].filter(([, stored]) => stored.expiresAt > now && (
      stored.sessionId !== sessionId || pendingItems.some(item =>
        item.kind === stored.kind && item.internalId === stored.internalId
        && (item.detailsUnavailable ?? false) === stored.detailsUnavailable
        && isDeepStrictEqual(item.details, stored.details))
    )));
    const views: ApprovalView[] = [];
    for (const item of pendingItems) {
      requireId(item.internalId, "approval_id");
      if (!["tool_permission", "ask", "plan"].includes(item.kind)) throw new Error("invalid_approval_kind");
      let stored = [...next.values()].find(value => value.sessionId === sessionId && value.kind === item.kind && value.internalId === item.internalId
        && value.detailsUnavailable === (item.detailsUnavailable ?? false) && isDeepStrictEqual(value.details, item.details));
      if (!stored) {
        if (next.size >= MAX_PENDING_APPROVALS) throw new Error("approval_limit");
        const challengeId = randomBytes(32).toString("hex");
        const issued: StoredChallenge = {
          challengeId,
          sessionId,
          kind: item.kind,
          internalId: item.internalId,
          expiresAt: now + APPROVAL_TTL_MS,
          details: structuredClone(item.details),
          detailsUnavailable: item.detailsUnavailable ?? false,
          verified: true,
        };
        next.set(challengeId, issued);
        stored = issued;
      }
      views.push({
        challenge_id: stored.challengeId,
        kind: stored.kind,
        expires_in: Math.ceil((stored.expiresAt - now) / 1000),
        details: { ...structuredClone(stored.details), details_unavailable: stored.detailsUnavailable },
        details_unavailable: stored.detailsUnavailable,
        verified: stored.verified,
      });
    }
    this.challenges = next;
    return views;
  }

  consume(sessionId: string, challengeId: string): StoredChallenge | null {
    const stored = this.challenges.get(challengeId);
    if (!stored) return null;
    if (stored.sessionId !== sessionId) return null;
    if (stored.expiresAt <= this.now()) {
      this.challenges.delete(challengeId);
      return null;
    }
    this.challenges.delete(challengeId);
    return stored;
  }

  invalidate(sessionId: string): void {
    for (const [challengeId, stored] of this.challenges) {
      if (stored.sessionId === sessionId) this.challenges.delete(challengeId);
    }
  }

  invalidateChallenge(sessionId: string, challengeId: string): void {
    const stored = this.challenges.get(challengeId);
    if (stored?.sessionId === sessionId) this.challenges.delete(challengeId);
  }

  confirmChallenge(sessionId: string, challengeId: string): void {
    const stored = this.challenges.get(challengeId);
    if (stored?.sessionId === sessionId) stored.verified = true;
  }

  markChallengeUnverified(sessionId: string, challengeId: string): void {
    const stored = this.challenges.get(challengeId);
    if (stored?.sessionId === sessionId) stored.verified = false;
  }

  clear(): void {
    this.challenges.clear();
  }
}
