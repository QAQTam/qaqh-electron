import { afterEach, expect, test, vi } from "vitest";
import { transport } from "../src/lib/transport";
import { rescanSkills, scanState } from "../src/skills/scan";

afterEach(() => vi.restoreAllMocks());

test("skill catalog comes from the backend and exposes metadata without file bodies", async () => {
  const query = vi.spyOn(transport, "query").mockResolvedValue({
    skills: [
      { name: "alpha", description: "Alpha helper", scope: "project", origin: "project", path: "/repo/.agents/skills/alpha/SKILL.md" },
      { name: "beta", description: "Beta helper", scope: "user", origin: "user", path: "/home/user/.agents/skills/beta/SKILL.md" },
    ],
    diagnostics: [{ severity: "warning", path: "/repo/.agents/skills/broken", message: "invalid skill" }],
  } as never);

  await rescanSkills();

  expect(query).toHaveBeenCalledWith("skills.catalog", { cwd: null });
  expect(scanState().status).toBe("done");
  expect(scanState().project[0]).toMatchObject({ name: "alpha", workspace: "当前目录", shortDescription: null });
  expect(scanState().user[0]).toMatchObject({ name: "beta", scope: "user", shadowed: false });
  expect(scanState().project[0]).not.toHaveProperty("body");
  expect(scanState().issues[0]).toMatchObject({ root: "/repo/.agents/skills/broken", message: "warning: invalid skill" });
  expect(scanState().userRoots).toEqual([]);
  expect(scanState().userScanUnsupported).toBe(false);
});

test("catalog failures are surfaced as diagnostics and marked unreachable", async () => {
  vi.spyOn(transport, "query").mockRejectedValue(new Error("daemon offline"));
  await rescanSkills();
  expect(scanState()).toMatchObject({
    status: "done",
    project: [],
    user: [],
    daemonUnreachable: true,
    issues: [{ root: "当前目录", message: "daemon offline", forbidden: false }],
  });
});
