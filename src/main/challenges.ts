import { randomBytes } from "node:crypto";
import type { ApprovalView, ApprovalKind } from "./types.js";

interface StoredChallenge {
  challengeId: string;
  sessionId: string;
  kind: ApprovalKind;
  internalId: string;
  expiresAt: number;
  details: Record<string, any>;
}

export class ChallengeManager {
  private challenges: Map<string, StoredChallenge> = new Map();

  issueViews(sessionId: string, pendingItems: any[]): ApprovalView[] {
    const now = Date.now();
    // 清理已过期的挑战
    for (const [id, item] of this.challenges.entries()) {
      if (item.expiresAt <= now) {
        this.challenges.delete(id);
      }
    }

    const views: ApprovalView[] = [];

    for (const item of pendingItems) {
      const challengeId = randomBytes(32).toString("hex");
      const kind: ApprovalKind = (item.kind as ApprovalKind) || "tool_permission";
      const ttlSecs = 300; // 5 分钟
      const expiresAt = now + ttlSecs * 1000;

      const stored: StoredChallenge = {
        challengeId,
        sessionId,
        kind,
        internalId: item.interaction_id || item.call_id || item.id || challengeId,
        expiresAt,
        details: item.details || item.request || {},
      };

      this.challenges.set(challengeId, stored);

      views.push({
        challenge_id: challengeId,
        kind,
        expires_in: ttlSecs,
        details: stored.details,
      });
    }

    return views;
  }

  consume(sessionId: string, challengeId: string): StoredChallenge | null {
    const stored = this.challenges.get(challengeId);
    if (!stored) return null;
    if (stored.sessionId !== sessionId) return null;
    if (stored.expiresAt < Date.now()) {
      this.challenges.delete(challengeId);
      return null;
    }
    this.challenges.delete(challengeId);
    return stored;
  }

  clear(): void {
    this.challenges.clear();
  }
}
