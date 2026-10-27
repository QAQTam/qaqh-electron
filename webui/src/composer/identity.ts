/**
 * 输入区身份行的数据来源(spec §1.5):只读、只摆**已经接线**的三项。
 *
 * 与输入框工具条上的「新建会话工作区」选择器不是一回事——这里说的是**当前会话**
 * 跑在哪个工作区,那一处是**接下来新建**的目标,所以两者不合并。
 */
import { createSignal } from "solid-js";
import { daemonLanStatus } from "../lib/pairing";
import { isTauriRuntime } from "../lib/transport/backend";
import { sessionCatalog, workspaceCatalog } from "../tabs/store";

/** 局域网面是否开着;null = 未知(非桌面壳或还没读到),身份行不显示这一项。 */
const [lanActive, setLanActive] = createSignal<boolean | null>(null);
export { lanActive };

/**
 * 读局域网判据。开局读一次即可:开启/关闭局域网都要重启 daemon,而那只能
 * 从设置页发起——那里的开关自己会回读状态。
 */
export async function refreshLanStatus(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const status = await daemonLanStatus();
    setLanActive(status.active === true);
  } catch {
    // 读不到就留 null:身份行宁可少一项,不猜。
  }
}

/** 路径尾段(与侧栏分组同名规则一致):`E:\code\qaqh\` → `qaqh`。 */
export function tailName(path: string): string {
  const value = path.replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

/**
 * 当前会话的工作区名。目录项还没到(首帧/新建)时返回 null,由调用方隐藏,
 * 而不是显示「未分组」——那会把「还不知道」说成「没有归属」。
 */
export function sessionWorkspaceName(seed: string): string | null {
  const entry = sessionCatalog().find((item) => String(item.session_id) === seed);
  if (entry == null) return null;
  const workspace = workspaceCatalog().find((item) => item.id === entry.workspace_id);
  if (workspace != null) return workspace.title || tailName(workspace.path);
  return typeof entry.cwd === "string" && entry.cwd !== "" ? tailName(entry.cwd) : null;
}
