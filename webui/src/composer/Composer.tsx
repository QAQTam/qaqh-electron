/**
 * 输入区(spec §12):1–8 行自动增高,Enter 发送 / Shift+Enter 换行,
 * 输入法组合态(isComposing / keyCode 229)不发送;
 * 运行中或有待处理请求时发送禁用(可继续写草稿);离线禁用并说明原因;
 * 空闲显示「发送」,运行中替换为「停止」。
 *
 * 表面内只剩写与发(附件 + profile 选择 + 新建目标工作区 + 发送/停止);
 * 只读身份行在表面外下方,见 §1.5。
 */
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import autoAnimate from "@formkit/auto-animate";
import IconArrowUp from "~icons/lucide/arrow-up";
import IconSquare from "~icons/lucide/square";
import IconPlus from "~icons/lucide/plus";
import IconPaperclip from "~icons/lucide/paperclip";
import IconCamera from "~icons/lucide/camera";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconArchive from "~icons/lucide/archive";
import IconFolder from "~icons/lucide/folder";
import IconX from "~icons/lucide/x";
import { STR } from "../lib/strings";
import type { SidebarWorkspace } from "../tabs/store";
import type { ComposerMetrics, PendingAttachment, SessionProfileView } from "../session/store";
import { tailName } from "./identity";
import { WorkspaceMenu } from "../workspace/WorkspaceMenu";
import { EffortCard } from "./EffortCard";
import { useDismissable } from "../ui/dismissable";

export type SendBlockReason = "running" | "pending" | "offline" | "no-session" | null;

/** HUD 里端点原生 usage 字段的展示上限,其余归入 `+N` 的 title。 */
const EXTRA_HUD_LIMIT = 4;

/** 附件 chip 的副标:上传态优先,完成后才显示体积。 */
function attachmentDetail(item: PendingAttachment): string {
  if (item.state === "uploading") return STR.attachmentUploading;
  if (item.state === "failed") return STR.attachmentFailed;
  return item.size > 0 ? humanSize(item.size) : "";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const Composer: Component<{
  draft: () => string;
  onDraft: (value: string) => void;
  blocked: () => SendBlockReason;
  running: () => boolean;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
  focusToken: number;
  autoFocus?: boolean;
  placeholder?: string;
  /**
   * 新建会话的目标工作区。传了 `onWorkspace` 才渲染选择器(夹具页不传即无此控件)。
   * 只影响之后新建的会话:已开会话的 cwd 钉在 SessionMeta 上,不在这一处改。
   * 与身份行的「当前会话工作区」语义不同,两者不合并(§1.5)。
   */
  workspaces?: () => SidebarWorkspace[];
  workspacePath?: () => string | null;
  onWorkspace?: (path: string | null) => void;
  onBrowseWorkspace?: () => void;
  /**
   * 会话级 profile 视图 + 写口(§1.5)。不传 `onProfile` 即不渲染选择器。
   * 权限档位**不在这里出现**:daemon 侧只有全局一份,就地切换会让人以为
   * 只影响本会话,所以档位仍只在设置页经 `config.save` 单写口改。
   */
  profileView?: () => SessionProfileView;
  onProfile?: (name: string | null) => void;
  /** Live session usage HUD; omitted from the empty-session composer. */
  metrics?: () => ComposerMetrics;
  /** 身份行:当前会话的工作区名;null = 目录项还没到,隐藏该项。 */
  sessionWorkspace?: () => string | null;
  /** 身份行:局域网面是否开着;null = 未知,隐藏该项。 */
  lanActive?: () => boolean | null;
  /** 上下文面板里的「压缩上下文」;未接宿主(夹具页)时不传即隐藏。 */
  onCompact?: () => void;
  /** 压缩进行态,用于禁用重复触发。 */
  compactPhase?: () => "idle" | "running" | "done" | "skipped" | "failed";
  /**
   * 附件:选文件(内含宿主对话框 + 上传)。不传则不渲染附件入口——夹具页与
   * 浏览器预览没有原生对话框,拿不到这一面。
   */
  onPickAttachments?: () => void;
  /** 待发附件 chip 列表(上传态由 store 维护)。 */
  attachments?: () => PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
  /**
   * 应用内截图(macOS ⌘⇧S 那条的按钮入口)。不传则不渲染——浏览器预览与
   * 非 mac 平台都拿不到系统截图,摆出来只会变成一个坏控件。
   */
  onScreenshot?: () => void;
}> = (props) => {
  let textarea: HTMLTextAreaElement | undefined;
  let root: HTMLDivElement | undefined;
  const [openMenu, setOpenMenu] = createSignal<"profile" | "workspace" | "context" | "effort" | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);

  // 四个下拉共用一条关闭规则：点别处 / Esc 都关；点任一触发器交给它自己切换。
  useDismissable({
    active: () => openMenu() != null,
    onDismiss: () => setOpenMenu(null),
    inside: () => [root?.querySelector(".composer-menu") ?? null],
    triggerSelector: ".composer-tool-button, .composer-context-trigger",
  });
  createEffect(
    () => props.running(),
    (running) => {
      if (!running) setStopping(false);
    },
  );

  const stop = async (): Promise<void> => {
    if (stopping()) return;
    setStopping(true);
    try {
      await props.onStop();
    } catch {
      setStopping(false);
    }
  };

  const attachments = (): PendingAttachment[] => props.attachments?.() ?? [];
  /** 还在上传的附件不能发:命令里只允许出现已换回的 `ContentRef`。 */
  const uploading = (): boolean => attachments().some((item) => item.state === "uploading");
  /** 未新建会话时没有可上传的目标(上传按 seed 归属),此时不摆出附件入口。 */
  const canAttach = (): boolean => props.onPickAttachments != null && props.blocked() !== "no-session";
  /** 截图与附件同一道闸:都要先有会话 seed 才上传得了,入口不该在没会话时出现。 */
  const canShot = (): boolean => props.onScreenshot != null && canAttach();

  const workspaceLabel = (): string => {
    const path = props.workspacePath?.() ?? "";
    return path === "" ? STR.workspaceUngrouped : tailName(path);
  };

  const profile = (): SessionProfileView | null => props.profileView?.() ?? null;
  /** `ConfigDto` 只下发**活跃** profile 的 model,名录里其他项拿不到,就标未公开。 */
  const profileModel = (name: string): string | null => {
    const view = profile();
    return view != null && name === view.activeProfile ? view.model : null;
  };

  const currentWorkspace = (): string | null => props.sessionWorkspace?.() ?? null;
  const showIdentity = (): boolean =>
    currentWorkspace() != null || props.lanActive?.() != null || props.metrics?.() != null;

  const autoGrow = (): void => {
    const el = textarea;
    if (el == null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22 + 20)}px`; // ≈8 行后内部滚动
  };

  createEffect(() => props.draft(), () => autoGrow());

  // 新会话打开/切回标签时恢复焦点(§12)。
  createEffect(
    () => props.focusToken,
    () => { if (props.autoFocus !== false) textarea?.focus(); },
  );

  const submit = async (): Promise<void> => {
    if (submitting()) return;
    if (!props.draft().trim()) return;
    if (props.blocked() != null) return;
    if (uploading()) return;
    setSubmitting(true);
    try {
      await props.onSend(props.draft());
    } finally {
      setSubmitting(false);
    }
  };

  const blockTitle = (): string => {
    switch (props.blocked()) {
      case "running":
        return STR.sendDisabledRunning;
      case "pending":
        return STR.sendDisabledApproval;
      case "offline":
        return STR.sendDisabledOffline;
      case "no-session":
        return STR.sendDisabledNoSession;
      default:
        return STR.send;
    }
  };

  return (
    <div id="composer" ref={(el) => { root = el; }}>
      <div class="composer-surface">
        <Show when={attachments().length > 0}>
          <div
            class="composer-attachments"
            aria-label="待发送附件"
            ref={(el) => {
              if (el) autoAnimate(el, { duration: 140, easing: "cubic-bezier(0.2, 0, 0, 1)" });
            }}
          >
            <For each={attachments()}>{(item) => (
              <span class={`composer-file-chip ${item.state}`} title={item.error ?? item.name}>
                <IconPaperclip />
                <span>{item.name}</span>
                <small>{attachmentDetail(item)}</small>
                <button type="button" aria-label={`移除 ${item.name}`} onClick={() => props.onRemoveAttachment?.(item.id)}><IconX /></button>
              </span>
            )}</For>
          </div>
        </Show>
        <textarea
          ref={textarea}
          rows={1}
          placeholder={props.placeholder ?? ""}
          value={props.draft()}
          onInput={(e) => props.onDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            // 输入法组合态不发送(§12):isComposing 或 keyCode 229。
            if (e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            void submit();
          }}
        />
        <div class="composer-toolbar">
          <div class="composer-controls">
            <Show when={canAttach()}>
              <button
                type="button"
                class="composer-tool-button composer-add-file"
                aria-label={STR.attachmentAdd}
                title={STR.attachmentAddTitle}
                onClick={() => props.onPickAttachments?.()}
              >
                <IconPlus />
              </button>
            </Show>
            {/* 应用内截图：走同一份 chip 状态机，只是来源换成系统截图（选区）。 */}
            <Show when={canShot()}>
              <button
                type="button"
                class="composer-tool-button composer-shot"
                aria-label={STR.shotAdd}
                title={STR.shotAddTitle}
                onClick={() => props.onScreenshot?.()}
              >
                <IconCamera />
              </button>
            </Show>
            <Show when={props.onProfile == null ? null : profile()}>
              {(view) => (
                <div class="composer-control-wrap composer-profile-wrap">
                  <button
                    type="button"
                    class="composer-tool-button composer-profile-button"
                    aria-expanded={openMenu() === "profile" ? "true" : "false"}
                    title={STR.profilePickTitle(view().effective ?? STR.profileFollowGlobal)}
                    onClick={() => setOpenMenu(openMenu() === "profile" ? null : "profile")}
                  >
                    <span>{view().effective ?? STR.profileFollowGlobal}</span>
                    <Show when={view().model != null}>
                      <span class="composer-profile-model">→ {view().model}</span>
                    </Show>
                    <IconChevronDown />
                  </button>
                  <Show when={openMenu() === "profile"}>
                    <div class="composer-menu composer-profile-menu" role="menu">
                      <strong>{STR.profilePickMenu}</strong>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={view().selected == null ? "true" : "false"}
                        class={view().selected == null ? "selected" : undefined}
                        onClick={() => { props.onProfile?.(null); setOpenMenu(null); }}
                      >
                        <span>{STR.profileFollowGlobal}</span>
                        <small>{view().activeProfile ?? ""}</small>
                      </button>
                      <For each={view().catalog}>{(name) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={view().selected === name ? "true" : "false"}
                          class={view().selected === name ? "selected" : undefined}
                          onClick={() => { props.onProfile?.(name); setOpenMenu(null); }}
                        >
                          <span>{name}</span>
                          <small>{profileModel(name) ?? STR.profileModelHidden}</small>
                        </button>
                      )}</For>
                      <small class="composer-menu-note">{STR.profileTakesEffectHint}</small>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
            {/* 强度与模型（全局）：与 profile/workspace 共用一个菜单位，同时只开一个。 */}
            <EffortCard
              open={openMenu() === "effort"}
              onToggle={() => setOpenMenu(openMenu() === "effort" ? null : "effort")}
            />
            <Show when={props.onWorkspace != null}>
              <div class="composer-control-wrap">
                <button
                  type="button"
                  class="composer-tool-button composer-workspace-button"
                  aria-expanded={openMenu() === "workspace" ? "true" : "false"}
                  title={STR.workspacePickTitle(workspaceLabel())}
                  onClick={() => setOpenMenu(openMenu() === "workspace" ? null : "workspace")}
                >
                  <IconFolder /><span>{workspaceLabel()}</span><IconChevronDown />
                </button>
                <Show when={openMenu() === "workspace"}>
                  <WorkspaceMenu
                    selectedPath={props.workspacePath?.() ?? null}
                    workspaces={props.workspaces?.() ?? []}
                    onPick={(path) => { props.onWorkspace?.(path); setOpenMenu(null); }}
                    onBrowse={() => { setOpenMenu(null); props.onBrowseWorkspace?.(); }}
                  />
                </Show>
              </div>
            </Show>
          </div>
          <div class="composer-submit-area">
            <Show
              when={props.running()}
              fallback={
                <button
                  type="button"
                  class="icon-btn send button-primary"
                  aria-label={props.blocked() == null ? STR.send : `${STR.send}，${blockTitle()}`}
                  title={uploading() ? STR.attachmentUploading : blockTitle()}
                  disabled={submitting() || props.draft().trim() === "" || props.blocked() != null || uploading()}
                  onClick={() => void submit()}
                >
                  <IconArrowUp />
                </button>
              }
            >
              <button
                type="button"
                class="icon-btn stop button-danger"
                aria-label={stopping() ? "正在停止" : STR.stop}
                title={stopping() ? "正在停止…" : STR.stop}
                disabled={stopping()}
                onClick={() => void stop()}
              >
                <IconSquare />
              </button>
            </Show>
          </div>
        </div>
      </div>
      <Show when={showIdentity()}>
        <div class="composer-identity" aria-label={STR.identityTitle}>
          <Show when={currentWorkspace() != null}>
            <span class="composer-identity-item" title={STR.identityWorkspaceTitle(currentWorkspace() ?? "")}>
              <IconFolder />{currentWorkspace()}
            </span>
          </Show>
          <Show when={props.lanActive?.() != null}>
            <span class="composer-identity-item">{props.lanActive!() ? STR.netLan : STR.netLocal}</span>
          </Show>
          <Show when={props.metrics?.()}>
            {(metrics) => {
              // 端点原生 usage 字段（`credit` 等未建模项）。零值通常是「未使用」，
              // 占位不提供信息，故省略；展示上限之外的完整列表进 title。
              const extras = (): Array<[string, number]> =>
                Object.entries(metrics().extras ?? {})
                  .filter(([, value]) => value !== 0)
                  .sort(([a], [b]) => a.localeCompare(b));
              /**
               * 让分母露脸：百分比只是「已用 ÷ 窗口」，而窗口是**配置值**
               * （设置页「上下文窗口」= 后端本地压缩分母）。不写出来的话，
               * 「怎么才 1%」只能靠猜——很可能配置里就写着 1,000,000。
               */
              const windowNote = (): string => {
                const window = metrics().contextWindow;
                return window == null
                  ? STR.contextWindowUnknown
                  : STR.contextWindowDenominator(window.toLocaleString("en-US"));
              };
              return (
                <>
                  <span
                    class={{
                      "composer-identity-item": true,
                      "is-live": metrics().isStreaming === true,
                      "is-idle": metrics().tokensPerSecond == null && !metrics().isStreaming,
                    }}
                    title={
                      metrics().isStreaming
                        ? "实时吐字速率：基于流式增量滑动窗口实时测算"
                        : metrics().tokensPerSecond != null
                          ? "最近一轮完成速率：completion tokens ÷ 首末输出间隔"
                          : "吐字速率：模型生成时将实时显示 (tok/s)"
                    }
                  >
                    <Show when={metrics().isStreaming}>
                      <span class="composer-live-dot" aria-hidden="true" />
                    </Show>
                    <strong>{metrics().tokensPerSecond != null ? metrics().tokensPerSecond!.toFixed(1) : "--"}</strong> tok/s
                  </span>
                  <span class="composer-context-wrap">
                    <button
                      type="button"
                      class="composer-context-trigger"
                      aria-expanded={openMenu() === "context" ? "true" : "false"}
                      title={`上下文窗口：${windowNote()}；点开查看占用与压缩`}
                      onClick={() => setOpenMenu(openMenu() === "context" ? null : "context")}
                    >
                      上下文 <strong>{metrics().contextPercent != null ? `${metrics().contextPercent!.toFixed(0)}%` : "0%"}</strong>
                    </button>
                    <Show when={openMenu() === "context"}>
                      <div class="composer-menu composer-context-menu" role="dialog" aria-label={STR.contextWindowTitle}>
                        <div class="composer-context-head">
                          <strong>{STR.contextWindowTitle}</strong>
                          <span>{metrics().contextPercent != null ? `${metrics().contextPercent!.toFixed(0)}%` : "0%"}</span>
                        </div>
                        <span class="composer-context-bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, Math.max(0, metrics().contextPercent ?? 0))}%` }} />
                        </span>
                        <p class="composer-context-window">{windowNote()}</p>
                        <p class="composer-context-note">{STR.contextOccupied}</p>
                        <div class="composer-context-breakdown">
                          <strong>{STR.contextBreakdownPending}</strong>
                          <small>{STR.contextBreakdownNote}</small>
                        </div>
                        <button
                          type="button"
                          class="composer-context-compact"
                          disabled={props.running() || props.compactPhase?.() === "running"}
                          title={props.running() ? STR.contextCompactDisabledRunning : STR.contextCompactAction}
                          onClick={() => { props.onCompact?.(); setOpenMenu(null); }}
                        >
                          <IconArchive />{STR.contextCompactAction}
                        </button>
                      </div>
                    </Show>
                  </span>
                  <Show when={metrics().cacheHitPercent != null}>
                    <span class="composer-identity-item" title="本轮 prompt cache 命中 token / 已报告的命中与未命中 token">
                      缓存命中 <strong>{metrics().cacheHitPercent!.toFixed(2)}%</strong>
                    </span>
                  </Show>
                  <For each={extras().slice(0, EXTRA_HUD_LIMIT)}>
                    {([key, value]) => (
                      <span class="composer-identity-item" title={`端点原生 usage 字段：${key}`}>
                        {key} <strong>{value}</strong>
                      </span>
                    )}
                  </For>
                  <Show when={extras().length > EXTRA_HUD_LIMIT}>
                    <span class="composer-identity-item" title={extras().map(([key, value]) => `${key} ${value}`).join(" · ")}>
                      +{extras().length - EXTRA_HUD_LIMIT}
                    </span>
                  </Show>
                </>
              );
            }}
          </Show>
        </div>
      </Show>
    </div>
  );
};
