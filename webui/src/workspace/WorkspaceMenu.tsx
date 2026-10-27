/**
 * 工作区下拉(新建目标 / 本会话目标共用的同一张菜单)。
 *
 * 为什么抽出来:输入区工具条与首页配置栏各有一份**完全相同**的条目结构,之前两份
 * 各自写着「名字一行 + 完整路径一行」——同一个词说两遍(标题默认就是目录末段名),
 * 而且谁改样式都得改两处。这里收成一份,调用方只负责开合与选中态。
 */
import { For, Show, type Component } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconFolderPlus from "~icons/lucide/folder-plus";
import { STR } from "../lib/strings";
import { tailName } from "../composer/identity";
import type { SidebarWorkspace } from "../tabs/store";

/**
 * 末段之前的目录部分(保留尾分隔符):`D:\eew\qaqh\` → `D:\eew\`。
 * 盘符根(`D:\`、`/`)没有可省的前缀,给空串——否则会拼出 `D:/D:`。
 */
function dirPrefix(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut <= 0 ? "" : trimmed.slice(0, cut + 1);
}

/**
 * 前缀超长时只留最后两级目录,前面用「…」顶掉。
 *
 * 为什么不交给 CSS 裁:`overflow` 裁的是字符,不是目录段——`C:/Users/tsy3m/
 * AppData/Local/Programs/` 会剩下 `sy3m/AppData/Local/Programs/`,看起来像个
 * 相对路径,连盘符都没了。在分隔符边界上截,读起来才是「上面还有,这里是尾段」。
 * 预算按 10px 等宽字宽(~5.8px/字)折算,菜单可用宽度约 278px。
 */
function shortenDir(dir: string, maxChars = 26): string {
  if (dir.length <= maxChars) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return `…${sep}${parts.slice(-2).join(sep)}${sep}`;
}

/** 选中态的对勾:绝对定位在行尾,两行(改过名)与单行(同名)两种排法共用。 */
const MenuCheck: Component = () => <IconCheck class="workspace-row-check" aria-hidden="true" />;

/**
 * 一行工作区。**单行**显示「目录前缀 + 末段名」——标题与路径末段是同一个字符串时
 * (注册时按目录名起名,绝大多数情况)这就是完整路径,不必再把名字单独写一行。
 * 只有标题被改过、名字不再是路径的一部分时,才退回「名字 + 完整路径」两行。
 *
 * 三处共用:首页配置栏、输入区工具条、侧栏会话行的「移动到工作区」——所以行内
 * 样式统一叫 `workspace-row-*`,不跟任何一个宿主的容器类名绑定。
 * `data-copy-path` 让右键菜单能直接「复制路径」(见 `ui/contextMenu.tsx`)。
 */
export const WorkspaceMenuItem: Component<{
  workspace: SidebarWorkspace;
  selected: boolean;
  onPick: () => void;
  /**
   * 窄容器(侧栏 244px):只留末段名一行。前缀在那里只剩二三十个像素,
   * 硬塞进去会被裁成「ocal/Programs/claude-desktop」这种半截目录——路径退到
   * `title` 与右键「复制路径」,不占行。
   */
  compact?: boolean;
}> = (props) => {
  const name = (): string => props.workspace.title || tailName(props.workspace.path);
  const dir = (): string => shortenDir(dirPrefix(props.workspace.path));
  const inline = (): boolean => dir() !== "" && name() === tailName(props.workspace.path);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected ? "true" : "false"}
      class={props.selected ? "selected" : undefined}
      title={props.workspace.path}
      data-copy-path={props.workspace.path}
      onClick={() => props.onPick()}
    >
      <Show
        when={props.compact === true}
        fallback={
          <Show
            when={inline()}
            fallback={
              <>
                <span class="workspace-row-name">{name()}</span>
                <small class="workspace-row-path">{props.workspace.path}</small>
              </>
            }
          >
            <span class="workspace-row">
              {/* 前缀再套一层:裁切要靠外层 flex 的 `justify-content:flex-end` 把溢出
                  推到左边(text-align 在 overflow 容器里不改变溢出方向)。 */}
              <span class="workspace-row-dir">
                <span>{dir()}</span>
              </span>
              <span class="workspace-row-name">{name()}</span>
            </span>
          </Show>
        }
      >
        <span class="workspace-row-name">{name()}</span>
      </Show>
      <Show when={props.selected}>
        <MenuCheck />
      </Show>
    </button>
  );
};

export const WorkspaceMenu: Component<{
  /** 追加在 `.composer-menu` 后面的排布修饰类(如首页的 `composer-menu-below`)。 */
  extraClass?: string;
  selectedPath: string | null;
  workspaces: SidebarWorkspace[];
  onPick: (path: string | null) => void;
  onBrowse: () => void;
}> = (props) => (
  <div class={`composer-menu composer-workspace-menu${props.extraClass ? ` ${props.extraClass}` : ""}`} role="menu">
    <strong>{STR.workspacePickMenu}</strong>
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selectedPath == null ? "true" : "false"}
      class={props.selectedPath == null ? "selected" : undefined}
      onClick={() => props.onPick(null)}
    >
      <span>{STR.workspaceUngrouped}</span>
      <small>{STR.workspaceDefaultHint}</small>
      <Show when={props.selectedPath == null}>
        <MenuCheck />
      </Show>
    </button>
    <For each={props.workspaces}>
      {(workspace) => (
        <WorkspaceMenuItem
          workspace={workspace}
          selected={props.selectedPath === workspace.path}
          onPick={() => props.onPick(workspace.path)}
        />
      )}
    </For>
    <button type="button" class="composer-menu-action" onClick={() => props.onBrowse()}>
      <span class="composer-workspace-browse">
        <IconFolderPlus />
        {STR.workspaceChooseFolder}
      </span>
      <small>{STR.workspaceChooseFolderHint}</small>
    </button>
  </div>
);
