import { describe, expect, test } from "vitest";
import { normalizeActivity } from "../src/session/projection";

describe("activity state normalization", () => {
  test("flattens the Ringing activity enum", () => {
    expect(normalizeActivity("idle", "projection")).toBe("idle");
    expect(normalizeActivity("running", "projection")).toBe("working");
    expect(normalizeActivity("interrupted", "projection")).toBe("interrupted");
  });

  test("keeps domain activity values, including starting", () => {
    for (const value of ["starting", "idle", "working", "waiting_user", "disconnected", "failed"]) {
      expect(normalizeActivity(value, "domain")).toBe(value);
    }
  });

  test("unknown or cross-domain values produce no activity update", () => {
    expect(normalizeActivity("waiting_user", "projection")).toBeNull();
    expect(normalizeActivity("unknown", "domain")).toBeNull();
    expect(normalizeActivity(null, "projection")).toBeNull();
  });
});
