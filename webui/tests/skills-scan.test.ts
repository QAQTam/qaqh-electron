/**
 * skills 分层与去重的纯逻辑单测。
 *
 * 对照的后端事实:`qaqh-backend/crates/qaqh-skills/src/lib.rs`
 *  - `discovery_roots`(195-207):项目 `.qaqh` > `.agents` > `skills`,再用户
 *    `~/.qaqh` > `~/.agents`;
 *  - `discover_roots`(209-227):同名 skill 先到先得,被覆盖的只留一条诊断
 *    (`skill 'x' shadowed by <path>`),不进 catalog。
 *
 * 前端的展示模型必须与这条顺序同判据,否则界面会声称「这个 skill 可用」而模型
 * 侧其实拿到的是另一个同名条目。
 */
import { describe, expect, test } from "vitest";
import { applyShadowing, type SkillEntry } from "../src/skills/scan";

function entry(name: string, scope: "project" | "user", workspace: string): SkillEntry {
  return {
    name,
    description: `${name} description`,
    shortDescription: null,
    body: "# body",
    workspace,
    path: `${workspace}/${name}/SKILL.md`,
    scope,
    shadowed: false,
  };
}

describe("applyShadowing", () => {
  test("项目级先占,同名用户级被标记而不删除", () => {
    const project = [entry("alpha", "project", "repo")];
    const user = [entry("alpha", "user", "~/.agents/skills"), entry("beta", "user", "~/.agents/skills")];
    applyShadowing(project, user);
    expect(user[0]?.shadowed).toBe(true);
    expect(user[1]?.shadowed).toBe(false);
    // 项目级一侧永远不被标记。
    expect(project[0]?.shadowed).toBe(false);
    // 被覆盖的条目留在列表里:界面要能解释「我放的 SKILL.md 去哪了」。
    expect(user).toHaveLength(2);
  });

  test("用户级内部同名也去重(先到先得,与 discover_roots 同序)", () => {
    const user = [
      entry("same", "user", "~/.qaqh/skills"),
      entry("same", "user", "~/.agents/skills"),
    ];
    applyShadowing([], user);
    expect(user[0]?.shadowed).toBe(false);
    expect(user[1]?.shadowed).toBe(true);
  });

  test("无交集时全部保留", () => {
    const project = [entry("a", "project", "repo")];
    const user = [entry("b", "user", "~/.agents/skills")];
    applyShadowing(project, user);
    expect([...project, ...user].some((skill) => skill.shadowed)).toBe(false);
  });
});