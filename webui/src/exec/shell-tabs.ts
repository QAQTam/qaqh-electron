/**
 * 用户 shell 标签页状态机（Windows Terminal 风格）。
 *
 * 与旧设计的分界（2026-11-18 裁定）：shell 的生命周期**归本 store，不归 DOM**。
 * 旧的 ShellTerminal 在 onSettled cleanup 里发 `shell.close`，于是切会话标签
 * （App.tsx 非活动标签卸载 DOM）或换壳档位都会把正在编译的 shell 杀掉。
 * 现在只有显式关标签才 `shell.close`；DOM 卸载/隐藏只 `shell.detach`（退订，
 * 后端 D5「断联不 kill」），所以「前台编译、后台编译」能同时活着。
 *
 * `+` 用 lastUsedKind（持久化到 prefs.json），下拉选档会顺带更新它——与
 * Windows Terminal 的「新标签默认上次用的 profile」同律。
 */
import { createSignal } from "solid-js";
import { desktopHost } from "../lib/desktop-host";
import { transport } from "../lib/transport";
import { prefGet, prefSet } from "../lib/prefs";
import { newSessionCwd } from "../tabs/store";
import { toast } from "../ui/toast";

/** `shell.open` 闭集枚举里暴露给用户的三个档位（argv 始终由 daemon 解析）。 */
export type ShellKind = "pwsh" | "bash" | "cmd";

export const SHELL_PROFILES: readonly { kind: ShellKind; label: string }[] = [
  { kind: "pwsh", label: "PowerShell 7" },
  { kind: "bash", label: "Bash" },
  { kind: "cmd", label: "命令提示符" },
];

export interface ShellTab {
  /** 前端标签身份。 */
  id: string;
  /** daemon 返回的 shell id：WS 流路径与 attach/stdin/resize 都认它。 */
  shellId: string;
  /** 开标签时快照的档位，之后不再变。 */
  kind: ShellKind;
  /** 开标签时快照的 cwd，之后不再变（一个编前端一个编后端）。 */
  cwd: string | null;
}

const LAST_KIND_KEY = "qaqh.shell.last_kind";
let tabSeq = 0;

function readLastKind(): ShellKind {
  const raw = prefGet(LAST_KIND_KEY);
  return SHELL_PROFILES.some((profile) => profile.kind === raw)
    ? (raw as ShellKind)
    : "pwsh";
}

const [tabs, setTabs] = createSignal<ShellTab[]>([]);
const [activeId, setActiveId] = createSignal<string | null>(null);
const [dockOpen, setDockOpen] = createSignal(false);
const [lastKind, setLastKindSignal] = createSignal<ShellKind>(readLastKind());

const profileLabel = (kind: ShellKind): string =>
  SHELL_PROFILES.find((profile) => profile.kind === kind)?.label ?? kind;

/** 同名档位多开时带序号；只有一个时显示纯档位名（与截图一致）。 */
const labelOf = (tab: ShellTab, all: ShellTab[]): string => {
  const sameKind = all.filter((item) => item.kind === tab.kind);
  if (sameKind.length === 1) return profileLabel(tab.kind);
  return `${profileLabel(tab.kind)} ${sameKind.findIndex((item) => item.id === tab.id) + 1}`;
};

const activeTab = (): ShellTab | undefined => {
  const id = activeId();
  return id == null ? undefined : tabs().find((tab) => tab.id === id);
};

/** 开一条新 shell 并聚焦。`kind` 缺席 = 上次用的档位。 */
const open = async (kind?: ShellKind): Promise<void> => {
  const chosen = kind ?? lastKind();
  const cwd = newSessionCwd();
  try {
    const created = await transport.query("shell.open", {
      cwd: cwd ?? undefined,
      shell: chosen,
    });
    const tab: ShellTab = {
      id: `shelltab-${Date.now()}-${(tabSeq += 1)}`,
      shellId: created.id,
      kind: chosen,
      cwd,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setDockOpen(true);
    if (chosen !== lastKind()) {
      setLastKindSignal(chosen);
      prefSet(LAST_KIND_KEY, chosen);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(`终端启动失败：${message}`, "err");
  }
};

/** 显式关标签 = 真收走进程；隐藏/切标签不会走到这里。 */
const close = (id: string): void => {
  const tab = tabs().find((item) => item.id === id);
  if (tab == null) return;
  void desktopHost()?.shell?.detach(tab.shellId);
  void transport.query("shell.close", { shell_id: tab.shellId }).catch(() => {});
  const rest = tabs().filter((item) => item.id !== id);
  setTabs(rest);
  if (activeId() === id) setActiveId(rest.at(-1)?.id ?? null);
  if (rest.length === 0) setDockOpen(false);
};

const activate = (id: string): void => {
  if (!tabs().some((tab) => tab.id === id)) return;
  setActiveId(id);
  setDockOpen(true);
};

/** 收起面板但不碰任何 shell；下次从 Composer 入口可再展开。 */
const hide = (): void => { setDockOpen(false); };

export const shellTabs = {
  tabs,
  activeId,
  dockOpen,
  lastKind,
  snapshot: () => ({ tabs: tabs(), activeId: activeId(), dockOpen: dockOpen(), lastKind: lastKind() }),
  activeTab,
  labelOf,
  open,
  close,
  activate,
  hide,
};
