/**
 * 设置独立页面:daemon 全局配置的读写面(spec 里的「第二阶段·设置页」)。
 *
 * 只呈现 `ConfigDto` 里真实存在的字段,写路径只发差异 patch(见 `./patch`)。
 * 三条来自后端的硬约束在 UI 上有直接体现:
 *  - 密钥读回来永远是 `"****"`(掩码,qaqh-config/src/dto.rs:22),所以密钥框是
 *    「留空 = 不改」的新增值输入,不做双向绑定;后端没有删除密钥的接口,UI 也不假装能删。
 *  - `"" = 保持现值` 的字符串(model/baseUrl/reasoningEffort)
 *    清空不会生效(dto.rs:10-11),所以这些框清空即视作未改动。
 *  - MCP/LSP 只有读模型(ConfigDto:56-59 注明写模型另立),这里只读展示。
 *
 * BYOK 六字段与档案预设拆在 `byok/Sections`(两个分区按导航分别渲染);
 * 设备配对在 `PairingSection`;
 * 左侧分区导航是**切换式单页**:点谁渲染谁(2026-10-16 起,原「长滚动+锚点
 * 跳转+scroll-spy」因高亮与视口脱节下线),草稿在 store,切换不丢改动。
 */
import { createEffect, createMemo, createSignal, For, onSettled, Show, type Component } from "solid-js";
import IconRotate from "~icons/lucide/rotate-ccw";
import { STR } from "../lib/strings";
import {
  performanceMode,
  setPerformanceMode,
  sessionMaterial,
  setSessionMaterial,
  type PerformanceMode,
  type SessionMaterial,
} from "../lib/visual";
import { applyTheme, applyThemePreset, storedTheme, themePreset, THEME_PRESET_OPTIONS, type ThemePreset } from "../lib/theme";
import {
  FONT_PRESETS,
  FONT_SCALE_OPTIONS,
  type FontScale,
  resetTypography,
  typography,
  updateTypography,
} from "../lib/typography";
import { MASK, PERMISSION_TIERS, THEME_OPTIONS, formatToolList, needsBypassConfirm, parseToolList } from "./patch";
import {
  baseline,
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
  setSubagent,
} from "./store";
import { Field, Section, Switch, TextInput } from "./controls";
import { Select } from "../ui/Select";
import { NumberInput } from "../ui/NumberInput";
import { ByokSection, ProfilesSection } from "./byok/Sections";
import { PairingSection } from "./PairingSection";
import { AboutSection } from "./AboutSection";

/**
 * 左侧分区导航:分组 + 点击切换(切换式单页——点谁渲染谁,不做滚动联动)。
 * `data-section-id` 被 visual-capture.mjs 按 id 点击,改名前先查那边。
 */
const NAV = [
  { id: "section-byok", label: "模型与端点", group: "接入" },
  { id: "section-profiles", label: "档案预设", group: "接入" },
  { id: "section-pairing", label: "设备配对", group: "接入" },
  { id: "section-permission", label: "权限档位", group: "运行" },
  { id: "section-context", label: "上下文", group: "运行" },
  { id: "section-runtime", label: "运行时", group: "运行" },
  { id: "section-subagent", label: "子代理", group: "运行" },
  { id: "section-mcp", label: "MCP / LSP", group: "运行" },
  { id: "section-appearance", label: "外观", group: "界面" },
  { id: "section-about", label: "关于", group: "关于" },
] as const;

/** 导航渲染顺序 = 分组 contiguous 排列;pane 渲染与顺序无关(各自 Show)。 */
const NAV_GROUP_ORDER = ["接入", "运行", "界面", "关于"] as const;

const FontPicker: Component<{
  label: string;
  hint: string;
  value: string;
  presets: Array<{ label: string; value: string }>;
  onChange: (val: string) => void;
}> = (props) => {
  const isCustom = createMemo(
    () => props.value !== "" && !props.presets.some((p) => p.value === props.value),
  );
  const options = createMemo(() => [
    ...props.presets.map((opt) => ({ value: opt.value, label: opt.label })),
    { value: "__custom", label: "自定义字体名称…" },
  ]);
  return (
    <Field label={props.label} hint={props.hint}>
      <div style={{ display: "grid", gap: "6px" }}>
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
            placeholder="输入本地字体族名，如 'JetBrains Mono'"
            spellcheck={false}
          />
        </Show>
      </div>
    </Field>
  );
};

export const SettingsView: Component = () => {
  // 子代理密钥与工具清单是「只进不出」的本地缓冲:它们的 DOM 文本不等于草稿值
  // (掩码不能回填,逗号串要解析成数组),回填会让用户和输入框互相打架。
  const [subKey, setSubKey] = createSignal("");
  const [toolsInput, setToolsInput] = createSignal("");
  const [themeChoice, setThemeChoice] = createSignal(storedTheme() ?? "");
  const [activeSection, setActiveSection] = createSignal<string>(NAV[0].id);
  let page: HTMLElement | undefined;

  onSettled(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    page?.querySelector<HTMLElement>("#settings-title")?.focus();
    return () => previousFocus?.focus();
  });

  // 基线换了(载入/保存/切 profile)才重置缓冲——它们不参与 patch 构建。
  createEffect(
    () => baseline(),
    (base) => {
      setSubKey("");
      setToolsInput(base == null ? "" : formatToolList(base.subagent.defaultTools));
    },
  );

  const secretPlaceholder = (masked: string): string =>
    masked === MASK ? "已配置(留空保持不变)" : "未配置";

  const bypassPending = createMemo(() => requireBypass() && needsBypassConfirm(patch()));

  /**
   * 切换式单页:点谁渲染谁。没有滚动联动/锚点跳转,不存在「高亮与视口分家」
   * 这一类 bug;未激活分区不渲染,外观区那排字体下拉也不再常驻。
   * 草稿在 `./store` 的 signal 里,切换分区不丢未保存改动。
   */
  const activeLabel = createMemo(
    () => NAV.find((item) => item.id === activeSection())?.label ?? "",
  );

  return (
    <main class="settings-page" ref={(node) => { page = node; }} aria-labelledby="settings-title">
        <header class="settings-head">
          <div class="settings-title">
            <h1 id="settings-title" tabindex={-1}>{activeLabel() || STR.settings}</h1>
            <Show when={(draft()?.activeProfile ?? "") !== ""}>
              <span class="settings-sub">profile · {draft()?.activeProfile}</span>
            </Show>
          </div>
          <Show when={dirty()}>
            <span class="settings-dirty-pill">{changedCount()} 项未保存</span>
          </Show>
        </header>

        <Show when={loading() && draft() == null}>
          <div class="settings-state">{STR.settingsLoading}</div>
        </Show>
        <Show when={draft() == null && !loading() && error() != null}>
          <div class="settings-state is-error">
            <span>{error()}</span>
            <button type="button" class="ghost-mini" onClick={() => void reload()}>
              {STR.retry}
            </button>
          </div>
        </Show>

        <Show when={draft()}>
          {(config) => (
            <>
              <div class="settings-body">
                <nav class="settings-nav" aria-label="设置分区">
                  <For each={[...NAV_GROUP_ORDER]}>
                    {(group) => (
                      <>
                        <div class="settings-nav-group">{group}</div>
                        <For each={NAV.filter((item) => item.group === group)}>
                          {(item) => (
                            <button
                              type="button"
                              class={`settings-nav-item${activeSection() === item.id ? " active" : ""}`}
                              aria-current={activeSection() === item.id ? "location" : undefined}
                              data-section-id={item.id}
                              onClick={() => setActiveSection(item.id)}
                            >
                              {item.label}
                            </button>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </nav>
                <div class="settings-content">
                  <Show when={reloadPending()}>
                    <div class="settings-confirm" role="alert">
                      <span>重新读取会放弃 {changedCount()} 项未保存的改动。</span>
                      <div class="settings-confirm-actions">
                        <button type="button" class="ghost-mini" onClick={cancelReload}>取消</button>
                        <button type="button" class="primary-mini button-primary" onClick={confirmReload}>放弃并读取</button>
                      </div>
                    </div>
                  </Show>

                  <Show when={activeSection() === "section-byok"}>
                    <ByokSection />
                  </Show>

                  <Show when={activeSection() === "section-profiles"}>
                    <ProfilesSection />
                  </Show>

                  <Show when={activeSection() === "section-permission"}>
                  <Section
                    id="section-permission"
                    title="权限档位"
                    desc="权限越高,自动放行的工具越多。改动保存后立即生效。"
                  >
                    <div class="tier-list">
                      <For each={PERMISSION_TIERS}>
                        {(item) => (
                          <label
                            class={`tier${config().permissionLevel === item.level ? " active" : ""}${
                              item.dangerous ? " dangerous" : ""
                            }`}
                          >
                            <input
                              type="radio"
                              name="permission-tier"
                              value={String(item.level)}
                              checked={config().permissionLevel === item.level}
                              onInput={() => setField("permissionLevel", item.level)}
                            />
                            <span class="tier-name">{item.name}</span>
                            <span class="tier-desc">{item.desc}</span>
                          </label>
                        )}
                      </For>
                    </div>
                    <Show when={currentTier() == null}>
                      <p class="field-hint">
                        读到的档位 {config().permissionLevel} 不在 1..=3 内——后端会拒绝保存,请先选一个合法档位。
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
                  </Section>
                  </Show>

                  <Show when={activeSection() === "section-context"}>
                  <Section id="section-context" title="上下文与压缩">
                    <Field label={STR.settingsAutoCompact} hint={STR.settingsAutoCompactHint}>
                      <NumberInput
                        value={config().autoCompactThreshold}
                        integer={false}
                        min={0}
                        max={1}
                        onCommit={(value) => setField("autoCompactThreshold", value)}
                        ariaLabel={STR.settingsAutoCompact}
                      />
                    </Field>
                    <Field label={STR.settingsTokenizer} hint={STR.settingsTokenizerHint} wide>
                      <TextInput
                        value={config().tokenizerPath ?? ""}
                        onInput={(value) => setField("tokenizerPath", value)}
                        placeholder="…/tokenizer.json"
                      />
                    </Field>
                    <Switch
                      label={STR.settingsCompliance}
                      hint={STR.settingsComplianceHint}
                      checked={config().complianceEnabled}
                      onToggle={(value) => setField("complianceEnabled", value)}
                    />
                  </Section>
                  </Show>

                  <Show when={activeSection() === "section-runtime"}>
                  <Section id="section-runtime" title="运行时">
                    <Field label={STR.settingsDefaultShell} hint={STR.settingsDefaultShellHint}>
                      <TextInput
                        value={config().exec.defaultShell ?? ""}
                        onInput={(value) => setExec("defaultShell", value)}
                        placeholder="auto"
                      />
                    </Field>
                    <Field label={STR.settingsIdleUnload} hint={STR.settingsIdleUnloadHint} compact>
                      <NumberInput
                        value={config().sessionIdleUnloadSecs}
                        min={0}
                        onCommit={(value) => setField("sessionIdleUnloadSecs", value)}
                        ariaLabel={STR.settingsIdleUnload}
                      />
                    </Field>
                  </Section>
                  </Show>

                  <Show when={activeSection() === "section-appearance"}>
                  <Section id="section-appearance" title="外观" desc={STR.settingsThemeNote}>
                    <Field label="界面风格预设" hint="默认跟随系统（Windows 使用 Fluent，macOS 使用原生材质）；也可手动选择预设。">
                      <Select
                        value={themePreset()}
                        onChange={(value) => applyThemePreset(value as ThemePreset)}
                        options={THEME_PRESET_OPTIONS}
                        ariaLabel="界面风格预设"
                      />
                    </Field>
                    <Field label={STR.settingsTheme}>
                      <Select
                        value={themeChoice()}
                        onChange={(value) => {
                          setThemeChoice(value);
                          applyTheme(value);
                        }}
                        options={THEME_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                        ariaLabel={STR.settingsTheme}
                      />
                    </Field>
                    <Field label="会话标签材质" hint="仅保存在此应用窗口，不写入 daemon 配置。">
                      <Select
                        value={sessionMaterial()}
                        onChange={(value) => setSessionMaterial(value as SessionMaterial)}
                        options={[
                          { value: "glass", label: "Glass（跟随窗口材质）" },
                          { value: "solid", label: "Solid（实色）" },
                        ]}
                        ariaLabel="会话标签材质"
                      />
                    </Field>
                    <Field label="渲染性能模式" hint="针对受限硬件（双核CPU、弱核显）优化，自动/强制停用毛玻璃模糊与耗性能动画，避免光栅化打满CPU。">
                      <Select
                        value={performanceMode()}
                        onChange={(value) => setPerformanceMode(value as PerformanceMode)}
                        options={[
                          { value: "auto", label: "Auto（自动：低配双核硬件默认开启）" },
                          { value: "low", label: "Performance（低资源/极速模式：纯色实底）" },
                          { value: "quality", label: "Quality（画质模式：保持毛玻璃滤镜）" },
                        ]}
                        ariaLabel="渲染性能模式"
                      />
                    </Field>

                    <Field label="全局字号缩放" hint="等比缩放界面中所有字阶（90% ~ 120%），纯前端即时生效。">
                      <Select
                        value={typography().scale}
                        onChange={(value) => updateTypography({ scale: value as FontScale })}
                        options={FONT_SCALE_OPTIONS.map((opt) => ({ value: opt.value, label: `${opt.label} — ${opt.desc}` }))}
                        ariaLabel="全局字号缩放"
                      />
                    </Field>

                    <FontPicker
                      label="界面骨架字体 (--font-ui)"
                      hint="侧边栏、标题栏与按钮表单，留空为系统默认。"
                      value={typography().fontUi}
                      presets={FONT_PRESETS.ui}
                      onChange={(fontUi) => updateTypography({ fontUi })}
                    />

                    <FontPicker
                      label="消息阅读正文 (--font-prose)"
                      hint="AI 回答、用户气泡与 Markdown 正文，留空跟随界面。"
                      value={typography().fontProse}
                      presets={FONT_PRESETS.prose}
                      onChange={(fontProse) => updateTypography({ fontProse })}
                    />

                    <FontPicker
                      label="代码块与差异 (--font-code)"
                      hint="Markdown 代码块与 DiffView 对比行，留空为 Cascadia。"
                      value={typography().fontCode}
                      presets={FONT_PRESETS.code}
                      onChange={(fontCode) => updateTypography({ fontCode })}
                    />

                    <FontPicker
                      label="终端与工具输出 (--font-terminal)"
                      hint="命令行执行输出与控制台原始日志，留空为 Menlo/Consolas。"
                      value={typography().fontTerminal}
                      presets={FONT_PRESETS.terminal}
                      onChange={(fontTerminal) => updateTypography({ fontTerminal })}
                    />

                    <div style={{ "grid-column": "1 / -1", display: "flex", "align-items": "center", "justify-content": "space-between", "margin-top": "4px" }}>
                      <span class="settings-muted">字体与字号偏好保存在本地，不影响后端会话。</span>
                      <button type="button" class="ghost-mini" onClick={resetTypography}>
                        <IconRotate /> 恢复默认排版
                      </button>
                    </div>

                    <p class="settings-section-desc">
                      界面内嵌 HarmonyOS Sans SC 与 Cascadia Code；字体许可与来源见{" "}
                      <a href="/fonts/THIRD-PARTY-NOTICES.txt">第三方字体说明</a>。
                    </p>
                  </Section>
                  </Show>

                  <Show when={activeSection() === "section-subagent"}>
                  <Section
                    id="section-subagent"
                    title="子代理"
                    desc={STR.settingsSubagentDesc}
                  >
                    <Field label={STR.settingsSubagentModel} hint={STR.settingsSubagentNewOnlyHint}>
                      <TextInput value={config().subagent.model} onInput={(value) => setSubagent("model", value)} />
                    </Field>
                    <Field label={STR.settingsSubagentBaseUrl} hint={STR.settingsSubagentNewOnlyHint}>
                      <TextInput value={config().subagent.baseUrl} onInput={(value) => setSubagent("baseUrl", value)} />
                    </Field>
                    <Field label={STR.settingsSubagentApiKey} hint={STR.settingsSubagentApiKeyHint(config().subagent.apiKeySet)}>
                      <TextInput
                        type="password"
                        value={subKey()}
                        placeholder={secretPlaceholder(config().subagent.apiKey)}
                        onInput={(value) => {
                          setSubKey(value);
                          setSubagent("apiKey", value.trim() === "" ? config().subagent.apiKey : value);
                        }}
                      />
                    </Field>
                    <Field label={STR.settingsSubagentMaxTokens} hint={STR.settingsSubagentNewOnlyHint} compact>
                      <NumberInput
                        value={config().subagent.maxTokens}
                        min={1}
                        onCommit={(value) => setSubagent("maxTokens", value)}
                        ariaLabel={STR.settingsSubagentMaxTokens}
                      />
                    </Field>
                    <Field label={STR.settingsSubagentTimeout} hint={STR.settingsSubagentNewOnlyHint} compact>
                      <NumberInput
                        value={config().subagent.timeoutSecs}
                        min={1}
                        onCommit={(value) => setSubagent("timeoutSecs", value)}
                        ariaLabel={STR.settingsSubagentTimeout}
                      />
                    </Field>
                    <Field label={STR.settingsSubagentMaxDepth} hint={STR.settingsSubagentMaxDepthHint} compact>
                      <NumberInput
                        value={config().subagent.maxDepth}
                        min={1}
                        max={16}
                        onCommit={(value) => setSubagent("maxDepth", value)}
                        ariaLabel={STR.settingsSubagentMaxDepth}
                      />
                    </Field>
                    <Field label={STR.settingsSubagentInFlight} hint={STR.settingsSubagentInFlightHint} compact>
                      <NumberInput
                        value={config().subagent.messageInFlightPerPair}
                        min={1}
                        onCommit={(value) => setSubagent("messageInFlightPerPair", value)}
                        ariaLabel={STR.settingsSubagentInFlight}
                      />
                    </Field>
                    <Field label={STR.settingsSubagentOutbound} hint={STR.settingsSubagentOutboundHint} compact>
                      <NumberInput
                        value={config().subagent.messageOutboundPerSender}
                        min={1}
                        onCommit={(value) => setSubagent("messageOutboundPerSender", value)}
                        ariaLabel={STR.settingsSubagentOutbound}
                      />
                    </Field>
                    <Field label={STR.settingsSubagentTools} hint={STR.settingsSubagentToolsHint} wide>
                      <TextInput
                        value={toolsInput()}
                        placeholder="read, write"
                        onInput={(value) => {
                          setToolsInput(value);
                          setSubagent("defaultTools", parseToolList(value));
                        }}
                      />
                    </Field>
                  </Section>
                  </Show>

                  <Show when={activeSection() === "section-pairing"}>
                    <PairingSection />
                  </Show>

                  <Show when={activeSection() === "section-mcp"}>
                  <Section
                    id="section-mcp"
                    title="MCP / LSP(只读)"
                    desc="当前仅支持查看;编辑能力会随 workspace 权限模型后续开放。"
                  >
                    <div class="readonly-grid">
                      <span>mcp.enabled</span>
                      <b>{String(config().mcp.enabled)}</b>
                      <span>mcp.idleShutdownSecs</span>
                      <b>{String(config().mcp.idleShutdownSecs)}</b>
                      <span>lsp.enabled</span>
                      <b>{String(config().lsp.enabled)}</b>
                      <span>lsp.idleShutdownSecs</span>
                      <b>{String(config().lsp.idleShutdownSecs)}</b>
                    </div>
                    <Show when={config().mcp.servers.length > 0}>
                      <table class="readonly-table">
                        <thead>
                          <tr>
                            <th>server</th>
                            <th>transport</th>
                            <th>command / url</th>
                            <th>tools</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={config().mcp.servers}>
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
                    <Show when={config().lsp.servers.length > 0}>
                      <table class="readonly-table">
                        <thead>
                          <tr>
                            <th>server</th>
                            <th>command</th>
                            <th>extensions</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={config().lsp.servers}>
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
                  </Section>
                  </Show>

                  <Show when={activeSection() === "section-about"}>
                    <AboutSection />
                  </Show>
                </div>
              </div>

              <footer class="settings-foot">
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
                      <button type="button" class="ghost-mini" onClick={discard}>
                        {STR.settingsDiscardYes}
                      </button>
                      <button type="button" class="ghost-mini" onClick={() => setConfirmDiscard(false)}>
                        {STR.settingsStay}
                      </button>
                    </span>
                  </Show>
                  <button type="button" class="ghost-mini" disabled={busy()} onClick={requestReload}>
                    <IconRotate />
                    {STR.settingsReload}
                  </button>
                  <button
                    type="button"
                    class="primary-mini button-primary"
                    disabled={busy() || loading() || !dirty()}
                    onClick={() => void save()}
                  >
                    {busy() ? STR.settingsSaving : STR.settingsSave}
                  </button>
                </div>
              </footer>
            </>
          )}
        </Show>
    </main>
  );
};
