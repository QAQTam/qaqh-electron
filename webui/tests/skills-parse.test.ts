/**
 * SKILL.md frontmatter 解析单测。样本对照两处后端事实:
 *  - codex `codex-rs/skills/src/parser.rs` + `parser_tests.rs`(冒号散文修复、
 *    引号值、缺省 name 回退、缺 description 判失败)
 *  - codex skills crate 的 assets/samples 目录样例(metadata.short-description)
 */
import { describe, expect, test } from "vitest";
import {
  extractFrontmatter,
  parseSkillFrontmatter,
  repairFrontmatterScalarFields,
} from "../src/skills/parse";

describe("extractFrontmatter", () => {
  test("标准三横线块", () => {
    expect(extractFrontmatter("---\nname: a\n---\nbody")).toBe("name: a");
  });

  test("CRLF 归一后照常提取", () => {
    expect(extractFrontmatter("---\r\nname: a\r\n---\r\nbody")).toBe("name: a");
  });

  test("无 frontmatter / 无闭合 / `---foo` 都拒绝", () => {
    expect(extractFrontmatter("no marker")).toBeNull();
    expect(extractFrontmatter("---\nname: a")).toBeNull();
    expect(extractFrontmatter("---\nname: a\n---foo\nbody")).toBeNull();
  });
});

describe("repairFrontmatterScalarFields", () => {
  test("裸冒号散文值改写成引号标量", () => {
    const input = "name: aws\ndescription: Build for AWS: ECS and more";
    expect(repairFrontmatterScalarFields(input)).toBe(
      'name: aws\ndescription: "Build for AWS: ECS and more"',
    );
  });

  test("正常行原样保留,无修复返回 null", () => {
    expect(repairFrontmatterScalarFields("name: a\ndescription: ok")).toBeNull();
    expect(repairFrontmatterScalarFields("description: \"a: b\"")).toBeNull();
  });

  test("argument-hint 形状(`<>` 里带冒号)也被引住", () => {
    const input = "argument-hint: <duration: e.g. 7d>";
    expect(repairFrontmatterScalarFields(input)).toBe('argument-hint: "<duration: e.g. 7d>"');
  });
});

describe("parseSkillFrontmatter", () => {
  test("codex skill-creator 样例形状(name/description/metadata.short-description)", () => {
    const sample = [
      "---",
      "name: skill-creator",
      "description: Create or update a Codex skill with appropriately scoped instructions.",
      "metadata:",
      "  short-description: Create or update a skill",
      "---",
      "",
      "# Skill Creator",
      "",
      "Create skills that give Codex useful guidance.",
    ].join("\n");
    expect(parseSkillFrontmatter(sample, "fallback")).toEqual({
      name: "skill-creator",
      description: "Create or update a Codex skill with appropriately scoped instructions.",
      shortDescription: "Create or update a skill",
      body: "# Skill Creator\n\nCreate skills that give Codex useful guidance.",
    });
  });

  test("引号值与行内注释", () => {
    const sample = '---\nname: "openai-docs"\ndescription: "Use for: docs" # routing\n---\nbody';
    const parsed = parseSkillFrontmatter(sample, "fallback");
    expect(parsed?.name).toBe("openai-docs");
    expect(parsed?.description).toBe("Use for: docs");
  });

  test("冒号散文 description 走修复路径不炸", () => {
    const sample = "---\nname: aws\ndescription: Build for AWS: ECS\n---\nbody";
    const parsed = parseSkillFrontmatter(sample, "fallback");
    expect(parsed?.description).toBe("Build for AWS: ECS");
  });

  test("name 缺省回退目录名并截到 64 字符", () => {
    const sample = "---\ndescription: 只有描述的 skill\n---\nbody";
    const longName = "x".repeat(70);
    expect(parseSkillFrontmatter(sample, longName)?.name).toHaveLength(64);
    expect(parseSkillFrontmatter(sample, "dir-name")?.name).toBe("dir-name");
  });

  test("缺 description 判失败;name 位置放错(嵌套)不误当顶层", () => {
    expect(parseSkillFrontmatter("---\nname: a\n---\nbody", "f")).toBeNull();
    // metadata 块下的 `name` 不该被当成顶层 name。
    const sample = "---\nmetadata:\n  name: nested\ndescription: d\n---\nbody";
    expect(parseSkillFrontmatter(sample, "toplevel")?.name).toBe("toplevel");
  });
});
