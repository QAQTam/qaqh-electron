import { describe, expect, test } from "vitest";
import { normalizeActivity } from "../src/session/projection";

describe("activity state normalization", () => {
  test("flattens the Ringing activity enum", () => {
    expect(normalizeActivity("idle", "projection")).toBe("idle");
    expect(normalizeActivity("running", "projection")).toBe("working");
    expect(normalizeActivity("waiting_user", "projection")).toBe("waiting_user");
    expect(normalizeActivity("cancelling", "projection")).toBe("cancelling");
  });

  test("maps current domain activity values", () => {
    for (const [value, expected] of [["idle", "idle"], ["running", "working"], ["waiting_user", "waiting_user"], ["cancelling", "cancelling"]]) {
      expect(normalizeActivity(value, "domain")).toBe(expected);
    }
  });

  test("unknown or cross-domain values produce no activity update", () => {
    expect(normalizeActivity("interrupted", "projection")).toBeNull();
    expect(normalizeActivity("unknown", "domain")).toBeNull();
    expect(normalizeActivity(null, "projection")).toBeNull();
  });
});
