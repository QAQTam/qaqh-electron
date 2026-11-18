/**
 * 启动页:hero + 配置条(工作区 / 服务商模型下拉)+ 建议卡 + **共用 Composer**。
 *
 * 阶段B(2026-11-10):手搓的输入区(建议卡之外整段 textarea、附件 chip、工具条、
 * 发送钮)删掉了,换成会话页那一份 `composer/Composer`。理由不是审美——每键卡顿
 * 那次修复(`44177da`)要在两个文件各写一遍同样的非受控化,预检卡每加一个 prop
 * 也要接两处。输入面从此只有一个。
 *
 * 卡片读写的是**预检态**(`tabs/store:startupPreflight`),不是任何会话:
 * 还没有 seed,`session.settings.patch` 无处可发;发送首条消息时经
 * `preflightCreateArgs` 随 `session.create` 一次性带上。「跟随存档」在这里是
 * 真值而不是占位——null 就是不发该字段,后端回落 `default_model_selection`
 * (`session.rs:173-176`),旧的「请先选择服务商和模型」硬闸因此删掉了。
 */
import { registry, refreshRegistry } from "../settings/registry";
import type {
  ModelSelection 
} from "../api/contract";
import { createSignal, For, Show, type Component } from "solid-js";
import IconFolder from "~icons/lucide/folder";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconSparkles from "~icons/lucide/sparkles";
import IconGitBranch from "~icons/lucide/git-branch";
import IconBug from "~icons/lucide/bug";
import IconGauge from "~icons/lucide/gauge";
import IconFlask from "~icons/lucide/flask-conical";
import IconMessageSquare from "~icons/lucide/message-square";
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
  sessionCatalog,
  setNewSessionCwd,
  setStartupPreflight,
  stageStartupAttachments,
  startupAttachments,
  startupPreflight,
  submitStartupSession,
  workspaceCatalog,
  type SidebarSession,
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
  /** 点「最近的工作」卡:宿主统一切消息页 + openSession(与侧栏选中同一路径);
   *  缺省(夹具页)则整块不渲染——与 MessageSidebar.onCreateIn 同一模式。 */
  onOpenSession?: (seed: string) => void;
  /** 首条消息已受理(预检通过、即将异步建会话):壳层立刻切到消息页。
   *  session.create + openSession 是异步链,主区要等会话落地才换 SessionView;
   *  section 不先过去,主页会一直停在品牌页。缺省(夹具页)不导航。 */
  onSubmitted?: () => void;
}> = (props) => {
  const [draftText, setDraftText] = createSignal("");
  const [openMenu, setOpenMenu] = createSignal<"workspace" | "profile" | null>(null);
  // Solid 2 严格模式:组件 owned scope 内禁止写信号——refreshRegistry 同步
  // setLoading/setError,挪进微任务在作用域外跑。
  queueMicrotask(() => { void refreshRegistry(); });

  const workspaceLabel = (): string => {
    const cwd = newSessionCwd();
    if (!cwd) return STR.workspaceUngrouped;
    const found = workspaceCatalog().find((w) => w.path === cwd);
    return found?.title || tailName(cwd);
  };

  const preflightSelection = (): ModelSelection | null => startupPreflight().modelSelection;

  /** 预检整对的 provider 类别;跟随存档时按存档默认的类别(卡片目录/档位按它算)。 */
  const preflightKind = (): ProviderKind => {
    const current = registry();
    const providerId = preflightSelection()?.provider_id ?? current?.defaultSelection?.provider_id;
    const provider = current?.providers.find((item) => item.id === providerId);
    return providerKindOfCredential(provider?.credential);
  };

  /** 下拉钮的字:钉了预检就说预检;跟随存档就说**真正生效的那一对**,不含糊。 */
  const modelLabel = (): string => {
    const selected = preflightSelection();
    const describe = (selection: ModelSelection): string => {
      const provider = registry()?.providers.find((item) => item.id === selection.provider_id);
      const model = provider?.models.find((item) => item.id === selection.model_id);
      return `${provider?.name ?? selection.provider_id} · ${model?.definition.display_name ?? selection.model_id}`;
    };
    if (selected != null) return describe(selected);
    const archiveDefault = registry()?.defaultSelection ?? null;
    if (archiveDefault == null) return "跟随存档默认（未设置）";
    return `跟随存档默认 · ${describe(archiveDefault)}`;
  };

  /** 当前「生效中」的那一对:预检钉住它,或跟随存档时是存档默认(单选点用)。 */
  const effectiveSelection = (): ModelSelection | null =>
    preflightSelection() ?? registry()?.defaultSelection ?? null;

  /** 最近的工作:按回合数(工作量代理)取前三,updated_at 决胜;归档与零回合不入。 */
  const recentSessions = (): SidebarSession[] =>
    sessionCatalog()
      .filter((item) => !item.archived && (item.turn_count ?? 0) > 0)
      .sort((a, b) => (b.turn_count ?? 0) - (a.turn_count ?? 0) || (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 3);

  const handlePickAttachments = async (): Promise<void> => {
    try {
      stageStartupAttachments(await transport.pickAttachments());
    } catch (cause) {
      toast(`添加附件失败：${cause instanceof Error ? cause.message : String(cause)}`, "err");
    }
  };

  const handleApplySuggestion = (prompt: string): void => {
    setDraftText(prompt);
    // Composer 的 textarea 不在本组件的 ref 手里;输入区就在 #composer 里,这是
    // 夹具与会话页共用的稳定挂点(见 Composer 的 id="composer")。
    const node = document.querySelector("#composer textarea");
    if (node instanceof HTMLTextAreaElement) node.focus();
  };

  /** 预检写口的统一收口:判合失败要出声(消息本身可照做,见 startup-preflight)。 */
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
    // 未选 = 不发 model_selection,后端回落存档默认;存档默认也没有才由创建失败
    // 报「请先在电脑端设置默认服务商和模型」——那才是该出声的时刻。
    const args = preflightCreateArgs(preflight);
    // 点发送就切页:建会话在后台走,侧栏/顶栏先给出「已受理」的即时反馈。
    props.onSubmitted?.();
    const ok = await submitStartupSession({
      cwd: newSessionCwd(),
      modelSelection: args.modelSelection,
      toolMode: args.toolMode,
      customTools: args.customTools,
      text,
      attachments: startupAttachments(),
    });
    if (!ok) return; // 失败保留草稿,用户改完重试
    setDraftText("");
    clearStartupAttachments();
  };

  return (
    <div class="startup-container">
      <div class="startup-hero">
        {/* §8.7 旧规已废:桌面 TopBar 左格只有汉堡,品牌零露出——主标题回归首页,
            全 UI 品牌只从 STR.productName 出。composer 仍是主角。 */}
        <p class="startup-title">{STR.productName}</p>
        <p class="startup-subtitle">{STR.productTagline} · {STR.homeHeroSubtitle}</p>
        <p class="startup-credit">{STR.poweredBy}</p>
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
              onCreateIn={(path) => {
                setOpenMenu(null);
                // 已经在启动页:这一条的实际效果是改目标 + 把焦点交回输入框
                // (`createSession` 走 `openStartup()` 的同一套收口)。
                createSession(path);
              }}
              onBrowse={() => {
                setOpenMenu(null);
                void chooseNewSessionFolder();
              }}
            />
          </Show>
        </div>

        {/* 服务商与模型的目录菜单。阶段C 会把目录并进强度卡的模型行、连这颗钮
            一起摘掉;在此之前它是预检态的另一个写口,与卡片共用同一份信号,
            两处显示天然同步。换模型整对清叶子(跨模型沿用旧档位会被 resolver
            400 拒),与会话页同规。 */}
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
                    aria-checked={effectiveSelection()?.provider_id === provider.id && effectiveSelection()?.model_id === model.id ? "true" : "false"}
                    onClick={() => {
                      runPreflightWrite(() => ({
                        ...startupPreflight(),
                        modelSelection: { provider_id: provider.id, model_id: model.id, options: {} },
                      }));
                      setOpenMenu(null);
                    }}>
                    {model.definition.display_name || model.id}
                  </button>
                }</For>
              </>}</For>
              <Show when={preflightSelection() != null}>
                <button type="button" title="清除预检，回到「跟随存档默认」(发送时省略 model_selection)"
                  onClick={() => {
                    runPreflightWrite(() => ({ ...startupPreflight(), modelSelection: null }));
                    setOpenMenu(null);
                  }}>
                  跟随存档默认
                </button>
              </Show>
              <button type="button" onClick={() => { setOpenMenu(null); props.onManageProfiles?.(); }}>管理服务商和模型…</button>
            </div>
          </Show>
        </div>
      </div>

      {/* 最近的工作:点卡 = 切消息页并打开会话(路径与侧栏选中一致)。
          冷启动不再自动进会话后,这里是首屏的恢复入口。 */}
      <Show when={props.onOpenSession != null && recentSessions().length > 0}>
        <div class="home-recent">
          <div class="home-recent-head">{STR.homeRecentTitle}</div>
          <div class="home-recent-cards">
            <For each={recentSessions()}>
              {(session) => (
                <button
                  type="button"
                  class="home-recent-card"
                  onClick={() => props.onOpenSession?.(session.session_id)}
                  title={session.cwd ?? undefined}
                >
                  <span class="home-recent-icon" aria-hidden="true"><IconMessageSquare /></span>
                  <span class="home-recent-body">
                    <span class="home-recent-title">{session.title?.trim() || `会话 ${session.session_id.slice(0, 8)}`}</span>
                    <span class="home-recent-meta">{STR.homeRecentMeta(session.turn_count ?? 0)}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

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

      {/* 输入与发送:会话页同一份 Composer。busy 走 `sending`(建会话转 loader),
          不走 `running`——会话还不存在,没有回合可停;`blocked` 恒 null 因为
          启动页没有离线/待授权那面。 */}
      <div class="startup-composer-box">
        <Composer
          draft={draftText}
          onDraft={setDraftText}
          blocked={() => null}
          running={() => false}
          sending={creating}
          onSend={(text) => void handleSubmit(text)}
          onStop={() => { /* running 恒 false:停止分支不会渲染,这个口不会被敲。 */ }}
          focusToken={focusToken()}
          placeholder="输入你的任务需求，或直接提问…"
          onPickAttachments={() => void handlePickAttachments()}
          attachments={startupAttachments}
          onRemoveAttachment={(id) => removeStartupAttachment(id)}
          onScreenshot={props.onScreenshot}
          modelView={() => preflightSelection()?.model_id ?? null}
          modelOverridden={() => preflightSelection() != null}
          onModel={(model) => { runPreflightWrite(() => writePreflightModel(startupPreflight(), registry(), model)); }}
          providerKind={preflightKind}
          effortView={() => {
            const selected = preflightSelection();
            if (selected == null) return null; // 卡片退回全局生效值:那正是后端此刻会解析用的值
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
