/**
 * QAQ 插件：Git 工作区状态（只读）——dock 槽。
 *
 * 取数只经宿主 facade 的 gitStatus（capability "git-status"）：main 侧解析活动
 * 会话的工作区 cwd 并跑只读 git，插件不碰会话注册表、不碰 .git 内部文件。
 * 纯 DOM，无框架依赖；配色走壳 token，主题包换色即跟随。
 * 面板内容渲染进 dock 容器，开合由宿主 PluginDock 负责；不可见时降频轮询。
 */
import type { GitStatusView } from "../../../webui/src/lib/git-status.js";

interface PluginHost {
  gitStatus?: () => Promise<GitStatusView>;
}

const OPEN_MS = 4000;
const IDLE_MS = 15000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function repoName(root: string): string {
  return root.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}

export default {
  mount(container: HTMLElement, host: PluginHost): () => void {
    const style = document.createElement("style");
    style.textContent = `
      .qaqh-git-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
      .qaqh-git-repo{font-weight:600;font-size:13px;}
      .qaqh-git-path{color:var(--muted,#abb0b8);font-size:11px;word-break:break-all;margin-bottom:8px;}
      .qaqh-git-row{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:6px;}
      .qaqh-git-chip{padding:1px 7px;border-radius:999px;background:var(--surface-2,#292c31);}
      .qaqh-git-chip.staged{color:var(--ok,#75d9a1);}
      .qaqh-git-chip.unstaged{color:var(--warn,#f5c36d);}
      .qaqh-git-chip.untracked{color:var(--muted,#abb0b8);}
      .qaqh-git-sec{margin-top:10px;font-weight:600;color:var(--muted,#abb0b8);}
      .qaqh-git-list{margin:4px 0 0;padding:0;list-style:none;max-height:180px;overflow:auto;}
      .qaqh-git-list li{display:flex;gap:8px;padding:1px 0;}
      .qaqh-git-xy{flex:0 0 22px;font-family:ui-monospace,monospace;color:var(--muted,#abb0b8);}
      .qaqh-git-file{word-break:break-all;}
      .qaqh-git-file.staged{color:var(--ok,#75d9a1);}
      .qaqh-git-file.unstaged{color:var(--warn,#f5c36d);}
      .qaqh-git-hash{flex:0 0 62px;font-family:ui-monospace,monospace;color:var(--accent,#8ab4ff);}
      .qaqh-git-empty{color:var(--muted,#abb0b8);}
      .qaqh-git-foot{margin-top:10px;color:var(--muted,#abb0b8);font-size:11px;}
      .qaqh-git-err{color:var(--err,#ff9aa5);word-break:break-all;}
    `;
    document.head.append(style);

    const head = el("div", "qaqh-git-head");
    const repoTitle = el("span", "qaqh-git-repo", "Git");
    const branchLine = el("span", "");
    head.append(repoTitle, branchLine);
    const pathLine = el("div", "qaqh-git-path");
    const counts = el("div", "qaqh-git-row");
    const stagedChip = el("span", "qaqh-git-chip staged");
    const unstagedChip = el("span", "qaqh-git-chip unstaged");
    const untrackedChip = el("span", "qaqh-git-chip untracked");
    counts.append(stagedChip, unstagedChip, untrackedChip);
    const syncLine = el("div", "qaqh-git-row");
    const stateLine = el("div", "qaqh-git-err");
    const filesSec = el("div", "qaqh-git-sec", "改动");
    const filesList = el("ul", "qaqh-git-list");
    const unpushedSec = el("div", "qaqh-git-sec", "未 push 提交");
    const unpushedList = el("ul", "qaqh-git-list");
    const foot = el("div", "qaqh-git-foot");
    container.append(head, pathLine, counts, syncLine, stateLine, filesSec, filesList, unpushedSec, unpushedList, foot);

    // dock 面板合上时容器离 DOM,轮询降频(打开态 4s,后台态 15s)。
    const visible = (): boolean => container.offsetParent != null;

    let disposed = false;
    let timer: number | null = null;

    function render(view: GitStatusView): void {
      stateLine.textContent = "";
      if (view.kind !== "repo") {
        repoTitle.textContent = "Git";
        branchLine.textContent = "";
        pathLine.textContent = view.kind === "no-workspace" ? "没有活动会话，或该会话未绑定工作区" : view.workspace;
        counts.style.display = "none";
        syncLine.textContent = "";
        filesSec.style.display = "none";
        filesList.replaceChildren();
        unpushedSec.style.display = "none";
        unpushedList.replaceChildren();
        stateLine.textContent = view.kind === "error" ? view.message : view.kind === "not-repo" ? "该工作区不是 git 仓库" : "";
        foot.textContent = "";
        return;
      }
      const detached = view.branch === "(detached)";
      const label = detached ? `${view.head.slice(0, 7)} (detached)` : view.branch;
      repoTitle.textContent = repoName(view.repoRoot);
      branchLine.textContent = detached ? label : `⎇ ${view.branch}`;
      pathLine.textContent = view.repoRoot;
      counts.style.display = "";
      stagedChip.textContent = `暂存 ${view.staged}`;
      unstagedChip.textContent = `未暂存 ${view.unstaged}`;
      untrackedChip.textContent = `未跟踪 ${view.untracked}`;
      syncLine.textContent = view.upstream == null
        ? "无上游分支——未 push 无从比较（git push -u 建立跟踪）"
        : `上游 ${view.upstream} · 领先 ${view.ahead ?? 0} · 落后 ${view.behind ?? 0}`;

      filesSec.style.display = "";
      filesList.replaceChildren(...view.files.map((file) => {
        const li = el("li");
        const untracked = file.index === "?";
        const cls = untracked ? "" : file.index !== "." ? "staged" : "unstaged";
        li.append(el("span", "qaqh-git-xy", untracked ? "?" : `${file.index}${file.worktree}`), el("span", `qaqh-git-file ${cls}`, file.path));
        return li;
      }));
      if (view.files.length === 0) filesList.append(el("li", "qaqh-git-empty", "工作区干净"));

      const showUnpushed = view.upstream != null && (view.ahead ?? 0) > 0;
      unpushedSec.style.display = showUnpushed ? "" : "none";
      unpushedList.replaceChildren(...view.unpushed.map((commit) => {
        const li = el("li");
        li.append(el("span", "qaqh-git-hash", commit.hash), el("span", "qaqh-git-file", commit.subject));
        return li;
      }));
      foot.textContent = `更新于 ${new Date().toLocaleTimeString()} · 只读，不会改动仓库`;
    }

    async function refresh(): Promise<void> {
      const read = host.gitStatus;
      if (read == null) {
        render({ kind: "error", workspace: "", message: "宿主未发放 git-status 能力（检查 manifest.capabilities）" });
        return;
      }
      try {
        render(await read());
      } catch (error) {
        render({ kind: "error", workspace: "", message: error instanceof Error ? error.message : String(error) });
      }
    }

    function schedule(): void {
      if (disposed) return;
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => { void refresh().then(schedule); }, visible() ? OPEN_MS : IDLE_MS);
    }

    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);

    void refresh().then(schedule);

    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      style.remove();
      container.textContent = "";
    };
  },
};
