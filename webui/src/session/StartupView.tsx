import { registry, refreshRegistry } from "../settings/registry";
import type {
 ModelSelection 
} from "../api/contract";
import { createSignal, For, Show, type Component } from "solid-js";
import IconFolder from "~icons/lucide/folder";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconPaperclip from "~icons/lucide/paperclip";
import IconCamera from "~icons/lucide/camera";
import IconPlus from "~icons/lucide/plus";
import IconArrowUp from "~icons/lucide/arrow-up";
import IconX from "~icons/lucide/x";
import IconSparkles from "~icons/lucide/sparkles";
import IconLoader from "~icons/lucide/loader-circle";
import IconGitBranch from "~icons/lucide/git-branch";
import IconBug from "~icons/lucide/bug";
import IconGauge from "~icons/lucide/gauge";
import IconFlask from "~icons/lucide/flask-conical";
import { transport } from "../lib/transport";
import { STR } from "../lib/strings";
import { tailName } from "../composer/identity";
import { WorkspaceMenu } from "../workspace/WorkspaceMenu";
import {
  workspaceCatalog,
  newSessionCwd,
  setNewSessionCwd,
  chooseNewSessionFolder,
  submitStartupSession,
  creating,
  startupAttachments,
  stageStartupAttachments,
  removeStartupAttachment,
  clearStartupAttachments,
} from "../tabs/store";
import { toast } from "../ui/toast";

const SUGGESTIONS = [
  {
    icon: IconGitBranch,
    title: "分析项目架构",
    desc: "梳理模块拓扑、核心调用流与设计职责",
    prompt: "请系统性分析当前项目的代码架构、核心模块职责与依赖流向。",
  },
  {
    icon: IconBug,
    title: "排查代码缺陷",
    desc: "审查近期变更，定位潜在异常与边界漏洞",
    prompt: "请检查最近的代码变更，排查潜在的边界条件漏洞或状态冲突。",
  },
  {
    icon: IconGauge,
    title: "优化系统性能",
    desc: "分析性能热点、高频调度与内存开销",
    prompt: "请分析项目的性能热点与资源占用，并给出针对性的优化方案。",
  },
  {
    icon: IconFlask,
    title: "编写测试用例",
    desc: "为核心函数补充边缘用例与回归测试",
    prompt: "请为核心业务模块设计单元测试用例，覆盖异常分支与关键不变量。",
  },
];

export const StartupView: Component<{
  /** 应用内截图（⌘⇧S 同一份实现）；缺省 = 宿主不提供，按钮不出现。 */
  onScreenshot?: () => void;
  onManageProfiles?: () => void;
}> = (props) => {
  let textarea: HTMLTextAreaElement | undefined;
  const [draftText, setDraftText] = createSignal("");
  const [selectedModel, setSelectedModel] = createSignal<ModelSelection | null>(null);
  const [openMenu, setOpenMenu] = createSignal<"workspace" | "profile" | null>(null);
  void refreshRegistry();

  const workspaceLabel = (): string => {
    const cwd = newSessionCwd();
    if (!cwd) return STR.workspaceUngrouped;
    const found = workspaceCatalog().find((w) => w.path === cwd);
    return found?.title || tailName(cwd);
  };

  const modelLabel = (): string => {
    const selected = selectedModel();
    if (selected == null) return "选择服务商和模型";
    const provider = registry()?.providers.find((item) => item.id === selected.provider_id);
    const model = provider?.models.find((item) => item.id === selected.model_id);
    return `${provider?.name ?? selected.provider_id} · ${model?.definition.display_name ?? selected.model_id}`;
  };

  const autoGrow = (): void => {
    const el = textarea;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22 + 20)}px`;
  };

  const handlePickAttachments = async (): Promise<void> => {
    try {
      stageStartupAttachments(await transport.pickAttachments());
    } catch (cause) {
      toast(`添加附件失败：${cause instanceof Error ? cause.message : String(cause)}`, "err");
    }
  };

  const handleRemoveAttachment = (pathToRemove: string): void => {
    removeStartupAttachment(pathToRemove);
  };

  const handleApplySuggestion = (prompt: string): void => {
    setDraftText(prompt);
    setTimeout(() => {
      autoGrow();
      textarea?.focus();
    }, 50);
  };

  const handleSubmit = async (): Promise<void> => {
    const text = draftText().trim();
    if (!text || creating()) return;
    const selected = selectedModel();
    if (selected == null) { toast("请先选择服务商和模型", "err"); return; }
    const model = registry()?.providers.find((provider) => provider.id === selected.provider_id)
      ?.models.find((item) => item.id === selected.model_id);
    if (model == null || !model.definition.enabled) {
      toast("所选模型不存在或已停用，请重新选择", "err");
      return;
    }
    const ok = await submitStartupSession({
      cwd: newSessionCwd(),
      modelSelection: selected,
      text,
      attachmentPaths: startupAttachments(),
    });
    if (!ok) return; // 失败保留草稿,用户改完重试
    setDraftText("");
    clearStartupAttachments();
  };

  return (
    <div class="startup-container">
      <div class="startup-hero">
        {/* §8.7:产品名已在 TopBar,启动页不再用 28px 产品名当主标题;composer 才是主角。 */}
        <p class="startup-subtitle">配置新会话环境，在发送首条消息时原子化创建</p>
      </div>

      <div class="startup-config-bar">
        {/* 工作区选择。菜单**向下**展开(composer-menu-below):这一栏在页面中段,
            沿用输入区那套「向上弹」会顶出视口顶边,首个条目直接被裁掉。 */}
        <div class="composer-control-wrap">
          <button
            type="button"
            class="composer-tool-button composer-workspace-button"
            aria-expanded={openMenu() === "workspace" ? "true" : "false"}
            onClick={() => setOpenMenu(openMenu() === "workspace" ? null : "workspace")}
            title={STR.workspacePickTitle(workspaceLabel())}
          >
            <IconFolder />
            <span>{workspaceLabel()}</span>
            <IconChevronDown />
          </button>
          <Show when={openMenu() === "workspace"}>
            <WorkspaceMenu
              extraClass="composer-menu-below"
              selectedPath={newSessionCwd()}
              workspaces={workspaceCatalog()}
              onPick={(path) => {
                setNewSessionCwd(path);
                setOpenMenu(null);
              }}
              onBrowse={() => {
                setOpenMenu(null);
                void chooseNewSessionFolder();
              }}
            />
          </Show>
        </div>

        <div class="composer-control-wrap composer-profile-wrap">
          <button type="button" class="composer-tool-button composer-profile-button"
            aria-expanded={openMenu() === "profile" ? "true" : "false"}
            onClick={() => setOpenMenu(openMenu() === "profile" ? null : "profile")}>
            <IconSparkles /><span>{modelLabel()}</span><IconChevronDown />
          </button>
          <Show when={openMenu() === "profile"}>
            <div class="composer-menu composer-profile-menu composer-menu-below" role="menu">
              <strong>选择服务商和模型</strong>
              <For each={registry()?.providers ?? []}>{(provider) => <>
                <small>{provider.name}</small>
                <For each={provider.models.filter((model) => model.definition.enabled)}>{(model) =>
                  <button type="button" role="menuitemradio"
                    aria-checked={selectedModel()?.provider_id === provider.id && selectedModel()?.model_id === model.id ? "true" : "false"}
                    onClick={() => { setSelectedModel({ provider_id: provider.id, model_id: model.id, options: {} }); setOpenMenu(null); }}>
                    {model.definition.display_name || model.id}
                  </button>
                }</For>
              </>}</For>
              <button type="button" onClick={() => { setOpenMenu(null); props.onManageProfiles?.(); }}>管理服务商和模型…</button>
            </div>
          </Show>
        </div>
      </div>

      {/* 快捷建议卡片 */}
      <div class="startup-suggestions">
        <For each={SUGGESTIONS}>
          {(s) => {
            const Icon = s.icon;
            return (
              <button
                type="button"
                class="startup-suggestion-card"
                onClick={() => handleApplySuggestion(s.prompt)}
              >
                <span class="startup-card-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span class="startup-card-body">
                  <span class="startup-card-title">{s.title}</span>
                  <span class="startup-card-desc">{s.desc}</span>
                </span>
              </button>
            );
          }}
        </For>
      </div>

      {/* 输入与发送卡片 */}
      <div class="startup-composer-box">
        <div id="composer">
          <div class="composer-surface">
            <Show when={startupAttachments().length > 0}>
              <div class="composer-attachments" aria-label="待发送附件">
                <For each={startupAttachments()}>
                  {(filePath) => (
                    <span class="composer-file-chip ready" title={filePath}>
                      <IconPaperclip />
                      <span>{tailName(filePath)}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${tailName(filePath)}`}
                        onClick={() => handleRemoveAttachment(filePath)}
                      >
                        <IconX />
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <textarea
              ref={textarea}
              rows={2}
              placeholder="输入你的任务需求，或直接提问…"
              value={draftText()}
              onInput={(e) => {
                setDraftText(e.currentTarget.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey) return;
                if (e.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                void handleSubmit();
              }}
            />
            <div class="composer-toolbar">
              <div class="composer-controls">
                <button
                  type="button"
                  class="composer-tool-button composer-add-file"
                  aria-label={STR.attachmentAdd}
                  title={STR.attachmentAddTitle}
                  onClick={() => void handlePickAttachments()}
                >
                  <IconPlus />
                </button>
                {/* 截图与「添加附件」并排:同一份附件状态机,只是来源换成系统截图。 */}
                <Show when={props.onScreenshot != null}>
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
              </div>
              <div class="composer-submit-area">
                <button
                  type="button"
                  class="icon-btn send button-primary"
                  disabled={creating() || draftText().trim() === ""}
                  onClick={() => void handleSubmit()}
                  title="发送并创建新会话"
                >
                  <Show when={creating()} fallback={<IconArrowUp />}>
                    <IconLoader class="icon-spin" />
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </div>
        {/* 快捷键提示:占位符里那句括注读起来像残句,挪到输入框下面用键帽摆出来。 */}
        <div class="startup-hints">
          <span>
            <kbd>Enter</kbd> 发送
          </span>
          <span>
            <kbd>Shift</kbd>
            <span class="startup-hints-plus">+</span>
            <kbd>Enter</kbd> 换行
          </span>
        </div>
      </div>
    </div>
  );
};
