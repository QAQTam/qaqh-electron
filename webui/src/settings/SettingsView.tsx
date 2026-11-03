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
 * 服务商与存档在 `ProvidersSection` / `ProfilesSection`（命令直写 profiles.toml）;
 * 设备配对在 `PairingSection`;
 * 左侧分区导航是**切换式单页**:点谁渲染谁(2026-10-16 起,原「长滚动+锚点
 * 跳转+scroll-spy」因高亮与视口脱节下线),草稿在 store,切换不丢改动。
 */
import { createEffect, createMemo, createSignal, For, onSettled, Show, type Component } from "solid-js";
import IconRotate from "~icons/lucide/rotate-ccw";
import { STR } from "../lib/strings";
import {
  gpuRestartPending,
  performanceMode,
  refreshShellGpuPref,
  setPerformanceMode,
  sessionMaterial,
  setSessionMaterial,
  type PerformanceMode,
  type SessionMaterial,
} from "../lib/visual";
import { desktopHost } from "../lib/desktop-host";
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
  setSandbox,
  setSubagent,
} from "./store";
import { Field, Section, Switch, TextInput } from "./controls";
import { Select } from "../ui/Select";
import { NumberInput } from "../ui/NumberInput";
import { PairingSection } from "./PairingSection";
import { AboutSection } from "./AboutSection";
import { HostSection } from "./HostSection";
import { ProfilesSection } from "./ProfilesSection";
import { ProvidersSection } from "./ProvidersSection";
import { refreshRegistry, registry as registryState } from "./registry";

/**
 * 左侧分区导航:分组 + 点击切换(切换式单页——点谁渲染谁,不做滚动联动)。
 * `data-section-id` 被 visual-capture.mjs 按 id 点击,改名前先查那边。
 */
const NAV = [
  { id: "section-providers", label: "服务商", group: "接入" },
  { id: "section-profiles", label: "存档", group: "接入" },
  { id: "section-pairing", label: "设备配对", group: "接入" },
  { id: "section-permission", label: "权限档位", group: "运行" },
  { id: "section-context", label: "上下文", group: "运行" },
  { id: "section-runtime", label: "运行时", group: "运行" },
  { id: "section-host", label: "桌面壳", group: "运行" },
  { id: "section-subagent", label: "子代理", group: "运行" },
  { id: "section-mcp", label: "MCP / LSP", group: "运行" },
  { id: "section-appearance", label: "外观", group: "界面" },
  { id: "section-about", label: "关于", group: "关于" },
] as const;

/** 导航渲染顺序 = 分组 contiguous 排列;pane 渲染与顺序无关(各自 Show)。 */
const NAV_GROUP_ORDER = ["接入", "运行", "界面", "关于"] as const;

/** 这些分区即时写 profiles.toml，不参与应用设置的草稿/保存流程。 */
const REGISTRY_SECTIONS: ReadonlySet<string> = new Set([
  "section-providers",
  "section-profiles",
  "section-pairing",
]);

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

export const SettingsView: Component<{
  initialSection?: string;
  /** 同一分区的重复请求也要生效（App 每次打开菜单时递增）。 */
  sectionNonce?: number;
  onOpenOAuth?: () => void;
}> = (props) => {
  // 子代理密钥与工具清单是「只进不出」的本地缓冲:它们的 DOM 文本不等于草稿值
  // (掩码不能回填,逗号串要解析成数组),回填会让用户和输入框互相打架。
  const [subKey, setSubKey] = createSignal("");
  const [toolsInput, setToolsInput] = createSignal("");
  const [themeChoice, setThemeChoice] = createSignal(storedTheme() ?? "");
  const [activeSection, setActiveSection] = createSignal<string>(
    props.initialSection ?? NAV[0].id,
  );
  // 设置页已打开时从菜单/引导跳到指定分区：不能靠 remount，直接跟 prop 走。
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
    // 壳侧 GPU 偏好现状(本次启动 vs 下次启动):撑起「待重启」提示。
    void refreshShellGpuPref();
    // 应用设置草稿与 profiles.toml 名录是两套读模型，并行读，谁失败谁显示错误。
    void reload();
    void refreshRegistry();
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

  /* ── 导航栏拖宽:平滑优先的实现约束 ──
   * 拖拽期不走 Solid 信号(pointermove 每帧直接写 .settings-body 上的
   * `--settings-nav-w` 变量),每帧只有一次 grid 重排、零组件重渲染;
   * rAF 合帧防高频 pointermove 排队。落手(pointerup)才写 localStorage。
   * 双击重置;聚焦后左右方向键微调(Shift 加速)。 */
  const NAV_W_KEY = "settings.navWidth";
  const NAV_W_MIN = 140;
  const NAV_W_MAX = 320;
  let bodyEl: HTMLElement | undefined;
  let resizerEl: HTMLElement | undefined;

  /** 读当前生效的首列宽(变体默认值 168/220 都由 computed style 解出)。 */
  const currentNavWidth = (): number => {
    if (!bodyEl) return 168;
    return parseFloat(getComputedStyle(bodyEl).gridTemplateColumns) || 168;
  };

  const applyNavWidth = (px: number): void => {
    bodyEl?.style.setProperty("--settings-nav-w", `${Math.round(px)}px`);
  };

  const commitNavWidth = (px: number | null): void => {
    if (px == null) {
      bodyEl?.style.removeProperty("--settings-nav-w");
      window.localStorage.removeItem(NAV_W_KEY);
      resizerEl?.removeAttribute("aria-valuenow");
      return;
    }
    const clamped = Math.round(Math.min(NAV_W_MAX, Math.max(NAV_W_MIN, px)));
    applyNavWidth(clamped);
    window.localStorage.setItem(NAV_W_KEY, String(clamped));
    resizerEl?.setAttribute("aria-valuenow", String(clamped));
  };

  onSettled(() => {
    const stored = Number(window.localStorage.getItem(NAV_W_KEY));
    if (Number.isFinite(stored) && stored >= NAV_W_MIN && stored <= NAV_W_MAX) applyNavWidth(stored);
    // 拖拽中断(组件卸载/路由切走)也要摘掉 body 级的拖拽态。
    return () => document.body.classList.remove("settings-resizing");
  });

  const startNavResize = (event: PointerEvent): void => {
    if (!bodyEl) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("settings-resizing");
    handle.classList.add("is-active");
    // 起点一次性测量:首列左缘 = body 左缘 + 左内边距;move 里只做一次减法。
    const bodyRect = bodyEl.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(bodyEl).paddingLeft) || 0;
    const origin = bodyRect.left + padLeft;
    let pending = NaN;
    let raf = 0;
    const flush = (): void => {
      raf = 0;
      applyNavWidth(pending);
    };
    const onMove = (e: PointerEvent): void => {
      pending = e.clientX - origin;
      if (raf === 0) raf = requestAnimationFrame(flush);
    };
    const end = (): void => {
      if (raf !== 0) cancelAnimationFrame(raf);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("settings-resizing");
      handle.classList.remove("is-active");
      // 没动过(pending 为 NaN)不提交,避免单击误重置。
      if (!Number.isNaN(pending)) commitNavWidth(pending);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const nudgeNavWidth = (delta: number): void => {
    commitNavWidth(currentNavWidth() + delta);
  };

  const onResizerKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") { event.preventDefault(); nudgeNavWidth(-step); }
    else if (event.key === "ArrowRight") { event.preventDefault(); nudgeNavWidth(step); }
  };

  /**
   * 切换式单页:点谁渲染谁。没有滚动联动/锚点跳转,不存在「高亮与视口分家」
   * 这一类 bug;未激活分区不渲染,外观区那排字体下拉也不再常驻。
   * 草稿在 `./store` 的 signal 里,切换分区不丢未保存改动。
   */
  const activeLabel = createMemo(
    () => NAV.find((item) => item.id === activeSection())?.label ?? "",
  );

  const registrySection = (id: string): boolean => REGISTRY_SECTIONS.has(id);

  /** 页头副标题读 registry 的名录，而不是应用设置草稿里的 activeProfile。 */
  const defaultProfileName = createMemo(() => {
    const value = registryState();
    if (value?.defaultProfile == null) return null;
    return (
      value.profiles.find((profile) => profile.id === value.defaultProfile)?.name ??
      value.defaultProfile
    );
  });

  return (
    <main class="settings-page" ref={(node) => { page = node; }} aria-labelledby="settings-title">
        <header class="settings-head">
          <div class="settings-title">
            <h1 id="settings-title" tabindex={-1}>{activeLabel() || STR.settings}</h1>
            <Show when={defaultProfileName()}>
              {(name) => <span class="settings-sub">默认存档 · {name()}</span>}
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

              <div class="settings-body" ref={(el) => { bodyEl = el; }}>
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
                  {/* 导航栏拖宽手柄:盖在列间隙上;拖动/双击重置/方向键微调。 */}
                  <div
                    class="settings-nav-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整导航栏宽度(左右拖动,双击重置)"
                    tabindex={0}
                    ref={(el) => { resizerEl = el; }}
                    onPointerDown={startNavResize}
                    onDblClick={() => commitNavWidth(null)}
                    onKeyDown={onResizerKeyDown}
                  />
                  <Show when={reloadPending()}>
                    <div class="settings-confirm" role="alert">
                      <span>重新读取会放弃 {changedCount()} 项未保存的改动。</span>
                      <div class="settings-confirm-actions">
                        <button type="button" class="ghost-mini" onClick={cancelReload}>取消</button>
                        <button type="button" class="primary-mini button-primary" onClick={confirmReload}>放弃并读取</button>
                      </div>
                    </div>
                  </Show>

                  <Show when={registrySection(activeSection())}>
                    <Show when={activeSection() === "section-providers"}>
                      <ProvidersSection
                        onOpenProfiles={() => setActiveSection("section-profiles")}
                        onOpenOAuth={props.onOpenOAuth}
                      />
                    </Show>
                    <Show when={activeSection() === "section-profiles"}>
                      <ProfilesSection />
                    </Show>
                    <Show when={activeSection() === "section-pairing"}>
                      <PairingSection />
                    </Show>
                  </Show>

                  <Show when={!registrySection(activeSection())}>
                    <Show
                      when={draft()}
                      fallback={<div class="settings-state">{STR.settingsLoading}</div>}
                    >
                      {(config) => (
                        <>

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
                    <Switch
                      label="命令沙箱强制隔离 (Sandbox)"
                      hint="启用系统级沙箱隔离运行命令（Windows AppContainer / Linux Landlock & Seccomp）；关闭后将在宿主无隔离环境下直接执行。"
                      checked={config().sandbox?.enabled ?? true}
                      onToggle={(value) => setSandbox(value)}
                    />
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

                  <Show when={activeSection() === "section-host"}>
                    <HostSection onOpenPairing={() => setActiveSection("section-pairing")} />
                  </Show>

                  <Show when={activeSection() === "section-appearance"}>
                  <Section id="section-appearance" title="外观" desc={STR.settingsThemeNote}>
                    <Field label="界面风格预设" hint="纯 CSS 主题预设；Electron 壳当前不提供原生 Mica/材质切换（set_window_theme 返回 false）。">
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
                    <Field label="渲染性能模式" hint="针对受限硬件（双核CPU、弱核显）优化，自动/强制停用毛玻璃模糊与耗性能动画，避免光栅化打满CPU。Performance/auto-低配 同时禁用壳 GPU 加速（省内存）；Quality 启用。更改需重启壳生效。">
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
                    <Show when={gpuRestartPending()}>
                      <Field label="GPU 偏好待生效" hint="渲染性能模式折算的 GPU 加速偏好已保存，与本次启动的实际状态不一致。重启桌面壳后生效；daemon 与后台任务不受影响。">
                        <button
                          type="button"
                          class="button-secondary"
                          onClick={() => { void desktopHost()?.relaunch?.(); }}
                        >
                          重启壳并生效
                        </button>
                      </Field>
                    </Show>

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
                        </>
                      )}
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
                    </>
                  }
                >
                  <span class="settings-muted">
                    本页改动即时写入 profiles.toml；应用设置草稿不受影响。
                  </span>
                </Show>
              </footer>
    </main>
  );
};
