/**
 * BYOK 设置的两个分区：**模型与端点(BYOK)** 与 **档案预设**。
 *
 * 拆成两个组件而不是一个（原 `ProfileManager`）：导航里的分区顺序是
 * `模型与端点 → OAuth → 档案预设`，而 `OAuth` 分区要插在两者之间。若两者由
 * 同一个组件渲染，DOM 顺序就是 `模型与端点 → 档案预设 → OAuth`——与导航顺序
 * 不一致，于是点击「OAuth」会滚过「档案预设」，滚动同步还会把高亮算到错的分区上。
 * 「DOM 顺序 == NAV 顺序」是那套滚动跟随逻辑的隐含前提，这里把它补上。
 *
 * 后端语义（config-api 契约）：
 *  - `config.save` 的 Merge Patch 写的是**当前激活档案**，落盘即广播热载，
 *    切模型无需重启 daemon——所以「填字段 → 保存」就是完整的切换流程；
 *  - `profile.apply` 整段换激活档案（有未保存草稿时 store 会拒绝）；
 *  - 密钥读回永远是掩码 `"****"`：留空 = 保持现值，填新值 = 覆盖。
 */
import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import IconEye from "~icons/lucide/eye";
import IconEyeOff from "~icons/lucide/eye-off";
import { STR } from "../../lib/strings";
import { toast } from "../../ui/toast";
import { MASK, REASONING_EFFORTS, WIRE_PROTOCOLS } from "../patch";
import { applyProfile, baseline, busy, deleteProfile, dirty, draft, saveProfileAs, setField } from "../store";
import type { ConfigDto } from "../../api/qaqh/ConfigDto";
import { Field, Section, TextInput } from "../controls";
import { Select } from "../../ui/Select";
import { NumberInput } from "../../ui/NumberInput";
import { isAccountCredential } from "../../oauth/mode";

/** 预设模板:预填 endpoint + wire(与后端 FIRST_RUN_CONFIG 的 DeepSeek 示例一致);
 *  model 各家变动频繁,留空让用户填,不硬编码会过期的 id。 */
const PRESET_TEMPLATES = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", wire: "chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", wire: "responses" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", wire: "messages" },
  // Gemini 的 `:generateContent` 路径由 wire 补;endpoint 必须自带版本前缀
  // (`/v1beta` 不属于 wire 路径),漏掉会打到无版本的 `/models/...`。
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", wire: "gemini" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", wire: "chat" },
  { id: "moonshot", label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.cn/v1", wire: "chat" },
  { id: "custom", label: "自定义", baseUrl: "", wire: "chat" },
] as const;

/** 下拉展示名:规范值 + 官方协议全称。value 恒为规范名(与后端序列化一致)。 */
const WIRE_LABELS: Record<string, string> = {
  chat: "chat（OpenAI Chat Completions）",
  responses: "responses（OpenAI Responses）",
  messages: "messages（Anthropic Messages）",
  gemini: "gemini（Google generateContent）",
};

const secretPlaceholder = (masked: string): string =>
  masked === MASK ? "已配置(留空保持不变)" : "未配置";

/** OAuth（套餐）模式下 wire/endpoint 由那个模式接管，所以本分区的输入置灰。 */
/**
 * 当前是否走**账号额度**（ChatGPT 套餐或 DeepSeek 账号）。
 *
 * 这两种模式下 BYOK 的模型/端点/密钥都不参与请求，所以整段置灰并指路。
 * 名字与判定一起改了：原来叫 `oauthOn`，它把"账号额度"窄化成"OAuth"，
 * 加进 DeepSeek 账号后那个名字会变成误导。
 */
const accountRoute = (): boolean => isAccountCredential(draft());

export const ByokSection: Component = () => {
  const [showKey, setShowKey] = createSignal(false);
  const [newKey, setNewKey] = createSignal("");

  const config = () => draft() ?? baseline() ?? ({
    baseUrl: "",
    wire: "chat",
    model: "",
    apiKey: "",
    reasoningEffort: "",
    maxTokens: 4096,
    contextLength: 128000,
    profiles: [],
    activeProfile: "",
  } as unknown as ConfigDto);

  /** 当前值可能不在后端允许词表里(旧配置留下的),补进选项免得下拉替用户改了值。 */
  const effortOptions = createMemo(() => {
    const current = config().reasoningEffort ?? "";
    // 后端词表就是这份(上游六档,max 与 ultra 都收;见 models/specs.ts 的 ReasoningTier)。
    // 这里多一档就是"选得到却存不下去",少一档就是"存得下去的最高档选不到"。
    const list: string[] = [...REASONING_EFFORTS];
    if (current !== "" && !list.includes(current)) list.unshift(current);
    return list;
  });

  const applyTemplate = (id: string): void => {
    const template = PRESET_TEMPLATES.find((item) => item.id === id);
    if (template == null) return;
    if (template.baseUrl !== "") setField("baseUrl", template.baseUrl);
    setField("wire", template.wire);
    toast(`已套用模板「${template.label}」:填入 API key 与模型 id 后保存`, "info", { dedupeKey: "preset-applied" });
  };

  return (
    /* `fieldset[disabled]` 原生禁用全部后代控件（含 select 与按钮），比逐个传
       disabled 少一圈维护。它包住整个 Section，所以是个普通块级盒、不参与
       `.settings-fields` 的两列网格（**不要**改成 `display:contents`：那会让
       fieldset 在布局树里消失，而 Chromium 的置灰传播依赖布局祖先）。 */
    <fieldset class="settings-fieldset" disabled={accountRoute()}>
      <Section
        id="section-byok"
        title="模型与端点(BYOK)"
        desc={STR.settingsByokDesc}
        aside={
          accountRoute()
            ? "当前用账号额度（ChatGPT 套餐 / DeepSeek 账号）：到「接入」页切换服务商"
            : undefined
        }
      >
        <Field label={STR.settingsTemplate} wide hint={STR.settingsTemplateHint}>
          <Select
            value=""
            keepPlaceholder
            options={PRESET_TEMPLATES.map((template) => ({ value: template.id, label: template.label }))}
            onChange={applyTemplate}
            placeholder="选择预设模板…"
            ariaLabel={STR.settingsTemplate}
          />
        </Field>
        <Field label={STR.settingsEndpoint} wide hint={STR.settingsEndpointHint}>
          <TextInput value={config().baseUrl} onInput={(value) => setField("baseUrl", value)} placeholder="https://…" />
        </Field>
        <Field label={STR.settingsWire}>
          <Select
            value={config().wire}
            options={WIRE_PROTOCOLS.map((wire) => ({ value: wire, label: WIRE_LABELS[wire] ?? wire }))}
            onChange={(value) => setField("wire", value)}
            ariaLabel={STR.settingsWire}
          />
        </Field>
        <Field label={STR.settingsModel}>
          <TextInput value={config().model} onInput={(value) => setField("model", value)} placeholder="模型 id" />
        </Field>
        <Field label="API key" hint={STR.settingsNoDelete} wide>
          <div class="secret-input">
            <TextInput
              type={showKey() ? "text" : "password"}
              value={newKey()}
              placeholder={secretPlaceholder(config().apiKey)}
              autocomplete="new-password"
              spellcheck={false}
              onInput={(value) => {
                setNewKey(value);
                // 留空 → 草稿退回掩码,patch 里就没有 apiKey 这一项。
                setField("apiKey", value.trim() === "" ? config().apiKey : value);
              }}
            />
            <button
              type="button"
              class="icon-btn secret-eye"
              aria-label={showKey() ? "隐藏密钥" : "显示密钥"}
              onClick={() => setShowKey(!showKey())}
            >
              <Show when={showKey()} fallback={<IconEye />}>
                <IconEyeOff />
              </Show>
            </button>
          </div>
        </Field>
        <Field label={STR.settingsReasoningEffort}>
          <Select
            value={config().reasoningEffort}
            options={effortOptions().map((effort) => ({ value: effort, label: effort }))}
            onChange={(value) => setField("reasoningEffort", value)}
            ariaLabel={STR.settingsReasoningEffort}
          />
        </Field>
        <Field
          label={STR.settingsMaxTokens}
          compact
          error={config().maxTokens <= 0 ? "必须是大于 0 的整数" : undefined}
        >
          <NumberInput
            value={config().maxTokens}
            min={1}
            onCommit={(value) => setField("maxTokens", value)}
            ariaLabel={STR.settingsMaxTokens}
          />
        </Field>
        <Field
          label={STR.settingsContextLength}
          hint={STR.settingsContextLengthHint}
          compact
          error={config().contextLength <= 0 ? "必须是大于 0 的整数" : undefined}
        >
          <NumberInput
            value={config().contextLength}
            min={1}
            onCommit={(value) => setField("contextLength", value)}
            ariaLabel={STR.settingsContextLength}
          />
        </Field>
      </Section>
    </fieldset>
  );
};

export const ProfilesSection: Component = () => {
  const [profileName, setProfileName] = createSignal("");
  const config = () => draft() ?? baseline() ?? ({
    baseUrl: "",
    wire: "chat",
    model: "",
    apiKey: "",
    reasoningEffort: "",
    maxTokens: 4096,
    contextLength: 128000,
    profiles: [],
    activeProfile: "",
  } as unknown as ConfigDto);

  return (
    <Section
      id="section-profiles"
      title="档案预设"
      desc="把当前的六字段配置存成命名档案,随时一键切换(切换会整段覆盖草稿,有未保存改动时先保存)。"
      /* 切档案会整段重写激活配置、**包含 credential**——OAuth 模式下点它等于
         把刚打开的模式静默切回 BYOK，所以在那种状态下把三个动作都禁掉。 */
      aside={accountRoute() ? "账号额度模式下请先到「接入」页切换服务商" : undefined}
    >
      <Show when={dirty() && !accountRoute()}>
        <p class="profile-dirty-note">有未保存的改动：先保存或放弃，档案切换/删除/另存才会按当前配置生效。</p>
      </Show>
      <div class="profile-list">
        <For each={config().profiles}>
          {(name) => (
            <div class={`profile-row${name === config().activeProfile ? " active" : ""}`}>
              <span class="profile-name">{name}</span>
              <Show when={name === config().activeProfile}>
                <span class="profile-active-tag">使用中</span>
              </Show>
              <button
                type="button"
                class="ghost-mini"
                disabled={busy() || accountRoute() || dirty()}
                onClick={() => void applyProfile(name)}
              >
                切换
              </button>
              <button
                type="button"
                class="ghost-mini is-danger button-danger"
                disabled={busy() || accountRoute() || dirty() || name === config().activeProfile}
                onClick={() => void deleteProfile(name)}
              >
                删除
              </button>
            </div>
          )}
        </For>
      </div>
      <Field label="把当前配置存为" wide>
        <div class="profile-create">
          <TextInput value={profileName()} onInput={setProfileName} placeholder="档案名" />
          <button
            type="button"
            class="ghost-mini"
            disabled={busy() || accountRoute() || dirty() || profileName().trim() === ""}
            onClick={() => {
              const name = profileName().trim();
              if (name === "") return;
              setProfileName("");
              void saveProfileAs(name);
            }}
          >
            保存
          </button>
        </div>
      </Field>
    </Section>
  );
};
