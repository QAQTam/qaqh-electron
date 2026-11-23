/**
 * 启动页：极简四锚点布局（品牌问候 + 无边框建议行 + 双层统一 Composer）。
 */
import { registry, refreshRegistry } from "../settings/registry";
import type { ModelSelection } from "../api/contract";
import { createSignal, For, Show, type Component } from "solid-js";
import IconFolder from "~icons/lucide/folder";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconGitBranch from "~icons/lucide/git-branch";
import IconBug from "~icons/lucide/bug";
import IconGauge from "~icons/lucide/gauge";
import { transport } from "../lib/transport";
import { STR } from "../lib/strings";
import { tailName } from "../composer/identity";
import { WorkspaceMenu } from "../workspace/WorkspaceMenu";
import { Composer } from "../composer/Composer";
import { modelMetadata } from "../composer/model-config";
import { providerKindOfCredential, type ProviderKind } from "../oauth/mode";
import {
  preflightCreateArgs,
  writePreflightEffort,
  writePreflightMaxTokens,
  writePreflightModel,
  writePreflightToolMode,
  type StartupPreflight,
} from "../composer/startup-preflight";
import {
  clearStartupAttachments,
  chooseNewSessionFolder,
  createSession,
  creating,
  focusToken,
  newSessionCwd,
  removeStartupAttachment,
  setNewSessionCwd,
  setStartupPreflight,
  stageStartupAttachments,
  startupAttachments,
  startupPreflight,
  submitStartupSession,
  workspaceCatalog,
} from "../tabs/store";
import { toast } from "../ui/toast";

const SUGGESTIONS = [
  {
    icon: IconGitBranch,
    title: "分析当前项目的模块架构与核心调用流",
    prompt: "请系统性分析当前项目的代码架构、核心模块职责与依赖流向。",
  },
  {
    icon: IconBug,
    title: "审查近期变更并排查潜在缺陷",
    prompt: "请检查最近的代码变更，排查潜在的边界条件漏洞或状态冲突。",
  },
  {
    icon: IconGauge,
    title: "定位性能热点与内存开销并给出优化方案",
    prompt: "请分析项目的性能热点与资源占用，并给出针对性的优化方案。",
  },
];

export const StartupView: Component<{
  onScreenshot?: () => void;
  onManageProfiles?: () => void;
  onOpenSession?: (seed: string) => void;
  onSubmitted?: () => void;
}> = (props) => {
  const [draftText, setDraftText] = createSignal("");
  const [openMenu, setOpenMenu] = createSignal<"workspace" | null>(null);
  queueMicrotask(() => { void refreshRegistry(); });

  const workspaceLabel = (): string => {
    const cwd = newSessionCwd();
    if (!cwd) return STR.workspaceUngrouped;
    const found = workspaceCatalog().find((w) => w.path === cwd);
    return found?.title || tailName(cwd);
  };

  const preflightSelection = (): ModelSelection | null => startupPreflight().modelSelection;

  const preflightKind = (): ProviderKind => {
    const current = registry();
    const providerId = preflightSelection()?.provider_id ?? current?.defaultSelection?.provider_id;
    const provider = current?.providers.find((item) => item.id === providerId);
    return providerKindOfCredential(provider?.credential);
  };

  const handlePickAttachments = async (): Promise<void> => {
    try {
      stageStartupAttachments(await transport.pickAttachments());
    } catch (cause) {
      toast(`添加附件失败：${cause instanceof Error ? cause.message : String(cause)}`, "err");
    }
  };

  const handleApplySuggestion = (prompt: string): void => {
    setDraftText(prompt);
    const node = document.querySelector("#composer textarea");
    if (node instanceof HTMLTextAreaElement) node.focus();
  };

  const runPreflightWrite = (write: () => StartupPreflight): void => {
    try {
      setStartupPreflight(write());
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), "err");
    }
  };

  const handleSubmit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text || creating()) return;
    const preflight = startupPreflight();
    const selected = preflight.modelSelection;
    if (selected != null) {
      const model = registry()?.providers.find((provider) => provider.id === selected.provider_id)
        ?.models.find((item) => item.id === selected.model_id);
      if (model == null || !model.definition.enabled) {
        toast("预检的模型不存在或已停用，请在输入区的「模型」行重新选择", "err");
        return;
      }
    }
    const args = preflightCreateArgs(preflight);
    props.onSubmitted?.();
    const ok = await submitStartupSession({
      cwd: newSessionCwd(),
      modelSelection: args.modelSelection,
      toolMode: args.toolMode,
      customTools: args.customTools,
      text,
      attachments: startupAttachments(),
    });
    if (!ok) return;
    setDraftText("");
    clearStartupAttachments();
  };

  return (
    <div class="startup-container">
      <div class="startup-hero">
        <p class="startup-title">{STR.productName}</p>
        <p class="startup-subtitle">{STR.productTagline} · {STR.homeHeroSubtitle}</p>
      </div>

      {/* 极简无边框建议行（对齐 Antigravity 视觉减法） */}
      <div class="startup-suggestions">
        <For each={SUGGESTIONS}>
          {(s) => {
            const Icon = s.icon;
            return (
              <button
                type="button"
                class="startup-suggestion-row"
                onClick={() => handleApplySuggestion(s.prompt)}
              >
                <Icon class="startup-row-icon" aria-hidden="true" />
                <span class="startup-row-title">{s.title}</span>
              </button>
            );
          }}
        </For>
      </div>

      {/* 双层统一 Composer 壳：顶部上下文栏（工作区 + 模型）+ 底部输入面 */}
      <div class="startup-composer-box">
        <div class="startup-composer-context">
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
                selectedPath={newSessionCwd()}
                workspaces={workspaceCatalog()}
                onPick={(path) => {
                  setNewSessionCwd(path);
                  setOpenMenu(null);
                }}
                onCreateIn={(path) => {
                  setOpenMenu(null);
                  createSession(path);
                }}
                onBrowse={() => {
                  setOpenMenu(null);
                  void chooseNewSessionFolder();
                }}
              />
            </Show>
          </div>
        </div>

        <Composer
          draft={draftText}
          onDraft={setDraftText}
          blocked={() => null}
          running={() => false}
          sending={creating}
          onSend={(text) => void handleSubmit(text)}
          onStop={() => { /* running 恒 false */ }}
          focusToken={focusToken()}
          placeholder="输入你的任务需求，或直接提问…"
          onPickAttachments={() => void handlePickAttachments()}
          attachments={startupAttachments}
          onRemoveAttachment={(id) => removeStartupAttachment(id)}
          onScreenshot={props.onScreenshot}
          onManageProfiles={props.onManageProfiles}
          onSelection={(providerId, modelId) => {
            runPreflightWrite(() => ({
              ...startupPreflight(),
              modelSelection: { provider_id: providerId, model_id: modelId, options: {} },
            }));
          }}
          modelView={() => preflightSelection()?.model_id ?? null}
          modelOverridden={() => preflightSelection() != null}
          onModel={(model) => { runPreflightWrite(() => writePreflightModel(startupPreflight(), registry(), model)); }}
          providerKind={preflightKind}
          effortView={() => {
            const selected = preflightSelection();
            if (selected == null) return null;
            return selected.options.reasoning_effort
              ?? modelMetadata(preflightKind(), selected.model_id)?.defaultEffort ?? null;
          }}
          effortOverridden={() => preflightSelection()?.options.reasoning_effort != null}
          onEffort={(effort) => { runPreflightWrite(() => writePreflightEffort(startupPreflight(), registry(), effort)); }}
          maxTokensView={() => preflightSelection()?.options.max_output_tokens ?? null}
          onMaxTokens={(maxTokens) => { runPreflightWrite(() => writePreflightMaxTokens(startupPreflight(), registry(), maxTokens)); }}
          toolModeView={() => {
            const preflight = startupPreflight();
            return { mode: preflight.toolMode === "" ? "standard" : preflight.toolMode, customTools: preflight.customTools };
          }}
          onToolMode={(mode, customTools) => { runPreflightWrite(() => writePreflightToolMode(startupPreflight(), mode, customTools)); }}
        />
      </div>
    </div>
  );
};
