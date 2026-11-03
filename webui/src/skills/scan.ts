/** Renderer view of the daemon's authoritative `skills.catalog` service. */
import { createSignal } from "solid-js";
import { transport } from "../lib/transport";
import { workspaceCatalog, type SidebarWorkspace } from "../tabs/store";

export type SkillScope = "project" | "user";
export type SkillEntry = {
  name: string;
  description: string;
  shortDescription: string | null;
  /** The catalog endpoint returns metadata, not skill bodies. */
  body?: string;
  workspace: string;
  path: string;
  scope: SkillScope;
  origin: string;
  shadowed: boolean;
};
export type SkillScanIssue = { root: string; message: string; forbidden: boolean };
export type SkillIssueScope = "project" | "user";
export type SkillIssue = SkillScanIssue & { scope: SkillIssueScope };
export type UserRootState = { label: string; path: string; exists: boolean };
export type SkillsScanState = {
  status: "idle" | "scanning" | "done";
  project: SkillEntry[];
  user: SkillEntry[];
  issues: SkillIssue[];
  userRoots: UserRootState[];
  daemonUnreachable: boolean;
  userScanUnsupported: boolean;
};

const emptyState = (): SkillsScanState => ({
  status: "idle", project: [], user: [], issues: [], userRoots: [],
  daemonUnreachable: false, userScanUnsupported: false,
});
const [scanState, setScanState] = createSignal<SkillsScanState>(emptyState());
export { scanState };

const tailName = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** Query each registered workspace so the backend can apply its cwd-aware catalog rules. */
export async function rescanSkills(): Promise<void> {
  setScanState({ ...emptyState(), status: "scanning" });
  const workspaces: SidebarWorkspace[] = workspaceCatalog();
  const scopes = workspaces.length > 0 ? workspaces : [{ id: "default", path: "", title: "当前目录", order: 0 }];
  const project: SkillEntry[] = [];
  const user: SkillEntry[] = [];
  const issues: SkillIssue[] = [];
  const seenPaths = new Set<string>();
  let succeeded = false;

  for (const workspace of scopes) {
    const cwd = workspace.path || null;
    const label = workspace.title || (workspace.path ? tailName(workspace.path) : "当前目录");
    try {
      const result = await transport.query("skills.catalog", { cwd });
      succeeded = true;
      for (const item of result.skills) {
        if (seenPaths.has(item.path)) continue;
        seenPaths.add(item.path);
        const entry: SkillEntry = {
          name: item.name,
          description: item.description,
          shortDescription: null,
          workspace: label,
          path: item.path,
          scope: item.scope === "user" ? "user" : "project",
          origin: item.origin,
          shadowed: false,
        };
        (entry.scope === "user" ? user : project).push(entry);
      }
      for (const diagnostic of result.diagnostics) {
        issues.push({ root: diagnostic.path || label, message: `${diagnostic.severity}: ${diagnostic.message}`, forbidden: false, scope: "project" });
      }
    } catch (cause) {
      const message = messageOf(cause);
      issues.push({ root: label, message, forbidden: /FORBIDDEN|not allowed/i.test(message), scope: "project" });
    }
  }

  project.sort((a, b) => a.name.localeCompare(b.name));
  user.sort((a, b) => a.name.localeCompare(b.name));
  setScanState({
    status: "done",
    project,
    user,
    issues,
    userRoots: [],
    daemonUnreachable: !succeeded,
    userScanUnsupported: false,
  });
}
