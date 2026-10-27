/**
 * Skills 目录扫描:项目级(工作区) + 用户级(宿主)。
 *
 * 两层的读盘面不同,因为 daemon 的白名单不同:
 *
 * 1. **项目级**(workspace/.qaqh|.agents|skills/名字/SKILL.md)
 *    走 transport.rpc → Tauri 宿主 SERVICE_METHODS 白名单(已放行 fs.list/fs.read)
 *    → daemon 的 fs.list/fs.read(service.rs:421-434;fs.* 是 daemon MethodInfo 表里的
 *    READ,requires_session=false——路径守卫全在 allowed_roots:数据根 + UI 注册工作区 +
 *    各会话 cwd,fs_git.rs:28-48)。所以:
 *     - 只扫 UI 工作区注册表(workspaceCatalog)下的 skills/名字/SKILL.md;
 *     - E:\myXCode 这类未注册目录会被 FORBIDDEN 拒——按工作区分桶展示提示,
 *       明说「注册为工作区即可读」,不吞错;
 *     - 宿主 service_rpc 对 fs.* 需要活动 seed(commands.rs:service_requires_session
 *       没豁免 fs.*)并自动注入 scope_session_id——零会话时整个扫描直接失败,
 *       也按「演示数据」兜底。
 *
 * 2. **用户级**(~/.qaqh/skills、~/.agents/skills)
 *    **读不到**——这两个根不在上面那份 allowed_roots 里,daemon 的 fs.read 一律
 *    FORBIDDEN。daemon 自己扫得到(qaqh-skills 的 discovery roots),但那份 catalog
 *    只经 Ringing 控制事件 `SkillsUpdated` 出去,而它在 v2 投影里没有对应 fact
 *    (ringing/pending_store.rs:310),webview 收不到。于是改走宿主命令
 *    `skills_user_scan`(src-tauri/src/skills.rs,同一份规则),这里只做解析与展示。
 *
 * 两层的目录名与优先级都与 qaqh-skills 对齐:项目 `.qaqh` > `.agents` > `skills`,
 * 用户 `.qaqh` > `.agents`,同名 skill 只保留优先级最高者(项目优先于用户,
 * lib.rs:195-207)。
 */
import { createSignal } from "solid-js";
import { transport } from "../lib/transport";
import { workspaceCatalog, type SidebarWorkspace } from "../tabs/store";
import { parseSkillFrontmatter, type ParsedSkillFrontmatter } from "./parse";

/** skill 的发现范围:`project` = 工作区目录;`user` = home 下的用户级目录。 */
export type SkillScope = "project" | "user";

/** 一条 skill 的展示模型:frontmatter + 来源。 */
export type SkillEntry = {
  /** SKILL.md frontmatter 的 name(缺省回退目录名)。 */
  name: string;
  description: string;
  shortDescription: string | null;
  /** frontmatter 后的 Markdown 正文(原样)。 */
  body: string;
  /** 发现它的根:项目级是工作区标题,用户级是 `~/.agents/skills` 形态的标签。 */
  workspace: string;
  /** daemon / 宿主侧绝对路径。 */
  path: string;
  scope: SkillScope;
  /**
   * 同名 skill 被更高优先级的根先占(项目 > 用户,`qaqh-skills/src/lib.rs:209-227`
   * 的 `seen_names`)。被覆盖的条目在 daemon 侧根本不进 catalog,这里照实标出来,
   * 而不是悄悄从列表里删掉——否则「我明明放了 SKILL.md」无从解释。
   */
  shadowed: boolean;
};

/** 按根分桶的失败(FORBIDDEN 提示注册为工作区 / 其他 IO 错误)。 */
export type SkillScanIssue = {
  root: string;
  message: string;
  /** true = 路径在 allowed_roots 外(未注册为 UI 工作区)。 */
  forbidden: boolean;
};

/** 问题的来源层:项目级(daemon fs.*)还是用户级(宿主扫描)。 */
export type SkillIssueScope = "project" | "user";

/** 一条待展示的问题。`scope` 决定它挂在哪一组下面——用户级的问题列在用户级组里,
 *  否则「~/.agents/skills 读不了」会被误读成工作区的问题。 */
export type SkillIssue = SkillScanIssue & { scope: SkillIssueScope };

/** 一个用户级发现根的状态(宿主侧结果,含「目录不存在」)。 */
export type UserRootState = {
  /** `~/.agents/skills` 形态的展示标签。 */
  label: string;
  path: string;
  /** 目录存在且可读。 */
  exists: boolean;
};

export type SkillsScanState = {
  status: "idle" | "scanning" | "done";
  /** 项目级:UI 工作区注册表下的 skill。 */
  project: SkillEntry[];
  /** 用户级:home 下的 skill(宿主扫描)。 */
  user: SkillEntry[];
  /** 两层的诊断,带 `scope` 分桶展示。 */
  issues: SkillIssue[];
  /** 用户级发现根(无论有没有 skill 都要展示,才知道该往哪放)。 */
  userRoots: UserRootState[];
  /** daemon 完全不可达(演示数据兜底的唯一触发)。 */
  daemonUnreachable: boolean;
  /** 宿主不支持 `skills_user_scan`(旧壳,或纯浏览器预览桥未接线)。 */
  userScanUnsupported: boolean;
};

type FsEntry = { name: string; path: string; is_dir: boolean; is_file: boolean };

/** daemon fs.list 返回裸数组(service.rs:417 Value::Array)。 */
async function fsList(path: string): Promise<FsEntry[]> {
  const value = await transport.rpc<unknown>("fs.list", { path, scope_session_id: null });
  if (!Array.isArray(value)) throw new Error("fs.list 返回了非数组(宿主与 daemon 版本不匹配?)");
  return value as FsEntry[];
}

async function fsRead(path: string, maxBytes = 512 * 1024): Promise<string> {
  const value = await transport.rpc<{ content?: string; truncated?: boolean }>("fs.read", {
    path,
    max_bytes: maxBytes,
    scope_session_id: null,
  });
  if (typeof value?.content !== "string") throw new Error("fs.read " + path + ": 返回缺 content");
  return value.content;
}

const tailName = (path: string): string =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const isForbidden = (message: string): boolean => /FORBIDDEN|not allowed/i.test(message);

/** 项目级发现根,顺序即优先级(与 `qaqh-skills` 的 discovery_roots 同序)。 */
const PROJECT_ROOTS = [".qaqh/skills", ".agents/skills", "skills"];

/**
 * 扫一个工作区下的 skills 目录(三层:qaqh-skills 的 discovery roots 同形项目目录)。
 */
async function scanRoot(
  root: string,
  label: string,
  skills: SkillEntry[],
  issues: SkillIssue[],
): Promise<void> {
  // 先探根:工作区根被移走/FORBIDDEN 时整根出诊断,不逐目录刷错误。
  try {
    await fsList(root);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    issues.push({ root: label, message, forbidden: isForbidden(message), scope: "project" });
    return;
  }
  for (const skillsRoot of PROJECT_ROOTS) {
    const fullRoot = root.replace(/[\\/]+$/, "") + "/" + skillsRoot;
    let dirs: FsEntry[];
    try {
      // fs.list 对不存在的目录报 OS 错——按「没有这个目录」静默跳过。
      dirs = (await fsList(fullRoot)).filter((entry) => entry.is_dir);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/FORBIDDEN|not allowed|cannot find|系统找不到|No such/i.test(message)) {
        issues.push({ root: label + "/" + skillsRoot, message, forbidden: isForbidden(message), scope: "project" });
      }
      continue;
    }
    for (const dir of dirs) {
      const dirPath = dir.path.replace(/[\\/]+$/, "");
      const skillMd = dirPath + "/SKILL.md";
      try {
        const content = await fsRead(skillMd);
        const parsed: ParsedSkillFrontmatter | null = parseSkillFrontmatter(content, dir.name);
        if (parsed == null) {
          issues.push({ root: label + "/" + dir.name, message: "SKILL.md 缺 description 或 frontmatter 格式无效", forbidden: false, scope: "project" });
          continue;
        }
        skills.push({
          name: parsed.name,
          description: parsed.description,
          shortDescription: parsed.shortDescription,
          body: parsed.body,
          workspace: label,
          path: skillMd,
          scope: "project",
          shadowed: false,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        issues.push({ root: label + "/" + dir.name, message, forbidden: isForbidden(message), scope: "project" });
      }
    }
  }
}

/**
 * 用户级 skills:宿主命令读 `~/.qaqh/skills` 与 `~/.agents/skills`。
 *
 * 宿主回的是原始文件(路径 + 正文),frontmatter 解析仍走同一份 `parseSkillFrontmatter`
 * ——两层 skill 的展示形状必须一致,否则卡片会出现两套字段。
 */
async function scanUserSkills(
  skills: SkillEntry[],
  issues: SkillIssue[],
  roots: UserRootState[],
): Promise<boolean> {
  let wire: Awaited<ReturnType<typeof transport.userSkills>>;
  try {
    wire = await transport.userSkills();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // 旧壳没有这条命令(Tauri 的报错是 `Command skills_user_scan not found`)→ 说清楚
    // 「这一版壳读不了用户级」,不当成扫描失败。不按命令名匹配:真失败的消息里也会
    // 带命令名,那会把「读盘炸了」误报成「壳太旧」。
    if (/not allowed|not found|unknown command/i.test(message)) return false;
    issues.push({ root: "用户级 skills", message, forbidden: false, scope: "user" });
    return true;
  }
  for (const root of wire.roots ?? []) {
    roots.push({ label: root.label, path: root.path, exists: root.exists });
  }
  for (const file of wire.skills ?? []) {
    const dirName = tailName(file.path.replace(/[\\/]+SKILL\.md$/i, ""));
    const parsed = parseSkillFrontmatter(file.content, dirName);
    const root = (wire.roots ?? []).find((candidate) => candidate.path === file.root);
    const label = root?.label ?? file.root;
    if (parsed == null) {
      issues.push({ root: label + "/" + dirName, message: "SKILL.md 缺 description 或 frontmatter 格式无效", forbidden: false, scope: "user" });
      continue;
    }
    skills.push({
      name: parsed.name,
      description: parsed.description,
      shortDescription: parsed.shortDescription,
      body: parsed.body,
      workspace: label,
      path: file.path,
      scope: "user",
      shadowed: false,
    });
  }
  for (const diagnostic of wire.diagnostics ?? []) {
    issues.push({ root: diagnostic.path, message: diagnostic.message, forbidden: false, scope: "user" });
  }
  return true;
}

/**
 * 同名 skill 的去重(与 `qaqh-skills::discover_roots` 的 `seen_names` 同序):
 * 项目级先占,被覆盖的标 `shadowed` 而不删除。
 */
export function applyShadowing(project: SkillEntry[], user: SkillEntry[]): void {
  const seen = new Set(project.map((skill) => skill.name));
  for (const skill of user) {
    if (seen.has(skill.name)) skill.shadowed = true;
    else seen.add(skill.name);
  }
}

/** 内置演示数据:daemon 不可达时的 UI 兜底,形状与真扫描一致。 */
function demoSkills(): SkillEntry[] {
  return [
    {
      name: "skill-creator",
      description: "Create or update a Codex skill with appropriately scoped instructions and any needed supporting resources. (演示数据)",
      shortDescription: "Create or update a skill",
      body: "# Skill Creator\n\nCreate skills that give Codex useful, non-obvious guidance without constraining unrelated work.\n\n## Core Principles\n\n**Assume the agent is already capable.** Include only information that changes its decisions or improves its work.",
      workspace: "演示",
      path: "demo://skill-creator/SKILL.md",
      scope: "project",
      shadowed: false,
    },
    {
      name: "openai-docs",
      description: "Use for OpenAI APIs/products and ChatGPT Work; also for model choice/migration, prompting, SDKs, Responses, Realtime, agents, evals. (演示数据)",
      shortDescription: "Codex models/pricing, scheduled tasks, skills, settings, setup, troubleshooting.",
      body: "# OpenAI Docs\n\nProvide current, cited product, API, model, and guidance. Read zero or one primary reference.",
      workspace: "演示",
      path: "demo://openai-docs/SKILL.md",
      scope: "project",
      shadowed: false,
    },
  ];
}

const [scanState, setScanState] = createSignal<SkillsScanState>({
  status: "idle",
  project: [],
  user: [],
  issues: [],
  userRoots: [],
  daemonUnreachable: false,
  userScanUnsupported: false,
});

export { scanState };

/** 全量重扫:遍历 UI 工作区注册表 + 宿主用户级扫描。挂在 ToolsPage 挂载/手动刷新上。 */
export async function rescanSkills(): Promise<void> {
  setScanState({
    status: "scanning",
    project: [],
    user: [],
    issues: [],
    userRoots: [],
    daemonUnreachable: false,
    userScanUnsupported: false,
  });
  const workspaces: SidebarWorkspace[] = workspaceCatalog();
  const project: SkillEntry[] = [];
  const user: SkillEntry[] = [];
  const issues: SkillIssue[] = [];
  const userRoots: UserRootState[] = [];

  // 用户级与项目级互不依赖:一个读宿主、一个读 daemon,并行发。
  const userScan = scanUserSkills(user, issues, userRoots);

  // 宿主不可达(Tauri 之外 / daemon 未连):整个 rpc 面都会抛——转演示数据。
  let daemonUnreachable = false;
  try {
    await transport.rpc("daemon.version", {});
  } catch {
    daemonUnreachable = true;
  }
  if (!daemonUnreachable) {
    for (const workspace of workspaces) {
      await scanRoot(workspace.path, workspace.title || tailName(workspace.path), project, issues);
    }
  }
  const userScanSupported = await userScan;

  if (daemonUnreachable) {
    setScanState({
      status: "done",
      project: demoSkills(),
      user,
      issues,
      userRoots,
      daemonUnreachable: true,
      userScanUnsupported: !userScanSupported,
    });
    return;
  }
  project.sort((a, b) => a.name.localeCompare(b.name));
  user.sort((a, b) => a.name.localeCompare(b.name));
  applyShadowing(project, user);
  setScanState({
    status: "done",
    project,
    user,
    issues,
    userRoots,
    daemonUnreachable,
    userScanUnsupported: !userScanSupported,
  });
}