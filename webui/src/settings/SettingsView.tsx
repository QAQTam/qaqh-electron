/**
 * 设置独立页面：全部分区统一采用 Grouped Inset List + 左文右控 Lite 范式。
 */
import { createEffect, createMemo, createSignal, For, onSettled, Show, type Component } from "solid-js";
import IconRotate from "~icons/lucide/rotate-ccw";
import IconX from "~icons/lucide/x";
import { STR } from "../lib/strings";
import {
  gpuRestartPending,
  performanceMode,
  refreshShellGpuPref,
  setPerformanceMode,
  type PerformanceMode,
} from "../lib/visual";
import { desktopHost } from "../lib/desktop-host";
import { applyTheme, applyThemePreset, storedTheme, themePreset, THEME_PRESET_OPTIONS, type ThemePreset } from "../lib/theme";
import { applyTerminalScheme, TERMINAL_SCHEME_OPTIONS, terminalScheme, type TerminalSchemeId } from "../lib/terminal-theme";
import { setSyntaxPackSelection, setThemePackSelection, syntaxPackSelection, syntaxThemes, themePackSelection, themePacks } from "../plugins/loader";
import {
  FONT_PRESETS,
  FONT_SCALE_OPTIONS,
  type FontScale,
  resetTypography,
  typography,
  updateTypography,
} from "../lib/typography";
import { PERMISSION_TIERS, needsBypassConfirm } from "./patch";
import {
  busy,
  bypassAck,
  changedCount,
  cancelReload,
  confirmDiscard,
  confirmReload,
  reloadPending,
  currentTier,
  dirty,
  discard,
  draft,
  error,
  loading,
  note,
  patch,
  reload,
  requestReload,
  requireBypass,
  save,
  setBypassAck,
  setConfirmDiscard,
  setField,
  setExec,
  setGoals,
  setSandbox,
} from "./store";
import { Switch, TextInput } from "./controls";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { NullableNumberInput, NumberInput } from "../ui/NumberInput";
import { SegmentedControl, type SegmentedOption } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { SettingGroup, SettingRow } from "../ui/SettingGroup";
import { PairingSection } from "./PairingSection";
import { AboutSection } from "./AboutSection";
import { ArchivedSection } from "./ArchivedSection";
import { HostSection } from "./HostSection";
import { ProvidersSection } from "./ProvidersSection";
import { SandboxSection } from "./SandboxSection";
import { refreshRegistry } from "./registry";
import { SETTINGS_NAV, SETTINGS_NAV_GROUPS } from "./navigation";

const REGISTRY_SECTIONS: ReadonlySet<string> = new Set([
  "section-providers",
  "section-pairing",
]);

const LOCAL_SECTIONS: ReadonlySet<string> = new Set([
  "section-host",
  "section-archived",
  "section-appearance",
  "section-about",
]);

const THEME_SEGMENTS: readonly SegmentedOption<string>[] = [
  { value: "", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const PERF_SEGMENTS: readonly SegmentedOption<PerformanceMode>[] = [
  { value: "auto", label: "自动" },
  { value: "low", label: "性能" },
  { value: "quality", label: "画质" },
];

const FontNotices: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal<string | null>(null);
  let req = 0;
  const show = (event: MouseEvent): void => {
    event.preventDefault();
    setOpen(true);
    if (text() != null) return;
    const id = ++req;
    fetch("/fonts/THIRD-PARTY-NOTICES.txt")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => { if (id === req) setText(body); })
      .catch(() => { if (id === req) setText("说明文件读取失败，请检查安装完整性。"); });
  };
  return (
    <>
      <a href="/fonts/THIRD-PARTY-NOTICES.txt" onClick={show}>第三方字体许可</a>
      <Show when={open()}>
        <div class="font-notice-overlay" onClick={() => setOpen(false)}>
          <div class="font-notice-card" role="dialog" aria-modal="true" aria-label="第三方字体许可" onClick={(e) => e.stopPropagation()}>
            <div class="font-notice-head">
              <span>第三方字体许可与来源</span>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
            </div>
            <pre class="font-notice-body">{text() ?? "加载中…"}</pre>
          </div>
        </div>
      </Show>
    </>
  );
};

const FontRow: Component<{
  label: string;
  desc: string;
  value: string;
  presets: Array<{ label: string; value: string }>;
  onChange: (val: string) => void;
}> = (props) => {
  const isCustom = createMemo(
    () => props.value !== "" && !props.presets.some((p) => p.value === props.value),
  );
  const options = createMemo(() => [
    ...props.presets.map((opt) => ({ value: opt.value, label: opt.label })),
    { value: "__custom", label: "自定义字体…" },
  ]);
  return (
    <SettingRow label={props.label} desc={props.desc}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "align-items": "flex-end" }}>
        <Select
          value={isCustom() ? "__custom" : props.value}
          options={options()}
          onChange={(val) => props.onChange(val === "__custom" ? " " : val)}
          ariaLabel={props.label}
        />
        <Show when={isCustom()}>
          <TextInput
            value={props.value.trim()}
            onInput={(val) => props.onChange(val.trim() === "" ? " " : val)}
            placeholder="输入字体名，如 JetBrains Mono"
            spellcheck={false}
          />
        </Show>
      </div>
    </SettingRow>
  );
};

const LocalSettings: Component<{
  activeSection: () => string;
  onSelect: (id: string) => void;
}> = (props) => {
  const [themeChoice, setThemeChoice] = createSignal(storedTheme() ?? "");
  return (
    <>
      <Show when={props.activeSection() === "section-host"}>
        <HostSection onOpenPairing={() => props.onSelect("section-pairing")} />
      </Show>

      <Show when={props.activeSection() === "section-archived"}>
        <ArchivedSection />
      </Show>

      <Show when={props.activeSection() === "section-appearance"}>
        <div id="section-appearance" style={{ display: "flex", "flex-direction": "column", gap: "24px" }}>
          <SettingGroup title="主题与配色">
            <SettingRow label="外观模式" desc="切换浅色或深色界面">
              <SegmentedControl
                aria-label="外观模式"
                options={THEME_SEGMENTS}
                value={themeChoice()}
                onChange={(value) => {
                  setThemeChoice(value);
                  applyTheme(value);
                }}
              />
            </SettingRow>
            <SettingRow label="界面风格" desc="切换预设视觉主题">
              <Select
                value={themePreset()}
                onChange={(value) => applyThemePreset(value as ThemePreset)}
                options={THEME_PRESET_OPTIONS}
                ariaLabel="界面风格"
              />
            </SettingRow>
            <Show when={themePacks().length > 0}>
              <SettingRow label="消息主题包" desc="自定义对话区配色">
                <Select
                  value={themePackSelection()}
                  onChange={(value) => setThemePackSelection(value)}
                  options={[{ value: "", label: "跟随界面" }, ...themePacks().map((pack) => ({ value: pack.id, label: pack.name }))]}
                  ariaLabel="消息主题包"
                />
              </SettingRow>
            </Show>
            <Show when={syntaxThemes().length > 0}>
              <SettingRow label="代码语法高亮" desc="代码块与 Diff 着色方案">
                <Select
                  value={syntaxPackSelection()}
                  onChange={(value) => setSyntaxPackSelection(value)}
                  options={[{ value: "", label: "GitHub（默认）" }, ...syntaxThemes().map((pack) => ({ value: pack.id, label: pack.name }))]}
                  ariaLabel="代码语法高亮"
                />
              </SettingRow>
            </Show>
            <SettingRow label="终端配色" desc="内置终端与命令输出色板">
              <Select
                value={terminalScheme()}
                onChange={(value) => applyTerminalScheme(value as TerminalSchemeId)}
                options={TERMINAL_SCHEME_OPTIONS}
                ariaLabel="终端配色"
              />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="渲染与性能">
            <SettingRow label="性能模式" desc="低配硬件建议选择「性能」以减少模糊与动画">
              <SegmentedControl
                aria-label="性能模式"
                options={PERF_SEGMENTS}
                value={performanceMode()}
                onChange={(value) => setPerformanceMode(value)}
              />
            </SettingRow>
            <Show when={gpuRestartPending()}>
              <SettingRow label="硬件加速已变更" desc="重启桌面端后生效，后台任务不受影响">
                <Button size="sm" variant="primary" onClick={() => { void desktopHost()?.relaunch?.(); }}>
                  重启生效
                </Button>
              </SettingRow>
            </Show>
          </SettingGroup>

          <SettingGroup
            title="字体与排版"
            aside={
              <Button size="sm" variant="ghost" onClick={resetTypography}>
                <IconRotate />
                恢复默认
              </Button>
            }
          >
            <SettingRow label="字号缩放" desc="按比例调整全局文字大小">
              <Select
                value={typography().scale}
                onChange={(value) => updateTypography({ scale: value as FontScale })}
                options={FONT_SCALE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                ariaLabel="字号缩放"
              />
            </SettingRow>
            <FontRow
              label="界面字体"
              desc="导航栏、按钮与表单"
              value={typography().fontUi}
              presets={FONT_PRESETS.ui}
              onChange={(fontUi) => updateTypography({ fontUi })}
            />
            <FontRow
              label="阅读正文"
              desc="对话内容与 Markdown"
              value={typography().fontProse}
              presets={FONT_PRESETS.prose}
              onChange={(fontProse) => updateTypography({ fontProse })}
            />
            <FontRow
              label="代码字体"
              desc="代码块与 Diff 视图"
              value={typography().fontCode}
              presets={FONT_PRESETS.code}
              onChange={(fontCode) => updateTypography({ fontCode })}
            />
            <FontRow
              label="终端字体"
              desc="命令行与工具原始输出"
              value={typography().fontTerminal}
              presets={FONT_PRESETS.terminal}
              onChange={(fontTerminal) => updateTypography({ fontTerminal })}
            />
          </SettingGroup>

          <p class="field-hint" style={{ margin: 0, "padding-inline": "2px" }}>
            外观偏好保存在本机 · <FontNotices />
          </p>
        </div>
      </Show>

      <Show when={props.activeSection() === "section-about"}>
        <AboutSection />
      </Show>
    </>
  );
};

export const SettingsView: Component<{
  initialSection?: string;
  sectionNonce?: number;
  onOpenOAuth?: () => void;
  onSectionChange?: (section: string) => void;
  showSectionPicker?: boolean;
  /** 居中浮层卡片模式（对齐 Antigravity）：内置 200px 左侧目录 + 遮罩 + 右上角关闭按钮。 */
  modal?: boolean;
  onClose?: () => void;
}> = (props) => {
  const [activeSection, setActiveSection] = createSignal<string>(
    props.initialSection ?? SETTINGS_NAV[0].id,
  );
  createEffect(
    () => [props.initialSection, props.sectionNonce] as const,
    ([next]) => {
      if (next != null) setActiveSection(next);
    },
  );
  let page: HTMLElement | undefined;

  onSettled(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    page?.querySelector<HTMLElement>("#settings-title")?.focus();
    void refreshShellGpuPref();
    void reload();
    void refreshRegistry();
    return () => previousFocus?.focus();
  });

  const bypassPending = createMemo(() => requireBypass() && needsBypassConfirm(patch()));

  const activeLabel = createMemo(
    () => SETTINGS_NAV.find((item) => item.id === activeSection())?.label ?? "",
  );

  const selectSection = (id: string): void => {
    setActiveSection(id);
    props.onSectionChange?.(id);
  };

  const registrySection = (id: string): boolean => REGISTRY_SECTIONS.has(id);
  const localSection = (id: string): boolean => LOCAL_SECTIONS.has(id);

  const content = (
    <main
      class={props.modal ? "settings-page is-modal" : "settings-page"}
      ref={(node) => { page = node; }}
      aria-labelledby="settings-title"
    >
      <Show when={props.modal}>
        <aside class="settings-modal-nav" aria-label="设置分区">
          <div class="settings-modal-nav-title">{STR.settings}</div>
          <nav class="settings-modal-nav-list">
            <For each={[...SETTINGS_NAV_GROUPS]}>
              {(group) => (
                <>
                  <div class="settings-nav-group">{group}</div>
                  <For each={SETTINGS_NAV.filter((item) => item.group === group)}>
                    {(item) => (
                      <button
                        type="button"
                        class={`settings-nav-item${activeSection() === item.id ? " active" : ""}`}
                        aria-current={activeSection() === item.id ? "page" : undefined}
                        data-section-id={item.id}
                        onClick={() => selectSection(item.id)}
                      >
                        {item.label}
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </nav>
        </aside>
      </Show>

      <div class="settings-main">
      <header class="settings-head">
        <div class="settings-title">
          <h1 id="settings-title" tabindex={-1}>{activeLabel() || STR.settings}</h1>
        </div>
        <Show when={!props.modal && props.showSectionPicker}>
          <label class="settings-section-picker">
            <span class="sr-only">设置分区</span>
            <select value={activeSection()} onChange={(event) => selectSection(event.currentTarget.value)}>
              <For each={[...SETTINGS_NAV_GROUPS]}>{(group) => <optgroup label={group}>
                <For each={SETTINGS_NAV.filter((item) => item.group === group)}>{(item) => <option value={item.id}>{item.label}</option>}</For>
              </optgroup>}</For>
            </select>
          </label>
        </Show>
        <Show when={dirty()}>
          <Badge tone="accent">{changedCount()} 项未保存</Badge>
        </Show>
        <Show when={props.onClose != null}>
          <button
            type="button"
            class="settings-modal-close"
            aria-label="关闭设置"
            title="关闭设置 (Esc)"
            onClick={() => props.onClose?.()}
          >
            <IconX />
          </button>
        </Show>
      </header>

      <Show when={loading() && draft() == null}>
        <div class="settings-state">{STR.settingsLoading}</div>
      </Show>
      <Show when={draft() == null && !loading() && error() != null}>
        <div class="settings-state is-error">
          <span>{error()}</span>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            {STR.retry}
          </Button>
        </div>
      </Show>

      <div class="settings-body">
        <div class="settings-content">
          <Show when={reloadPending()}>
            <div class="settings-confirm" role="alert">
              <span>重新读取将放弃 {changedCount()} 项未保存的改动。</span>
              <div class="settings-confirm-actions">
                <Button size="sm" variant="ghost" onClick={cancelReload}>取消</Button>
                <Button size="sm" variant="primary" onClick={confirmReload}>放弃并读取</Button>
              </div>
            </div>
          </Show>

          <Show when={registrySection(activeSection())}>
            <Show when={activeSection() === "section-providers"}>
              <ProvidersSection onOpenOAuth={props.onOpenOAuth} />
            </Show>
            <Show when={activeSection() === "section-pairing"}>
              <PairingSection />
            </Show>
          </Show>

          <Show when={!registrySection(activeSection())}>
            <Show when={localSection(activeSection())}>
              <LocalSettings activeSection={activeSection} onSelect={selectSection} />
            </Show>
            <Show when={!localSection(activeSection())}>
              <Show
                when={draft()}
                fallback={<div class="settings-state">{STR.settingsLoading}</div>}
              >
                {(config) => (
                  <>
                    <Show when={activeSection() === "section-permission"}>
                      <div id="section-permission" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
                        <SettingGroup title="工具执行权限" desc="档位越高，自动放行的工具越多；保存后立即生效。">
                          <For each={PERMISSION_TIERS}>
                            {(item) => (
                              <label
                                class="ui-setting-row"
                                style={{ cursor: "pointer", background: config().permissionLevel === item.level ? "var(--surface-hover)" : undefined }}
                              >
                                <div class="ui-setting-row-copy">
                                  <span class="ui-setting-row-label" style={{ display: "inline-flex", "align-items": "center", gap: "8px" }}>
                                    <span>{item.name}</span>
                                    <Show when={item.dangerous}>
                                      <Badge tone="err">高风险</Badge>
                                    </Show>
                                  </span>
                                  <span class="ui-setting-row-desc">{item.desc}</span>
                                </div>
                                <div class="ui-setting-row-control">
                                  <input
                                    type="radio"
                                    name="permission-tier"
                                    value={String(item.level)}
                                    checked={config().permissionLevel === item.level}
                                    onInput={() => setField("permissionLevel", item.level)}
                                  />
                                </div>
                              </label>
                            )}
                          </For>
                        </SettingGroup>
                        <Show when={currentTier() == null}>
                          <p class="field-hint is-error" style={{ margin: 0 }}>
                            当前档位 {config().permissionLevel} 超出有效范围，请先重新选择。
                          </p>
                        </Show>
                        <Show when={bypassPending()}>
                          <div class="bypass-confirm" role="alert">
                            <span>{STR.settingsBypassWarn}</span>
                            <input
                              class="field-input bypass-ack"
                              value={bypassAck()}
                              placeholder="输入 3 确认"
                              onInput={(event) => setBypassAck(event.currentTarget.value)}
                            />
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={activeSection() === "section-sandbox"}>
                      <SandboxSection
                        enabled={config().sandbox?.enabled ?? true}
                        onToggle={(value) => setSandbox(value)}
                      />
                    </Show>

                    <Show when={activeSection() === "section-context"}>
                      <SettingGroup id="section-context" title="上下文管理">
                        <SettingRow label="自动压缩阈值" desc="上下文占用达到该比例时自动压缩（0 ~ 1）">
                          <div class="ui-input-compact">
                            <NumberInput
                              value={config().autoCompactThreshold}
                              integer={false}
                              min={0}
                              max={1}
                              onCommit={(value) => setField("autoCompactThreshold", value)}
                              ariaLabel={STR.settingsAutoCompact}
                            />
                          </div>
                        </SettingRow>
                      </SettingGroup>
                    </Show>

                    <Show when={activeSection() === "section-runtime"}>
                      <SettingGroup id="section-runtime" title="命令与会话">
                        <SettingRow label="默认 Shell" desc="留空自动使用系统默认终端">
                          <TextInput
                            value={config().exec.defaultShell ?? ""}
                            onInput={(value) => setExec("defaultShell", value)}
                            placeholder="auto"
                          />
                        </SettingRow>
                        <SettingRow label="空闲卸载时间（秒）" desc="静置超过该时长后释放内存，0 表示不卸载">
                          <div class="ui-input-compact">
                            <NumberInput
                              value={config().sessionIdleUnloadSecs}
                              min={0}
                              onCommit={(value) => setField("sessionIdleUnloadSecs", value)}
                              ariaLabel={STR.settingsIdleUnload}
                            />
                          </div>
                        </SettingRow>
                      </SettingGroup>
                    </Show>

                    <Show when={activeSection() === "section-goals"}>
                      <SettingGroup id="section-goals" title="目标模式" desc="管理会话持久目标与自动续跑。">
                        <div class="ui-setting-row">
                          <Switch
                            label="启用目标模式"
                            hint="允许声明持久目标并在空闲时自动续跑"
                            checked={config().goals.enabled}
                            onToggle={(value) => setGoals("enabled", value)}
                          />
                        </div>
                        <SettingRow label="单目标 Token 上限" desc="留空表示不限制">
                          <div class="ui-input-compact">
                            <NullableNumberInput
                              value={config().goals.maxTokenBudget}
                              min={1}
                              integer
                              placeholder="无上限"
                              ariaLabel="单目标预算上限"
                              onCommit={(value) => setGoals("maxTokenBudget", value)}
                            />
                          </div>
                        </SettingRow>
                      </SettingGroup>
                    </Show>

                    <Show when={activeSection() === "section-mcp"}>
                      <div id="section-mcp" style={{ display: "flex", "flex-direction": "column", gap: "24px" }}>
                        <SettingGroup title="扩展服务状态" desc="当前仅支持只读查看。">
                          <SettingRow label="MCP 服务" desc={`空闲关闭：${config().mcp.idleShutdownSecs}s`}>
                            <Badge tone={config().mcp.enabled ? "ok" : "neutral"}>
                              {config().mcp.enabled ? "已启用" : "未启用"}
                            </Badge>
                          </SettingRow>
                          <SettingRow label="LSP 语言服务" desc={`空闲关闭：${config().lsp.idleShutdownSecs}s`}>
                            <Badge tone={config().lsp.enabled ? "ok" : "neutral"}>
                              {config().lsp.enabled ? "已启用" : "未启用"}
                            </Badge>
                          </SettingRow>
                        </SettingGroup>

                        <Show when={config().mcp.servers.length > 0}>
                          <SettingGroup title="MCP 服务列表">
                            <For each={config().mcp.servers}>
                              {(server) => (
                                <SettingRow
                                  label={server.name}
                                  desc={server.command !== "" ? server.command : server.url}
                                >
                                  <Badge>{server.transport}</Badge>
                                  <span class="ui-setting-row-value">
                                    {server.tools == null ? "全部工具" : `${server.tools.length} 个工具`}
                                  </span>
                                </SettingRow>
                              )}
                            </For>
                          </SettingGroup>
                        </Show>

                        <Show when={config().lsp.servers.length > 0}>
                          <SettingGroup title="LSP 服务列表">
                            <For each={config().lsp.servers}>
                              {(server) => (
                                <SettingRow label={server.name} desc={server.command}>
                                  <span class="ui-setting-row-value is-mono">{server.extensions.join(", ")}</span>
                                </SettingRow>
                              )}
                            </For>
                          </SettingGroup>
                        </Show>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </div>
      </div>

      <footer class="settings-foot">
        <Show
          when={registrySection(activeSection())}
          fallback={
            <>
              <div class="settings-foot-state">
                <Show when={error() != null}>
                  <span class="settings-error">{error()}</span>
                </Show>
                <Show when={error() == null && note() != null}>
                  <span class="settings-note">{note()}</span>
                </Show>
                <Show when={error() == null && note() == null}>
                  <span class="settings-muted">
                    {changedCount() > 0 ? `${STR.settingsChanged} ${changedCount()} 项` : STR.settingsClean}
                  </span>
                </Show>
              </div>
              <div class="settings-foot-actions">
                <Show when={confirmDiscard()}>
                  <span class="settings-discard">
                    {STR.settingsDiscardAsk}
                    <Button size="sm" variant="danger" onClick={discard}>{STR.settingsDiscardYes}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>{STR.settingsStay}</Button>
                  </span>
                </Show>
                <Button size="sm" variant="ghost" disabled={busy()} onClick={requestReload}>
                  <IconRotate />
                  {STR.settingsReload}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy() || loading() || !dirty()}
                  onClick={() => void save()}
                >
                  {busy() ? STR.settingsSaving : STR.settingsSave}
                </Button>
              </div>
            </>
          }
        >
          <span class="settings-muted">本页改动即时生效。</span>
        </Show>
      </footer>
      </div>
    </main>
  );

  return (
    <Show when={props.modal} fallback={content}>
      <div class="settings-modal-overlay" onClick={() => props.onClose?.()}>
        <div
          class="settings-modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(event) => event.stopPropagation()}
        >
          {content}
        </div>
      </div>
    </Show>
  );
};
