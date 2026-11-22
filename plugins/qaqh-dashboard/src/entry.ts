/**
 * QAQ 插件:项目仪表盘——panel 槽(右栏工作区卡)的首个试点。
 *
 * 数据只经宿主 facade 的 gitx.status(capability "gitx"):daemon 侧解析活动
 * 会话的生效工作区(绑定生效时落 worktree 根)跑只读 git。与 dock 槽的
 * qaqh-git(逐文件清单)不同,这里做一眼可读的总览:分支/同步态/未提交规模
 * 的判读卡。纯 DOM 无框架依赖,配色走壳 token;右栏收起时卡片随宿主卸下
 * (offsetParent=null → 降频轮询)。
 */
import type { GitStatusSnapshot } from "../../../webui/src/lib/transport/index.js";
import type { PluginGitxFacade } from "../../../webui/src/plugins/loader.js";

interface PluginHost {
  gitx?: Pick<PluginGitxFacade, "status">;
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

/** porcelain v2 XY 码 → 三类计数（与 daemon 解析同口径：未跟踪 = index "?"）。 */
function stagedCount(view: GitStatusSnapshot): number {
  return view.files.filter((file) => file.index !== "." && file.index !== "?").length;
}

function unstagedCount(view: GitStatusSnapshot): number {
  return view.files.filter((file) => file.worktree !== "." && file.worktree !== "?").length;
}

function untrackedCount(view: GitStatusSnapshot): number {
  return view.files.filter((file) => file.index === "?").length;
}

export default {
  mount(container: HTMLElement, host: PluginHost): () => void {
    const style = document.createElement("style");
    style.textContent = `
      .qaqh-dash-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
      .qaqh-dash-repo{font-weight:600;font-size:14px;overflow-wrap:anywhere;}
      .qaqh-dash-branch{font-family:ui-monospace,monospace;font-size:11px;color:var(--accent,#8ab4ff);white-space:nowrap;}
      .qaqh-dash-verdict{margin-top:4px;font-size:12px;}
      .qaqh-dash-verdict.ok{color:var(--ok,#75d9a1);}
      .qaqh-dash-verdict.dirty{color:var(--warn,#f5c36d);}
      .qaqh-dash-verdict.bad{color:var(--err,#ff9aa5);}
      .qaqh-dash-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
      .qaqh-dash-chip{padding:1px 8px;border-radius:999px;background:var(--surface-2,#292c31);font-size:11px;}
      .qaqh-dash-chip.sync-warn{color:var(--warn,#f5c36d);}
      .qaqh-dash-chip.sync-behind{color:var(--err,#ff9aa5);}
      .qaqh-dash-head{margin-top:8px;font-size:11px;color:var(--muted,#abb0b8);word-break:break-all;}
      .qaqh-dash-foot{margin-top:6px;font-size:10px;color:var(--muted,#abb0b8);}
    `;
    document.head.append(style);

    const top = el("div", "qaqh-dash-top");
    const repo = el("span", "qaqh-dash-repo", "仪表盘");
    const branch = el("span", "qaqh-dash-branch");
    top.append(repo, branch);
    const verdict = el("div", "qaqh-dash-verdict");
    const chips = el("div", "qaqh-dash-chips");
    const head = el("div", "qaqh-dash-head");
    const foot = el("div", "qaqh-dash-foot");
    container.append(top, verdict, chips, head, foot);

    // 宿主管开合:卡片收起时容器离 DOM,轮询降频(可见 4s,后台 15s)。
    const visible = (): boolean => container.offsetParent != null;

    let disposed = false;
    let timer: number | null = null;

    function chip(text: string, cls = ""): void {
      chips.append(el("span", `qaqh-dash-chip ${cls}`.trimEnd(), text));
    }

    function render(view: GitStatusSnapshot): void {
      chips.replaceChildren();
      head.textContent = "";
      foot.textContent = "";
      const staged = stagedCount(view);
      const unstaged = unstagedCount(view);
      const untracked = untrackedCount(view);
      repo.textContent = repoName(view.source_root);
      branch.textContent = view.branch != null
        ? `⎇ ${view.branch}`
        : view.detached ? view.head_sha?.slice(0, 7) ?? "—" : "⎇ (空仓库)";

      const dirty = staged + unstaged + untracked;
      if (dirty === 0) {
        verdict.className = "qaqh-dash-verdict ok";
        verdict.textContent = "工作区干净";
      } else {
        verdict.className = "qaqh-dash-verdict dirty";
        verdict.textContent = `有 ${dirty} 处未提交改动`;
      }
      if (staged > 0) chip(`暂存 ${staged}`);
      if (unstaged > 0) chip(`未暂存 ${unstaged}`);
      if (untracked > 0) chip(`未跟踪 ${untracked}`);
      if (view.upstream == null) {
        chip("无上游分支", "sync-warn");
      } else {
        if ((view.ahead ?? 0) > 0) chip(`领先 ${view.ahead} 未推送`, "sync-warn");
        if ((view.behind ?? 0) > 0) chip(`落后 ${view.behind}`, "sync-behind");
        if ((view.ahead ?? 0) === 0 && (view.behind ?? 0) === 0) chip(`与 ${view.upstream} 同步`);
      }
      head.textContent = `HEAD ${view.head_sha?.slice(0, 7) ?? "—"}`;
      foot.textContent = `更新于 ${new Date().toLocaleTimeString()} · 只读`;
    }

    /** 失败态：无活动会话（facade 哨兵）/非仓库/RPC 错误都落这条，消息即原因。 */
    function renderError(message: string): void {
      chips.replaceChildren();
      head.textContent = "";
      foot.textContent = "";
      repo.textContent = "仪表盘";
      branch.textContent = "";
      verdict.className = "qaqh-dash-verdict bad";
      verdict.textContent = message;
    }

    async function refresh(): Promise<void> {
      const read = host.gitx?.status;
      if (read == null) {
        renderError("宿主未发放 gitx 能力（检查 manifest.capabilities）");
        return;
      }
      try {
        render(await read());
      } catch (error) {
        renderError(error instanceof Error ? error.message : String(error));
      }
    }

    function schedule(): void {
      if (disposed) return;
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => { void refresh().then(schedule); }, visible() ? OPEN_MS : IDLE_MS);
    }

    void refresh().then(schedule);

    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      style.remove();
      container.textContent = "";
    };
  },
};
