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

/** codex PluginManifest 形状的只读占位(等后端)。 */
const PluginPlaceholder: Component = () => (
  <div class="tools-note">
    <span class="tools-note-icon" aria-hidden="true"><IconPuzzle /></span>
    <div>
      <strong>插件(占位)</strong>
      <p>
        codex 的 plugin = manifest(name/version/description + skills、mcp_servers、hooks
        资源声明)。等后端重写后在这里接 manifest 目录与启停;届时 skills 也能从插件共享资源目录发现。
      </p>
    </div>
  </div>
);

export const ToolsPage: Component = () => {
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
        <p>会话可用的 skills 与扩展。条目由 daemon 按当前工作区目录解析与校验。</p>
        <button type="button" class="ghost-mini tools-refresh" onClick={refresh} disabled={state().status === "scanning"}>
          <IconRefreshCw class={`tools-refresh-icon${state().status === "scanning" ? " spinning" : ""}`} />
          {state().status === "scanning" ? "扫描中…" : "重新扫描"}
        </button>
      </header>

      {/* ── Skills ── */}
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

      {/* ── MCP / LSP(config.load 只读,与设置页同源) ── */}
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

      {/* ── 插件占位 ── */}
      <section class="tools-section" aria-labelledby="plugins-title">
        <h2 id="plugins-title"><IconPackage /> 插件</h2>
        <PluginPlaceholder />
      </section>
    </div>
  );

};
