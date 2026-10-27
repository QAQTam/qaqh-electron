/**
 * SKILL.md frontmatter 解析(前端只读镜像)。
 *
 * 与两套后端事实保持同形:
 *  - codex `codex-rs/skills/src/parser.rs`:允许第三方 skills 写坏 YAML
 *    (`description: Build for AWS: ECS` 这类冒号散文),解析失败时按行修复标量
 *    字段再试一次;name 缺省回退目录名,description 缺失才判失败。
 *  - qaqh `crates/qaqh-skills/src/lib.rs`:同一 Agent Skills 形状(name/description
 *    + metadata),scope 标 "project"|"user",body 在激活时才读——这里同样只
 *    留正文原文,渲染交给 Markdown 组件。
 *
 * 前端不引 YAML 库:skills 目录就是一行一个键的窄形状,手写行解析 + 容错
 * 修复足够,也避免把 YAML 依赖拖进主包。
 */

export type ParsedSkillFrontmatter = {
  name: string;
  description: string;
  shortDescription: string | null;
  /** frontmatter 结束后的 Markdown 正文(原样,不裁剪)。 */
  body: string;
};

/** 与 codex parser.rs 的 MAX_NAME_LEN 一致。 */
const MAX_NAME_LEN = 64;
/** 与 qaqh-skills / codex interface.rs 的描述上限一致(超长截断,不判失败)。 */
const MAX_DESCRIPTION_LEN = 1024;

/** 去引号 + 去行内注释 + 压缩空白。单行标量字段专用。 */
function sanitizeSingleLine(raw: string): string {
  let value = raw.trim();
  if ((value.startsWith("\"") && value.endsWith("\"") && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    return value.slice(1, -1).replace(/\\(["'\\])/g, "$1").trim();
  }
  const hash = value.indexOf(" #");
  if (hash >= 0) value = value.slice(0, hash);
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

/**
 * 行级修复:YAML 值里的裸冒号(如 `description: Build for AWS: ECS`)会让严格
 * 解析炸掉。逐行把顶层 `key: 值里带裸冒号` 的行改写成带引号的键值——与 codex
 * `repair_frontmatter_scalar_fields` 同方向:保留数据,吞掉散文冒号。
 */
export function repairFrontmatterScalarFields(frontmatter: string): string | null {
  const lines = frontmatter.split(/\r?\n/);
  const out: string[] = [];
  let repaired = false;
  for (const line of lines) {
    const match = /^([A-Za-z][\w-]*):[ \t](.+)$/.exec(line);
    const value = match?.[2] ?? "";
    if (match != null && /:\s/.test(value) && !/^["'].*["']\s*$/.test(value)) {
      out.push(`${match![1]}: "${value.replace(/"/g, '\\"')}"`);
      repaired = true;
      continue;
    }
    out.push(line);
  }
  return repaired ? out.join("\n") : null;
}

/** 提取 `---` 包住的 frontmatter 块;首行必须是 `---`。 */
export function extractFrontmatter(contents: string): string | null {
  if (!contents.startsWith("---")) return null;
  const normalized = contents.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---");
  if (end < 0) return null;
  const after = normalized.slice(end + 4);
  if (!after.startsWith("\n")) return null;
  return normalized.slice(3, end).replace(/^\n/, "");
}

/** 解析 + 校验。失败返回 null(调用方按「不可加载」分桶展示诊断)。 */
export function parseSkillFrontmatter(
  contents: string,
  defaultName: string,
): ParsedSkillFrontmatter | null {
  const normalized = contents.replace(/\r\n/g, "\n");
  const frontmatter = extractFrontmatter(normalized);
  if (frontmatter == null) return null;
  const marker = normalized.indexOf("\n---");
  const body = normalized.slice(normalized.indexOf("\n", marker + 1) + 1).replace(/^\n/, "");

  const scalars = new Map<string, string>();
  let currentKey: string | null = null;
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const top = /^[A-Za-z][\w-]*:/.test(line) ? /^([A-Za-z][\w-]*):(?:[ \t](.*))?$/.exec(line) : null;
    if (top != null) {
      const key = top[1] ?? "";
      currentKey = key;
      const value = (top[2] ?? "").trim();
      if (value !== "") scalars.set(key, sanitizeSingleLine(value));
      continue;
    }
    // 嵌套行:metadata 的 short-description(与 codex serde rename 同形)。
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (nested != null && currentKey === "metadata" && (nested[1] ?? "") === "short-description") {
      const value = sanitizeSingleLine(nested[2] ?? "");
      if (value !== "") scalars.set("short-description", value);
    }
  }

  let name = scalars.get("name") ?? "";
  if (name === "") name = defaultName;
  name = name.slice(0, MAX_NAME_LEN);
  let description = scalars.get("description") ?? "";
  if (description === "") return null;
  if (description.length > MAX_DESCRIPTION_LEN) description = description.slice(0, MAX_DESCRIPTION_LEN);
  const shortDescription = scalars.get("short-description") ?? "";
  return {
    name,
    description,
    shortDescription: shortDescription === "" ? null : shortDescription,
    body,
  };
}
