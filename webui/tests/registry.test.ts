/** Tool summaries use named arguments from the v3 raw call payload. */
import { describe, expect, test } from "vitest";
import { primaryArg, primaryArgFull } from "../src/tools/registry";

describe("primaryArg", () => {
  test("unknown arguments do not leak source or raw JSON into the summary", () => {
    const args = JSON.stringify({ old_str: "old source", new_str: "new source" });
    expect(primaryArg(args)).toBe("");
    expect(primaryArg('{"filename":"src/config.rs","new_str":"source"}')).toBe("src/config.rs");
  });

  test("reads explicit command, argv, path, and query arguments", () => {
    expect(primaryArgFull('{"command":"cargo test"}')).toBe("cargo test");
    expect(primaryArgFull('{"argv":["git","status","--short"]}')).toBe("git status --short");
    expect(primaryArg('{"path":"/tmp/a"}')).toBe("/tmp/a");
    expect(primaryArg('{"query":"cats"}')).toBe("cats");
  });

  test("missing or malformed arguments stay empty", () => {
    expect(primaryArg(undefined)).toBe("");
    expect(primaryArg("not-json")).toBe("");
  });
});
