/**
 * 吸顶会话标题栏 (spec §7.6 / 对齐成熟 Coding Agent 顶部常驻标题)
 * 
 * 布局契约:
 * 1. 位于 #session 网格首行，与 #messages 滚动容器严格解耦。
 * 2. 文件夹图标 + 会话标题 + 「…」紧凑内联排列，契约严格对齐截图审美。
 * 3. 双击标题进入无边框原位内联重命名；支持 Enter 保存、Esc 取消。
 * 4. 「…」菜单提供重命名、复制会话 ID、复制工作区路径。
 */
import { createMemo, createSignal, Show, type Component } from "solid-js";
import IconFolder from "~icons/lucide/folder";
import IconMoreHorizontal from "~icons/lucide/more-horizontal";
import IconCopy from "~icons/lucide/copy";
import IconEdit from "~icons/lucide/file-pen-line";
import { localTitleOf, renameLocalSession, sessionCatalog, type Tab } from "../tabs/store";
import { transport } from "../lib/transport";
import { toast } from "../ui/toast";
import { STR } from "../lib/strings";
import { useDismissable } from "../ui/dismissable";

export interface SessionHeaderProps {
  tab: Tab;
}

export const SessionHeader: Component<SessionHeaderProps> = (props) => {
  const [isEditing, setIsEditing] = createSignal(false);
  const [editingText, setEditingText] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [copiedId, setCopiedId] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let menuContainerRef: HTMLDivElement | undefined;

  const session = createMemo(() =>
    sessionCatalog().find((s) => s.session_id === props.tab.seed)
  );

  const displayTitle = createMemo(() => {
    // 后端优先:daemon 生成的标题恒压过本地重命名覆盖;本地覆盖只在后端尚未
    // 生成标题时生效(方案A,见 docs/session-rename-persistence-plan.md)。
    const storeTitle = props.tab.store.title[0]();
    const backendTitle = storeTitle?.trim() || session()?.title?.trim();
    if (backendTitle) return backendTitle;
    const localTitle = localTitleOf(props.tab.seed).trim();
    if (localTitle) return localTitle;
    return `会话 ${props.tab.seed.slice(0, 8)}`;
  });

  const cwd = createMemo(() => session()?.cwd || "");

  const startRename = () => {
    setMenuOpen(false);
    setEditingText(displayTitle());
    setIsEditing(true);
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  };

  const commitRename = () => {
    const next = editingText().trim();
    setIsEditing(false);
    if (!next || next === displayTitle()) return;
    // 乐观生效：本地覆盖 + 侧栏目录立即更新（方案A，断线时也是兜底显示）。
    // 不写 store.title —— 那是后端标题的回灌通道，混写会让 title_changed
    // 无法区分来源。
    renameLocalSession(props.tab.seed, next);
    // 方案B（已落地）：后端 session.rename 落 meta.title 并广播
    // TitleChanged(user)；回灌走 title_changed echo，到达时本地覆盖自动清退
    // （tabs/store 的 onSessionTitleChanged 已实现）。
    transport
      .rpc("session.rename", { title: next }, props.tab.seed)
      .catch((error: unknown) => {
        toast(
          `重命名持久化失败：${String(error instanceof Error ? error.message : error)}`,
          "err",
        );
      });
  };

  const cancelRename = () => {
    setIsEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  const handleCopyId = () => {
    setMenuOpen(false);
    void navigator.clipboard.writeText(props.tab.seed).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  };

  const handleCopyCwd = () => {
    setMenuOpen(false);
    if (cwd()) {
      void navigator.clipboard.writeText(cwd());
    }
  };

  // 点击空白区域或 Esc 关闭「…」菜单。
  useDismissable({
    active: () => menuOpen(),
    onDismiss: () => setMenuOpen(false),
    inside: () => [menuContainerRef],
  });

  return (
    <header class="session-header" role="banner">
      <div class="session-header-lead" ref={menuContainerRef}>
        <span
          class="session-header-folder-icon"
          title={cwd() ? `工作区: ${cwd()}` : "会话工作区"}
        >
          <IconFolder />
        </span>

        <Show
          when={isEditing()}
          fallback={
            <span
              class="session-header-title"
              title={`${displayTitle()} (双击可重命名)`}
              onDblClick={startRename}
            >
              {displayTitle()}
            </span>
          }
        >
          <input
            ref={inputRef}
            type="text"
            class="session-header-rename-input"
            value={editingText()}
            onInput={(e) => setEditingText(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
          />
        </Show>

        <div class="session-header-menu-wrap">
          <button
            type="button"
            class={{ "session-header-more-btn": true, active: menuOpen() }}
            title={STR.sessionActions}
            aria-expanded={menuOpen() ? "true" : "false"}
            onClick={() => setMenuOpen(!menuOpen())}
          >
            <IconMoreHorizontal />
          </button>

          <Show when={menuOpen()}>
            <div class="session-header-dropdown-menu" role="menu">
              <button
                type="button"
                class="session-header-menu-item"
                role="menuitem"
                onClick={startRename}
              >
                <IconEdit />
                <span>重命名会话</span>
              </button>
              <button
                type="button"
                class="session-header-menu-item"
                role="menuitem"
                onClick={handleCopyId}
              >
                <IconCopy />
                <span>{copiedId() ? "已复制会话 ID" : "复制会话 ID"}</span>
              </button>
              <Show when={cwd()}>
                <button
                  type="button"
                  class="session-header-menu-item"
                  role="menuitem"
                  onClick={handleCopyCwd}
                >
                  <IconFolder />
                  <span>复制工作区路径</span>
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </header>
  );
};
