/**
 * 工具页(spec 「工具」):daemon Skills catalog + MCP/LSP 只读表 + 插件占位。
 *
 * skills 由 `skills.catalog` 解析、校验并处理同名遮蔽；renderer 只分组展示。
 *
 * MCP/LSP 复用 config.load 的只读投影(与设置页「MCP / LSP(只读)」同源,
 * SettingsView.tsx:465-503);插件(plugin)按 codex PluginManifest 形状留占位。
 *
 * Skills catalog 只给 metadata；正文需要后续读取能力支持时再接线。
 */
import { loadConfigSnapshot } from "../lib/config-snapshot";

import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import type { JSX } from "@solidjs/web";
import IconBlocks from "~icons/lucide/blocks";
import IconCable from "~icons/lucide/cable";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconFolderTree from "~icons/lucide/folder-tree";
import IconPackage from "~icons/lucide/package";
import IconPuzzle from "~icons/lucide/puzzle";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconSparkles from "~icons/lucide/sparkles";
import IconTriangleAlert from "~icons/lucide/triangle-alert";
import IconUserRound from "~icons/lucide/user-round";
import { Markdown } from "../markdown/Markdown";
import { rescanSkills, scanState, type SkillEntry, type SkillIssue } from "../skills/scan";
import { workspaceCatalog } from "../tabs/store";
import { pluginStatus } from "../plugins/loader";
import { isDesktopRuntime, requireDesktopHost } from "../lib/desktop-host";
import type { ConfigDto } from "../api/qaqh/ConfigDto";

/** 一张 skill 卡:头行常显,点开渲染正文。 */
const SkillCard: Component<{ skill: SkillEntry }> = (props) => {
  const [open, setOpen] = createSignal(false);
  return (
    <article class={`skill-card${props.skill.shadowed ? " is-shadowed" : ""}`}>
      <button
        type="button"
        class="skill-card-head"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
      >
        <span class="skill-card-icon" aria-hidden="true"><IconSparkles /></span>
        <span class="skill-card-titles">
          <strong>{props.skill.name}</strong>
          <span class="skill-card-desc">{props.skill.shortDescription ?? props.skill.description}</span>
        </span>
        <span class="skill-card-meta">
          <Show when={props.skill.shadowed}>
            <span class="skill-card-flag" title="同名 skill 已被更高优先级的根先占(qaqh-skills 的 seen_names 同规则)">
              被同名覆盖
            </span>
          </Show>
          <span class="skill-card-source" title={props.skill.path}>{props.skill.workspace}</span>
          <IconChevronDown class={`skill-card-chevron${open() ? " is-open" : ""}`} />
        </span>
      </button>
      <Show when={open()}>
        <div class="skill-card-body">
          <p class="skill-card-path" title={props.skill.path}>{props.skill.path}</p>
          <Show when={props.skill.body != null && props.skill.body !== ""}>
            <Markdown text={() => props.skill.body ?? ""} streaming={false} />
          </Show>
        </div>
      </Show>
    </article>
  );
};

/** 一组 skill(项目级 / 用户级共用同一张卡、同一个空态与同一个诊断条形状)。 */
const SkillGroup: Component<{
  title: string;
  hint: string;
  icon: (props: { class?: string }) => JSX.Element;
  skills: SkillEntry[];
  issues: SkillIssue[];
  empty: string;
}> = (props) => (
  <section class="skill-group" aria-label={props.title}>
    <header class="skill-group-head">
      <span class="skill-group-icon" aria-hidden="true">{props.icon({})}</span>
      <strong>{props.title}</strong>
      <span class="skill-group-count">{props.skills.length}</span>
      <span class="skill-group-hint">{props.hint}</span>
    </header>
    <Show when={props.issues.length > 0}>
      <div class="tools-issues">
        <For each={props.issues}>
          {(issue) => (
            <p class={`tools-issue${issue.forbidden ? " is-forbidden" : ""}`}>
              <IconTriangleAlert />
              <span>
                <b>{issue.root}</b>:{issue.forbidden ? " 目录不在 daemon 可读根内——把它注册为工作区即可读。" : ` ${issue.message}`}
              </span>
            </p>
          )}
        </For>
      </div>
    </Show>
    <Show
      when={props.skills.length > 0}
      fallback={<p class="tools-muted skill-group-empty">{props.empty}</p>}
    >
      <For each={props.skills}>{(skill) => <SkillCard skill={skill} />}</For>
    </Show>
  </section>
);

/* ── 前端插件管理 ──────────────────────────────────────────────────────
 * main 侧 frontend-plugins.ts 是事实源(双根合并 + state.json 启停);
 * 这里只是它的操作面。graph 帧(热应用)由 plugins/loader.ts 独立消费,
 * 启停/导入/删除后 stat-poll 1s 内自动生效——本面板不需要等推送。 */

interface ManagedPlugin {
  id: string;
  name: string;
  version: string;
  slot: string;
  source: "bundled" | "user";
  enabled: boolean;
  path: string;
}

const SLOT_LABELS: Record<string, string> = { theme: "主题包", overlay: "浮层" };

const PluginManager: Component = () => {
  const desktop = isDesktopRuntime();
  const [plugins, setPlugins] = createSignal<ManagedPlugin[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const invoke = <T,>(cmd: Parameters<ReturnType<typeof requireDesktopHost>["invoke"]>[0], args?: Record<string, unknown>): Promise<T> =>
    desktop ? requireDesktopHost().invoke<T>(cmd, args) : Promise.reject(new Error("桌面壳不可用"));
  const fail = (cause: unknown): void => { setError(cause instanceof Error ? cause.message : String(cause)); };
  const refresh = (): void => {
    if (!desktop) return;
    invoke<ManagedPlugin[]>("frontend_plugins:list").then(setPlugins).catch(fail);
  };
  refresh(); // setup 期一次性拉取;后续动作都以返回值同步列表
  const afterMutation = (list: ManagedPlugin[]): void => { setPlugins(list); setError(null); };
  const toggle = (plugin: ManagedPlugin): void => {
    setBusy(true);
    invoke<ManagedPlugin[]>("frontend_plugins:set_enabled", { id: plugin.id, enabled: !plugin.enabled })
      .then(afterMutation).catch(fail).finally(() => setBusy(false));
  };
  const remove = (plugin: ManagedPlugin): void => {
    setBusy(true);
    invoke<ManagedPlugin[]>("frontend_plugins:remove", { id: plugin.id })
      .then(afterMutation).catch(fail).finally(() => setBusy(false));
  };
  const importPlugin = (): void => {
    setBusy(true);
    invoke<ManagedPlugin | null>("frontend_plugins:import")
      .then((entry) => { if (entry != null) refresh(); })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  return (
    <section class="tools-section" aria-labelledby="plugins-title">
      <h2 id="plugins-title"><IconPackage /> 前端插件</h2>
      <p class="tools-muted">插件是纯数据:装在 <code>~/.qaqh/frontend-plugin</code>(用户根),壳每秒扫描热应用;主题包只改消息区配色,浮层插件挂界面元素。</p>
      <Show when={!desktop}>
        <div class="tools-note">
          <span class="tools-note-icon" aria-hidden="true"><IconTriangleAlert /></span>
          <div><strong>仅在桌面壳内可用</strong><p>浏览器开发模式没有插件宿主。</p></div>
        </div>
      </Show>
      <div class="fp-toolbar">
        <button type="button" class="ghost-mini" onClick={importPlugin} disabled={busy() || !desktop}>
          <IconPuzzle /> 导入插件包（zip / 文件夹）
        </button>
        <button type="button" class="ghost-mini" onClick={refresh} disabled={busy() || !desktop}>
          <IconRefreshCw class={`tools-refresh-icon${busy() ? " spinning" : ""}`} /> 刷新
        </button>
        {/* 轻量"重启壳":整页重载 → did-finish-load 再次强制重发插件图。 */}
        <button type="button" class="ghost-mini" onClick={() => void invoke("force_refresh")} disabled={!desktop}
          title="重新加载整个界面(等价重启壳,会话不丢)">
          <IconRefreshCw /> 强制刷新页面
        </button>
      </div>
      {/* 装载器自述:图到了没(frames>0)、挂了谁、失败为什么——一眼定位"插件没上线"。 */}
      <p class="fp-diag">
        装载器: 收图 {pluginStatus().frames} 帧 · 图内 {pluginStatus().entries.map((entry) => entry.id).join(", ") || "空"} ·
        已挂载 {pluginStatus().mounted.join(", ") || "无"} ·
        主题面 {pluginStatus().themeApplied ?? "经典(未挂)"}
        <For each={Object.entries(pluginStatus().failed)}>
          {([id, message]) => <span class="fp-diag-fail"> · {id} 失败: {message}</span>}
        </For>
      </p>
      <Show when={error()}>
        <p class="tools-issue"><IconTriangleAlert /> <span>{error()}</span></p>
      </Show>
      <Show when={desktop && !busy() && plugins().length === 0} fallback={null}>
        <p class="tools-muted skill-group-empty">还没有前端插件——把插件文件夹或 .zip 导入进来。</p>
      </Show>
      <For each={plugins()}>
        {(plugin) => (
          <article class="fp-row">
            <span class="skill-group-icon" aria-hidden="true">{plugin.slot === "theme" ? <IconSparkles /> : <IconPuzzle />}</span>
            <span class="fp-titles">
              <strong>{plugin.name}</strong>
              <span class="fp-sub">{plugin.id}{plugin.version !== "" ? ` · v${plugin.version}` : ""} · {SLOT_LABELS[plugin.slot] ?? plugin.slot} · {plugin.source === "user" ? "用户导入" : "随包"}</span>
            </span>
            <span class={`fp-status${plugin.enabled ? " on" : " off"}`}>{plugin.enabled ? "已激活" : "已禁用"}</span>
            <span class="fp-actions">
              <button type="button" class="ghost-mini" onClick={() => void invoke("frontend_plugins:reveal", { id: plugin.id })} title="打开所在目录">目录</button>
              <button type="button" class="ghost-mini" onClick={() => toggle(plugin)} disabled={busy()}>{plugin.enabled ? "禁用" : "激活"}</button>
              <Show when={plugin.source === "user"}>
                <button type="button" class="ghost-mini" onClick={() => remove(plugin)} disabled={busy()}>删除</button>
              </Show>
            </span>
          </article>
        )}
      </For>
    </section>
  );
};

export const ToolsPage: Component<{ toolsTab?: "skills" | "mcp" | "plugins" }> = (props) => {
  /* 分区导航在左栏(Sidebar 的 TOOLS_NAV,App 持状态)——内容区不再自带菜单。 */
  const tab = () => props.toolsTab ?? "skills";
  const state = scanState;
  const [config, setConfig] = createSignal<ConfigDto | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);

  const loadConfig = (): void => {
    loadConfigSnapshot()
      .then((dto) => { setConfig(dto); setConfigError(null); })
      .catch((cause) => { setConfigError(cause instanceof Error ? cause.message : String(cause)); });
  };

  /**
   * 项目级扫描的触发点绑在**工作区注册表的路径集合**上,而不是 onSettled 那一瞬。
   *
   * 注册表是异步到的(`refreshWorkspaces` 拉 `workspace.list`),而工具页可以在它到达
   * 之前就挂载(启动即切到工具页)——那一刻扫出来的项目级永远是空的,且不会有
   * 任何后续事件来纠正。判据取路径签名而不是数组引用:`pollSessions` 每轮都换一个
   * 新数组,按引用判会让 15s 一次的轮询带着整轮重扫一起跑。
   */
  let workspaceSignature: string | null = null;
  createEffect(
    () => workspaceCatalog().map((workspace) => workspace.path).sort().join("\n"),
    (signature) => {
      if (signature === workspaceSignature) return;
      workspaceSignature = signature;
      void rescanSkills();
    },
  );

  onSettled(() => {
    loadConfig();
  });

  const refresh = (): void => {
    void rescanSkills();
    loadConfig();
  };

  return (
    <div class="tools-page">
      <header class="tools-page-head">
        <h1>工具</h1>
        <p>会话可用的 skills、MCP 与前端插件。skills/MCP 由 daemon 解析校验；前端插件由壳管理。</p>
        <Show when={tab() !== "plugins"}>
          <button type="button" class="ghost-mini tools-refresh" onClick={refresh} disabled={state().status === "scanning"}>
            <IconRefreshCw class={`tools-refresh-icon${state().status === "scanning" ? " spinning" : ""}`} />
            {state().status === "scanning" ? "扫描中…" : "重新扫描"}
          </button>
        </Show>
      </header>

      {/* ── Skills ── */}
      <Show when={tab() === "skills"}>
      <section class="tools-section" aria-labelledby="skills-title">
        <h2 id="skills-title"><IconBlocks /> Skills</h2>
        <Show when={state().daemonUnreachable}>
          <div class="tools-note">
            <span class="tools-note-icon" aria-hidden="true"><IconTriangleAlert /></span>
            <div>
              <strong>daemon 不可达，无法读取 skills catalog</strong>
              <p>恢复 daemon 连接后重新扫描。</p>
            </div>
          </div>
        </Show>
        {/* 两组常显:空态、诊断与卡片各有归属——组头带发现根,「一个都没有」才可自查。 */}
        <SkillGroup
          title="项目级"
          hint="由 daemon catalog 提供"
          icon={IconFolderTree}
          skills={state().project}
          issues={state().issues.filter((issue) => issue.scope === "project")}
          empty={state().status === "scanning" ? "读取中…" : "当前工作区 catalog 没有 project skills。"}
        />
        <SkillGroup
          title="用户级"
          hint="由 daemon catalog 提供"
          icon={IconUserRound}
          skills={state().user}
          issues={state().issues.filter((issue) => issue.scope === "user")}
          empty={state().status === "scanning" ? "读取中…" : "catalog 没有 user skills。"}
        />
      </section>
      </Show>

      {/* ── MCP / LSP(config.load 只读,与设置页同源) ── */}
      <Show when={tab() === "mcp"}>
      <section class="tools-section" aria-labelledby="mcp-title">
        <h2 id="mcp-title"><IconCable /> MCP / LSP</h2>
        <Show when={configError != null}>
          <p class="tools-issue"><IconTriangleAlert /> <span>config.load 失败:{configError()}</span></p>
        </Show>
        <Show when={config()} fallback={<p class="tools-muted">读取 MCP 配置中…</p>}>
          {(current) => (
            <>
              <div class="readonly-grid">
                <span>mcp.enabled</span><b>{String(current().mcp.enabled)}</b>
                <span>mcp.idleShutdownSecs</span><b>{String(current().mcp.idleShutdownSecs)}</b>
                <span>lsp.enabled</span><b>{String(current().lsp.enabled)}</b>
              </div>
              <Show when={current().mcp.servers.length > 0}>
                <table class="readonly-table">
                  <thead>
                    <tr><th>server</th><th>transport</th><th>command / url</th><th>tools</th></tr>
                  </thead>
                  <tbody>
                    <For each={current().mcp.servers}>
                      {(server) => (
                        <tr>
                          <td>{server.name}</td>
                          <td>{server.transport}</td>
                          <td>{server.command !== "" ? server.command : server.url}</td>
                          <td>{server.tools == null ? "全部" : String(server.tools.length)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
              <Show when={current().lsp.servers.length > 0}>
                <table class="readonly-table">
                  <thead>
                    <tr><th>server</th><th>command</th><th>extensions</th></tr>
                  </thead>
                  <tbody>
                    <For each={current().lsp.servers}>
                      {(server) => (
                        <tr>
                          <td>{server.name}</td>
                          <td>{server.command}</td>
                          <td>{server.extensions.join(", ")}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </>
          )}
        </Show>
      </section>
      </Show>

      {/* ── 前端插件(管理面,详见文件头注释) ── */}
      <Show when={tab() === "plugins"}>
        <PluginManager />
      </Show>
    </div>
  );

};
