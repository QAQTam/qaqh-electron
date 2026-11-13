/**
 * 工作区 git 状态的线形契约（纯类型，零运行时依赖）。
 *
 * 生产方 src/main/git-status.ts，消费方 webui/src/plugins/loader.ts 的 facade，
 * 两侧 import type 共用这一份——与 src/main/types.ts 引用 webui DTO 同纪律，
 * 不留第二份形状。git 子进程只在 main 跑：daemon 服务面没有 vcs 方法，
 * 渲染层没有 Node。
 */

/** porcelain v2 的 XY 双码：index = 暂存区态，worktree = 工作区态；未跟踪为 "?"。 */
export interface GitFileChange {
  path: string;
  index: string;
  worktree: string;
}

export interface GitCommit {
  hash: string;
  subject: string;
}

/** ahead/behind 为 null = 没有上游，无从比较（不是 0）。 */
export type GitStatusView =
  | {
      kind: "repo";
      workspace: string;
      repoRoot: string;
      /** detached 时为 "(detached)"，此时看 head。 */
      branch: string;
      head: string;
      upstream: string | null;
      ahead: number | null;
      behind: number | null;
      staged: number;
      unstaged: number;
      untracked: number;
      files: GitFileChange[];
      unpushed: GitCommit[];
    }
  | { kind: "no-workspace" }
  | { kind: "not-repo"; workspace: string }
  | { kind: "error"; workspace: string; message: string };
