/**
 * 工作区 git 状态（只读壳侧 OS 能力，与 pick_directory / capture_screenshot 同类）。
 *
 * 固定 argv、无 shell、带超时；只读——不 fetch/add/commit/push。
 * 一次 `status --porcelain=v2 --branch` 就拿到分支/上游/ahead-behind/逐文件 XY 码，
 * 不为每个字段各起一个 git 进程。
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { GitCommit, GitFileChange, GitStatusView } from "../../webui/src/lib/git-status.js";

const TIMEOUT_MS = 8000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_UNPUSHED = 50;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      if (error != null) reject(error);
      else resolve(stdout);
    });
  });
}

/** git 的真实原因在 stderr，Error.message 只有 "Command failed"。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
    return error.message;
  }
  return String(error);
}

interface ParsedStatus {
  branch: string;
  head: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileChange[];
  untracked: number;
}

function parsePorcelainV2(text: string): ParsedStatus {
  const out: ParsedStatus = { branch: "", head: "", upstream: null, ahead: null, behind: null, files: [], untracked: 0 };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# branch.oid ")) { out.head = line.slice(13).trim(); continue; }
    if (line.startsWith("# branch.head ")) { out.branch = line.slice(14).trim(); continue; }
    if (line.startsWith("# branch.upstream ")) { out.upstream = line.slice(18).trim(); continue; }
    if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match != null) { out.ahead = Number(match[1]); out.behind = Number(match[2]); }
      continue;
    }
    if (line.startsWith("? ")) {
      out.untracked += 1;
      out.files.push({ path: line.slice(2), index: "?", worktree: "?" });
      continue;
    }
    if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
    const fields = line.split(" ");
    const xy = fields[1] ?? "..";
    // 普通项 8 个前置字段，rename 项多一个 X<score> → 9；路径可含空格，取剩余整段。
    const pathField = fields.slice(line.startsWith("2 ") ? 9 : 8).join(" ");
    out.files.push({ path: pathField.split("\t")[0] ?? pathField, index: xy[0] ?? ".", worktree: xy[1] ?? "." });
  }
  return out;
}

/** workspace 必须是绝对路径；相对路径无从判定属于哪个仓库，直接判错而不是猜 cwd。 */
export async function readGitStatus(workspace: string): Promise<GitStatusView> {
  if (!isAbsolute(workspace)) return { kind: "error", workspace, message: "工作区路径必须是绝对路径" };

  let repoRoot: string;
  try {
    repoRoot = (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    const message = messageOf(error);
    if (/not a git repository/i.test(message)) return { kind: "not-repo", workspace };
    return { kind: "error", workspace, message };
  }

  try {
    const parsed = parsePorcelainV2(await git(repoRoot, ["status", "--porcelain=v2", "--branch"]));
    const unpushed: GitCommit[] = [];
    if (parsed.upstream != null && (parsed.ahead ?? 0) > 0) {
      const log = await git(repoRoot, ["log", `--max-count=${MAX_UNPUSHED}`, "--format=%h%x09%s", "@{u}..HEAD"]);
      for (const line of log.split("\n")) {
        if (line === "") continue;
        const tab = line.indexOf("\t");
        unpushed.push(tab < 0 ? { hash: line, subject: "" } : { hash: line.slice(0, tab), subject: line.slice(tab + 1) });
      }
    }
    return {
      kind: "repo",
      workspace,
      repoRoot,
      branch: parsed.branch,
      head: parsed.head,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged: parsed.files.filter((file) => file.index !== "." && file.index !== "?").length,
      unstaged: parsed.files.filter((file) => file.worktree !== "." && file.worktree !== "?").length,
      untracked: parsed.untracked,
      files: parsed.files,
      unpushed,
    };
  } catch (error) {
    return { kind: "error", workspace, message: messageOf(error) };
  }
}
