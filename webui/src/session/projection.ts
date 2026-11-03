import type { ActivityState, SessionActivityState } from "@qaqh/sdk/protocol";

export type SessionActivity = "starting" | "idle" | "working" | "waiting_user" | "interrupted" | "failed" | "disconnected";

const ACTIVITY_FROM_RINGING: Record<ActivityState, SessionActivity> = {
  idle: "idle",
  running: "working",
  interrupted: "interrupted",
};

const ACTIVITY_FROM_SERVICE: Record<SessionActivityState, SessionActivity> = {
  starting: "starting",
  idle: "idle",
  working: "working",
  waiting_user: "waiting_user",
  disconnected: "disconnected",
  failed: "failed",
};

export function normalizeActivity(state: unknown, source: "projection" | "domain"): SessionActivity | null {
  if (source === "projection") return typeof state === "string" && state in ACTIVITY_FROM_RINGING
    ? ACTIVITY_FROM_RINGING[state as ActivityState] : null;
  return typeof state === "string" && state in ACTIVITY_FROM_SERVICE
    ? ACTIVITY_FROM_SERVICE[state as SessionActivityState] : null;
}
