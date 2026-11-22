/**
 * QAQ 插件：Worktree 管理——dock 槽。
 *
 * 全部动作走宿主 facade 的 gitx 面（capability "gitx"）：清单/建/删/绑/解绑
 * 直达 daemon,视角与 session 缺省注入活动会话（插件不碰会话注册表）。
 * ADR-0041 语义：managed worktree 由注册表纳管（CAS 绑定,一会话至多一个）;
 * missing_dir 是失效态,直接强制清登记（prune）;unmanaged_paths 只读展示,
 * 不享受自动放行。纯 DOM 无框架依赖,配色走壳 token;面板收起时降频轮询。
 */
import type {
  GitxWorktreeListResult,
  WorktreeView,
} from "../../../webui/src/lib/transport/index.js";
import type { PluginGitxFacade } from "../../../webui/src/plugins/loader.js";

interface PluginHost {
  gitx?: Pick<
    PluginGitxFacade,
    "worktreeList" | "worktreeCreate" | "worktreeRemove" | "worktreeBind" | "worktreeUnbind" | "activeSessionId"
  >;
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
      .qaqh-wt-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
      .qaqh-wt-title{font-weight:600;font-size:13px;}
      .qaqh-wt-repo{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted,#abb0b8);}
      .qaqh-wt-path{color:var(--muted,#abb0b8);font-size:11px;word-break:break-all;margin-bottom:8px;}
      .qaqh-wt-sec{margin-top:12px;font-weight:600;color:var(--muted,#abb0b8);}
      .qaqh-wt-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;}
      .qaqh-wt-row{border:1px solid var(--border,#3a3d44);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;}
      .qaqh-wt-row.dead{opacity:.62;}
      .qaqh-wt-row-top{display:flex;align-items:center;gap:8px;}
      .qaqh-wt-branch{font-family:ui-monospace,monospace;color:var(--accent,#8ab4ff);font-weight:600;}
      .qaqh-wt-tag{padding:0 7px;border-radius:999px;background:var(--surface-2,#292c31);font-size:10px;}
      .qaqh-wt-tag.owner{color:var(--ok,#75d9a1);}
      .qaqh-wt-tag.dead{color:var(--err,#ff9aa5);}
      .qaqh-wt-meta{font-size:11px;color:var(--muted,#abb0b8);word-break:break-all;display:flex;gap:8px;}
      .qaqh-wt-hash{font-family:ui-monospace,monospace;}
      .qaqh-wt-actions{display:flex;gap:6px;flex-wrap:wrap;}
      .qaqh-wt-btn{padding:1px 9px;border-radius:6px;border:1px solid var(--border,#3a3d44);background:transparent;color:var(--fg,#e2e4e8);cursor:pointer;font-size:11px;}
      .qaqh-wt-btn:hover{background:var(--surface-2,#292c31);}
      .qaqh-wt-btn.confirm{color:var(--err,#ff9aa5);border-color:var(--err,#ff9aa5);}
      .qaqh-wt-btn:disabled{opacity:.45;cursor:default;}
      .qaqh-wt-form{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
      .qaqh-wt-form-row{display:flex;gap:6px;align-items:center;}
      .qaqh-wt-input{flex:1;min-width:0;padding:3px 8px;border-radius:6px;border:1px solid var(--border,#3a3d44);background:var(--surface-2,#292c31);color:var(--fg,#e2e4e8);font-family:ui-monospace,monospace;font-size:11px;}
      .qaqh-wt-form label{font-size:11px;color:var(--muted,#abb0b8);display:flex;gap:4px;align-items:center;flex:0 0 auto;}
      .qaqh-wt-unmanaged{margin:4px 0 0;padding:0;list-style:none;}
      .qaqh-wt-unmanaged li{font-family:ui-monospace,monospace;font-size:10px;color:var(--muted,#abb0b8);word-break:break-all;padding:1px 0;}
      .qaqh-wt-empty{color:var(--muted,#abb0b8);}
      .qaqh-wt-err{color:var(--err,#ff9aa5);word-break:break-all;margin-top:8px;font-size:11px;}
      .qaqh-wt-foot{margin-top:10px;color:var(--muted,#abb0b8);font-size:11px;}
    `;
    document.head.append(style);

    const head = el("div", "qaqh-wt-head");
    const title = el("span", "qaqh-wt-title", "Worktree");
    const repo = el("span", "qaqh-wt-repo");
    head.append(title, repo);
    const pathLine = el("div", "qaqh-wt-path");
    const stateLine = el("div", "qaqh-wt-err");
    const createSec = el("div", "qaqh-wt-sec", "新建 worktree");
    const form = el("div", "qaqh-wt-form");
    const branchRow = el("div", "qaqh-wt-form-row");
    const branchInput = document.createElement("input");
    branchInput.className = "qaqh-wt-input";
    branchInput.placeholder = "分支名,如 feat/worktree-ui";
    branchRow.append(el("label", "", "分支"), branchInput);
    const baseRow = el("div", "qaqh-wt-form-row");
    const baseInput = document.createElement("input");
    baseInput.className = "qaqh-wt-input";
    baseInput.placeholder = "缺省 = HEAD";
    baseRow.append(el("label", "", "基点"), baseInput);
    const attachRow = el("div", "qaqh-wt-form-row");
    const attachCheck = document.createElement("input");
    attachCheck.type = "checkbox";
    attachCheck.checked = true;
    attachCheck.id = "qaqh-wt-attach";
    const attachLabel = el("label", "", "建完绑定活动会话");
    attachLabel.htmlFor = "qaqh-wt-attach";
    attachLabel.prepend(attachCheck);
    const createBtn = el("button", "qaqh-wt-btn", "创建");
    createBtn.type = "button";
    attachRow.append(attachLabel, createBtn);
    form.append(branchRow, baseRow, attachRow);
    const listSec = el("div", "qaqh-wt-sec", "Managed worktree");
    const list = el("ul", "qaqh-wt-list");
    const unmanagedSec = el("div", "qaqh-wt-sec", "未纳管（手工 worktree,只读）");
    const unmanagedList = el("ul", "qaqh-wt-unmanaged");
    const foot = el("div", "qaqh-wt-foot");
    container.append(head, pathLine, stateLine, createSec, form, listSec, list, unmanagedSec, unmanagedList, foot);

    // dock 面板合上时容器离 DOM,轮询降频(打开态 4s,后台态 15s)。
    const visible = (): boolean => container.offsetParent != null;

    let disposed = false;
    let timer: number | null = null;
    /** 最近一次清单数据：动作开合只重绘按钮,不重新拉 RPC。 */
    let lastData: GitxWorktreeListResult | null = null;
    /** 活动会话 seed(facade 解析):判定行内绑定是否属于活动会话。 */
    let activeSeedId: string | null = null;
    let busy = false;
    /** 两步删除确认与 dirty 后的强制升级,按 worktree id 记忆,轮询重绘保留。 */
    let pendingRemove: string | null = null;
    let forceNext: string | null = null;

    function redraw(): void {
      stateLine.textContent = "";
      if (lastData == null) return;
      const data = lastData;
      listSec.style.display = "";
      const sourceRoot = data.worktrees[0]?.source_root ?? "";
      repo.textContent = sourceRoot === "" ? "" : repoName(sourceRoot);
      pathLine.textContent = sourceRoot;
      if (pendingRemove != null && !data.worktrees.some((view) => view.id === pendingRemove)) pendingRemove = null;
      if (forceNext != null && !data.worktrees.some((view) => view.id === forceNext)) forceNext = null;

      list.replaceChildren(...data.worktrees.map(renderRow));
      if (data.worktrees.length === 0) {
        list.append(el("li", "qaqh-wt-empty", "注册表为空——用上方表单建第一个 worktree"));
      }
      unmanagedSec.style.display = data.unmanaged_paths.length === 0 ? "none" : "";
      unmanagedList.replaceChildren(...data.unmanaged_paths.map((path) => el("li", "", path)));
      foot.textContent = `更新于 ${new Date().toLocaleTimeString()} · managed ${data.worktrees.length} · unmanaged ${data.unmanaged_paths.length}`;
    }

    function ownerTag(view: WorktreeView): HTMLElement {
      if (view.missing_dir) return el("span", "qaqh-wt-tag dead", "目录已失效");
      if (view.owner_session_id == null) return el("span", "qaqh-wt-tag", "空闲");
      const mine = view.owner_session_id === activeSeedId;
      return el("span", `qaqh-wt-tag ${mine ? "owner" : ""}`.trimEnd(), mine ? "本会话绑定" : "他会话绑定");
    }

    function actionButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
      const button = el("button", `qaqh-wt-btn ${className}`.trimEnd(), label);
      button.type = "button";
      button.disabled = busy;
      button.addEventListener("click", onClick);
      return button;
    }

    function renderRow(view: WorktreeView): HTMLElement {
      const row = el("li", `qaqh-wt-row${view.missing_dir ? " dead" : ""}`);
      const top = el("div", "qaqh-wt-row-top");
      top.append(el("span", "qaqh-wt-branch", view.branch), ownerTag(view));
      row.append(top);
      const meta = el("div", "qaqh-wt-meta");
      meta.append(el("span", "qaqh-wt-hash", view.head_sha.slice(0, 7)), el("span", "", view.path));
      row.append(meta);

      const actionsRow = el("div", "qaqh-wt-actions");
      if (view.missing_dir) {
        // 失效态 = prune:目录已不在,强制清登记(两步确认)。
        if (pendingRemove === view.id) {
          actionsRow.append(actionButton("确认清理登记", "confirm", () => { void runRemove(view, true); }));
        } else {
          actionsRow.append(actionButton("清理登记(prune)", "", () => { pendingRemove = view.id; redraw(); }));
        }
        return row;
      }
      if (view.owner_session_id == null) {
        actionsRow.append(actionButton("绑定活动会话", "", () => { void runBind(view); }));
      } else if (view.owner_session_id === activeSeedId) {
        actionsRow.append(actionButton("解绑", "", () => { void runUnbind(); }));
      }
      if (forceNext === view.id) {
        // 上次删除撞了 dirty;下一步确认即 force。
        actionsRow.append(actionButton("确认强制删除(force)", "confirm", () => { void runRemove(view, true); }));
      } else if (pendingRemove === view.id) {
        actionsRow.append(actionButton("确认删除", "confirm", () => { void runRemove(view, false); }));
      } else {
        actionsRow.append(actionButton("删除", "", () => { pendingRemove = view.id; redraw(); }));
      }
      row.append(actionsRow);
      return row;
    }

    function renderError(message: string): void {
      repo.textContent = "";
      pathLine.textContent = "";
      listSec.style.display = "none";
      list.replaceChildren();
      unmanagedSec.style.display = "none";
      unmanagedList.replaceChildren();
      stateLine.textContent = message;
      foot.textContent = "";
    }

    async function refresh(): Promise<void> {
      const gitx = host.gitx;
      if (gitx?.worktreeList == null) {
        renderError("宿主未发放 gitx 能力（检查 manifest.capabilities）");
        return;
      }
      try {
        const [data, seed] = await Promise.all([gitx.worktreeList(), gitx.activeSessionId()]);
        lastData = data;
        activeSeedId = seed;
        redraw();
      } catch (error) {
        renderError(error instanceof Error ? error.message : String(error));
      }
    }

    async function runAction(next: () => Promise<string | null>): Promise<void> {
      if (busy) return;
      busy = true;
      redraw();
      try {
        const failure = await next();
        stateLine.textContent = failure ?? "";
      } catch (error) {
        stateLine.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        await refresh();
      }
    }

    async function runCreate(): Promise<void> {
      const create = host.gitx?.worktreeCreate;
      if (create == null) return;
      const branchName = branchInput.value.trim();
      if (branchName === "") { stateLine.textContent = "分支名不能为空"; return; }
      const baseRef = baseInput.value.trim();
      await runAction(async () => {
        await create({
          branch_name: branchName,
          base_ref: baseRef === "" ? undefined : baseRef,
          attach: attachCheck.checked,
        });
        branchInput.value = "";
        baseInput.value = "";
        attachCheck.checked = true;
        return null;
      });
    }

    async function runBind(view: WorktreeView): Promise<void> {
      const bind = host.gitx?.worktreeBind;
      if (bind == null) return;
      await runAction(async () => {
        await bind({ worktree_id: view.id });
        return null;
      });
    }

    async function runUnbind(): Promise<void> {
      const unbind = host.gitx?.worktreeUnbind;
      if (unbind == null) return;
      await runAction(async () => {
        const result = await unbind();
        return result.unbound ? null : "该绑定不属于活动会话,未变更";
      });
    }

    async function runRemove(view: WorktreeView, force: boolean): Promise<void> {
      const remove = host.gitx?.worktreeRemove;
      if (remove == null) return;
      pendingRemove = null;
      await runAction(async () => {
        try {
          await remove({ worktree_id: view.id, force });
          forceNext = null;
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 引擎对未提交变更拒绝删除;提示用户给 force,而不是死循环。
          if (!force && /is dirty/i.test(message)) forceNext = view.id;
          return null;
        }
      });
    }

    createBtn.addEventListener("click", () => { void runCreate(); });

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
