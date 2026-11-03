/**
 * 「接入」页 —— 账号额度（ChatGPT 套餐 / DeepSeek 账号）的登录与启用。
 *
 * 写路径已经收口到 `profiles.toml`：登录成功后用 `ensureAccountProfile` 创建/更新
 * 该账号的 Provider + 存档，再把默认指针拨过去。页面不再持有前端 provider 状态，
 * 也不再改写 `ConfigDto` 的顶层模型字段 —— 那些只是读投影。
 *
 * 授权 URL 交给**系统浏览器**打开；daemon 不 spawn 进程、也不内嵌 webview。
 * 自带 API key 的配置统一在「设置 → 存档」维护，这里只展示入口。
 */
import { createSignal, For, Match, onSettled, Show, Switch, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";

import type { ConfigDto } from "../api/qaqh/ConfigDto";
import { DsAccountCard } from "../dsaccount/components/AccountCard";
import {
  dsAccountView,
  type DsAccountStatus,
  type DsVerifyResult,
} from "../dsaccount/state";
import {
  defaultDsSignInDeps,
  dsaccountBalance,
  dsaccountSignInCancel,
  dsaccountSignOut,
  dsaccountStatus,
  dsaccountVerify,
  runDeepSeekSignIn,
  type DsBalance,
} from "../lib/dsaccount";
import {
  openExternal,
  runSignInFlow,
  siwcSignInCancel,
  siwcSignInStart,
  siwcSignInStatus,
  siwcSignOut,
  siwcStatus,
} from "../lib/siwc";
import { transport } from "../lib/transport";
import { isDesktopRuntime } from "../lib/transport/backend";
import { modelSpec, type SpecBucket } from "../models/specs";
import { siwcApiBase, siwcPlanBadgeVisible, type SiwcSessionStatus } from "../siwc/brand";
import { SiwcConnectionCard } from "../siwc/components/ConnectionCard";
import { SiwcFirstRunNotice } from "../siwc/components/FirstRunNotice";
import { SiwcSignInButton } from "../siwc/components/SignInButton";
import { siwcAccountView } from "../siwc/state";
import { toast } from "../ui/toast";
import {
  DSACCOUNT_CONTEXT_LENGTH,
  OAUTH_CONTEXT_LENGTH,
  providerKindOfCredential,
} from "./mode";
import {
  catalogKindOf,
  fetchModelCatalog,
  modelOptions,
  preferredModel,
  specBucketOfKind,
  type CatalogKind,
  type ModelEntry,
} from "./model-catalog";
import {
  ensureAccountProfile,
  refreshRegistry,
  registry,
  registryError,
} from "../settings/registry";

/** 接入页只管理两类账号额度；BYOK 在「设置 → 存档」。 */
type AccountEntry = {
  id: "plan" | "account";
  name: string;
  kind: "plan" | "account";
  credential: "chatgpt_plan" | "deepseek_account";
};

const ACCOUNT_PROVIDERS: readonly AccountEntry[] = [
  { id: "plan", name: "ChatGPT 套餐", kind: "plan", credential: "chatgpt_plan" },
  { id: "account", name: "DeepSeek 账号", kind: "account", credential: "deepseek_account" },
];

/** 首次成功启用套餐后的欢迎卡只出现一次，看过的标记留在本机。 */
const FIRST_RUN_KEY = "siwc.firstRunSeen";

function firstRunSeen(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    return true;
  }
}

function markFirstRunSeen(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // 忽略：下次仍会弹一次。
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type QuotaRow = { label: string; value: string; tone?: "ok" | "muted" };

/** 一家目录的读取状态（按**来源**分槽：套餐与 DeepSeek 账号各有各的目录，互不覆盖）。 */
type CatalogSlot = { entries: ModelEntry[] | null; error: string | null; busy: boolean };

const EMPTY_SLOT: CatalogSlot = { entries: null, error: null, busy: false };

/**
 * 模型列表（接入页）：条目来自**这一家自己的**目录 —— 套餐读 ChatGPT 目录，
 * DeepSeek 账号读平台 `/models`；BYOK 没有账户级目录，那张卡不渲染这个块。
 *
 * 生效中的那张卡点了就落盘（`config.save {model}`）；还没生效的那张只把选择记进
 * 该 provider 的槽位、切换时一起写过去 —— 否则"给一家还没在用的服务商选模型"会
 * 把它的模型名塞进当前配置，等于替用户切了半个服务商。
 */
const ModelList: Component<{
  active: boolean;
  providerName: string;
  bucket: SpecBucket;
  /** 当前**生效**的模型名（只有本卡生效时才等于"本卡的选中项"）。 */
  model: string | null;
  /** `null` = 还没拿到目录（与"拿到了但是空目录"是两回事，文案不能混）。 */
  options: ModelEntry[] | null;
  busy: boolean;
  error: string | null;
  onReload: () => void;
  onPick: (slug: string) => void;
}> = (props) => {
  const selected = (slug: string): boolean => props.active && props.model === slug;

  return (
    <div class="oauth-models">
      <div class="oauth-models__head">
        <span class="oauth-models__title">
          {props.active ? "模型" : `切到${props.providerName}时用的模型`}
        </span>
        <button type="button" class="ghost-mini" disabled={props.busy} onClick={() => props.onReload()}>
          {props.busy ? "读取中…" : "刷新目录"}
        </button>
      </div>

      <Show
        when={(props.options ?? []).length > 0}
        fallback={
          <div class="oauth-models__empty">
            <p class="oauth-models__note">
              {props.options == null
                ? (props.error ?? "正在读取这一家的模型目录…")
                : (props.error ?? "这一家返回的模型目录是空的：先完成登录，再点「刷新目录」。")}
            </p>
            <p class="oauth-models__note oauth-models__note--muted">
              目录拿不到也能推理：输入区强度卡里的模型那一行可以直接填模型 id（账号额度模式下设置页的 BYOK 字段是置灰的）。
            </p>
          </div>
        }
      >
        <div class="oauth-models__list" role="listbox" aria-label={`${props.providerName} 模型目录`}>
          <For each={props.options ?? []}>
            {(entry) => {
              const known = modelSpec(props.bucket, entry.slug).known;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected(entry.slug) ? "true" : "false"}
                  class={selected(entry.slug) ? "selected" : undefined}
                  disabled={props.busy}
                  onClick={() => props.onPick(entry.slug)}
                >
                  <span>{entry.displayName}</span>
                  <small>{entry.slug}</small>
                  <Show when={!known}>
                    <small class="oauth-models__unknown">未收录</small>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

/**
 * 服务商摘要行：登录与当前来源分别呈现，详情按需展开。
 * 隐藏详情不占布局空间，但保留 DOM，收起不会重置账号卡或登录流程。
 */
const ProviderRow: Component<{
  entry: AccountEntry;
  active: boolean;
  /** 当前生效的模型名（用于展示；来自 daemon 配置，不是本卡的本地状态）。 */
  model: string | null;
  /** 这一家的模型目录条目；`null` = 还没拿到。 */
  options: ModelEntry[] | null;
  catalogBusy: boolean;
  catalogError: string | null;
  /** 展开 / 点「刷新目录」：按这一家的来源拉一次目录。 */
  onEnsureCatalog: (force?: boolean) => void;
  /** 选一条模型：写进该账号的规范存档。 */
  onPickModel: (slug: string) => void;
  status: SiwcSessionStatus | null;
  busy: boolean;
  onSwitch: () => void;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  onOpenUsage: (url: string) => void;
  /** DeepSeek 账号那一家的状态与动作（`kind === "account"` 时才用）。 */
  dsStatus: DsAccountStatus | null;
  dsBalance: DsBalance | null;
  dsBusy: boolean;
  onDsSignIn: () => void;
  onDsCancel: () => void;
  onDsSignOut: () => void;
  /** 刷新 = 验证（见 `dsVerifyNotice`）。 */
  dsVerify: DsVerifyResult | null;
  dsVerifyBusy: boolean;
  onDsVerify: () => void;
  onDsOpenLink: (url: string) => void;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const detailsId = () => `oauth-details-${props.entry.id}`;
  const planView = () => siwcAccountView(props.status);
  const accountView = () => dsAccountView(props.dsStatus);
  const connected = (): boolean => props.status?.status === "connected";
  const accountLabel = (): string => {
    if (props.entry.kind === "account") {
      switch (accountView().kind) {
        case "loading": return "读取中…";
        case "connecting": return "等待浏览器授权";
        case "signed-in": return `已登录 · ${accountView().displayName ?? "DeepSeek 账号"}`;
        case "damaged": return "需要重新登录";
        default: return "未登录";
      }
    }
    switch (planView().kind) {
      case "connecting": return "等待浏览器授权";
      case "reauth-required": return "需要重新登录";
      case "identity-only": return "已登录 · 套餐用量未启用";
      case "plan": return "已登录 · 套餐用量已启用";
      default: return "未登录";
    }
  };
  const toggleDetails = (): void => {
    if (!expanded()) props.onEnsureCatalog();
    setExpanded(!expanded());
  };

  /** 模型展示名 + 是否收录（未收录要说出来，不能让用户以为我们认得它）。 */
  const modelLabel = (): string | null => {
    if (props.model == null || props.model === "") return null;
    const { spec, known } = modelSpec(specBucketOfKind(props.entry.kind), props.model);
    const name = spec.displayName ?? props.model;
    const base = name === props.model ? name : `${name}（${props.model}）`;
    return known ? base : `${base} · 未收录`;
  };

  /** 只显示用户看得懂、且**不撒谎**的几行。 */
  const quotaRows = (): QuotaRow[] => {
    const current = props.status;
    const rows: QuotaRow[] = [];
    const account = current?.email ?? current?.name ?? current?.label;
    if (account != null && account !== "") rows.push({ label: "账户", value: account });
    if (current != null) {
      rows.push({
        label: "套餐用量",
        value: siwcPlanBadgeVisible(current)
          ? "已启用"
          : connected()
            ? "未启用（仅登录，请求不走套餐）"
            : "未连接",
        tone: siwcPlanBadgeVisible(current) ? "ok" : "muted",
      });
    }
    // 配置中的模型属于当前来源，不能把 DeepSeek 模型展示在未启用的 OpenAI 详情中。
    const model = props.active ? modelLabel() : null;
    if (model != null) rows.push({ label: "模型", value: model });
    const apiBase = siwcApiBase(current);
    if (apiBase != null) rows.push({ label: "端点", value: apiBase });
    return rows;
  };

  return (
    <article
      class={`oauth-provider${props.active ? " is-active" : ""}`}
      data-provider={props.entry.id}
    >
      <div class="oauth-provider__summary">
        <div class="oauth-provider__identity">
          <div class="oauth-provider__heading">
            <h3>{props.entry.name}</h3>
            <Show when={props.active}><span class="oauth-provider__active">当前使用</span></Show>
          </div>
          <p class="oauth-provider__status">{accountLabel()}</p>
          <Show when={!expanded() && (props.entry.kind === "account" ? accountView().error : planView().error)}>
            {(message) => <p class="oauth-provider__error">{message()}</p>}
          </Show>
        </div>
        <div class="oauth-provider__actions">
          <Show when={props.entry.kind === "plan"}>
            <Show when={["disconnected", "reauth-required", "identity-only"].includes(planView().kind)}>
              <SiwcSignInButton disabled={props.busy} onPress={() => props.onSignIn()} />
            </Show>
            <Show when={planView().kind === "connecting"}>
              <button type="button" class="ghost-mini" onClick={() => props.onCancel()}>取消登录</button>
            </Show>
          </Show>
          <Show when={props.entry.kind === "account"}>
            <Show when={accountView().canSignIn}>
              <button type="button" class="oauth-provider__connect" disabled={props.dsBusy} onClick={() => props.onDsSignIn()}>
                {accountView().kind === "damaged" ? "重新登录" : "登录"}
              </button>
            </Show>
            <Show when={accountView().canCancel}>
              <button type="button" class="ghost-mini" onClick={() => props.onDsCancel()}>取消登录</button>
            </Show>
          </Show>
          <button
            type="button"
            class="ghost-mini oauth-provider__toggle"
            aria-label={`${expanded() ? "收起" : "展开"}${props.entry.name}详情`}
            aria-expanded={expanded() ? "true" : "false"}
            aria-controls={detailsId()}
            onClick={toggleDetails}
          >
            <span>{expanded() ? "收起" : "详情"}</span>
            <IconChevronDown />
          </button>
        </div>
      </div>

      <div id={detailsId()} class="oauth-provider__details" hidden={!expanded()}>
        <Switch>
          <Match when={props.entry.kind === "plan"}>
            <SiwcConnectionCard
              status={props.status}
              busy={props.busy}
              hideSignInActions
              onSignIn={() => props.onSignIn()}
              onCancel={() => props.onCancel()}
              onSignOut={() => props.onSignOut()}
              onOpenUsage={(url) => props.onOpenUsage(url)}
            />
            <Show when={quotaRows().length > 0}>
              <dl class="oauth-quota">
                <For each={quotaRows()}>
                  {(row) => (
                    <>
                      <dt>{row.label}</dt>
                      <dd
                        class={
                          row.tone === "muted" ? "is-muted" : row.tone === "ok" ? "is-ok" : undefined
                        }
                      >
                        {row.value}
                      </dd>
                    </>
                  )}
                </For>
              </dl>
            </Show>
          </Match>
          <Match when={props.entry.kind === "account"}>
            <DsAccountCard
              status={props.dsStatus}
              balance={props.dsBalance}
              busy={props.dsBusy}
              hideSignInActions
              onSignIn={() => props.onDsSignIn()}
              onCancel={() => props.onDsCancel()}
              onSignOut={() => props.onDsSignOut()}
              verify={props.dsVerify}
              verifyBusy={props.dsVerifyBusy}
              onVerify={() => props.onDsVerify()}
              onOpenLink={(url) => props.onDsOpenLink(url)}
            />
          </Match>
        </Switch>

        <ModelList
          active={props.active}
          providerName={props.entry.name}
          bucket={specBucketOfKind(props.entry.kind)}
          model={props.model}
          options={props.options}
          busy={props.catalogBusy}
          error={props.catalogError}
          onReload={() => props.onEnsureCatalog(true)}
          onPick={(slug) => props.onPickModel(slug)}
        />

        <Show when={!props.active}>
          <button
            type="button"
            class="ghost-mini"
            disabled={props.busy || (props.entry.kind === "account" && props.dsBusy)}
            onClick={() => props.onSwitch()}
          >
            设为当前来源
          </button>
        </Show>
      </div>
    </article>
  );
};

export const OAuthPage: Component<{ onOpenSettings?: () => void }> = (props) => {
  const available = isDesktopRuntime();
  /** `config.load` 读投影：用来判断当前默认存档用的是哪家账号、显示模型名。 */
  const [config, setConfig] = createSignal<ConfigDto | null>(null);
  const [status, setStatus] = createSignal<SiwcSessionStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [flowId, setFlowId] = createSignal<string | null>(null);
  const [firstRun, setFirstRun] = createSignal(false);
  /** DeepSeek 账号态与余额（余额只在已登录时读）。 */
  const [dsStatus, setDsStatus] = createSignal<DsAccountStatus | null>(null);
  const [dsBalance, setDsBalance] = createSignal<DsBalance | null>(null);
  const [dsBusy, setDsBusy] = createSignal(false);
  const [dsAttempt, setDsAttempt] = createSignal<string | null>(null);

  /**
   * 模型目录（按来源分槽）。`entries == null` 与 `entries == []` 是两回事：
   * 前者是"还没拿到"（登录没完成 / 还没展开过详情），后者是"这家确实给了个空表"，
   * 文案必须分开，否则用户不知道该去登录还是该来提 bug。
   */
  const [catalogs, setCatalogs] = createSignal<Partial<Record<CatalogKind, CatalogSlot>>>({});

  const patchSlot = (kind: CatalogKind, next: Partial<CatalogSlot>): void => {
    const previous = catalogs();
    const merged: CatalogSlot = { ...EMPTY_SLOT, ...previous[kind], ...next };
    // 不用 updater 形式：Solid 2 的 setter 在 `Partial<Record<...>>` 上会挑到
    // 返回 `void` 的重载，写出来是类型噪音而不是安全。读一次再整份替换即可。
    setCatalogs({ ...previous, [kind]: merged });
  };

  /**
   * 按 provider 类别取一次目录。成功过就不自动重拉（`force` 给「刷新目录」按钮），
   * 失败**不清空**已有条目：一次网络抖动不该让选择器变空。
   */
  const ensureCatalog = async (kind: CatalogKind, force = false): Promise<void> => {
    if (!available) return;
    const slot = catalogs()[kind];
    if (slot?.busy === true) return;
    if (!force && slot?.entries != null) return;
    patchSlot(kind, { busy: true });
    try {
      patchSlot(kind, { entries: await fetchModelCatalog(kind), error: null, busy: false });
    } catch (cause) {
      patchSlot(kind, { entries: slot?.entries ?? null, error: messageOf(cause), busy: false });
    }
  };

  const slotOf = (entry: AccountEntry): CatalogSlot => {
    const kind = catalogKindOf(entry.kind);
    return kind == null ? EMPTY_SLOT : (catalogs()[kind] ?? EMPTY_SLOT);
  };

  /** 该账号在 profiles.toml 里的规范存档（可能还没创建）。 */
  const accountProfile = (entry: AccountEntry) =>
    registry()?.profiles.find((profile) => profile.credential === entry.credential);

  /** 一张卡该列出的模型条目（`null` = 目录还没到位）。 */
  const optionsOf = (entry: AccountEntry): ModelEntry[] | null => {
    const entries = slotOf(entry).entries;
    if (entries == null) return null;
    // 当前生效的模型与存档里那条都可能不在目录里（切过账户、上游改名），
    // 也要列出来 —— 否则列表里没有选中项，用户以为目录是坏的。
    const extras = [
      activeId() === entry.id ? (config()?.model ?? null) : null,
      accountProfile(entry)?.model ?? null,
    ];
    return modelOptions(entry.kind, entries, extras);
  };

  /** 当前默认存档用的是哪家账号；BYOK / 未配置时 null。 */
  const activeId = (): string | null => {
    const credential = config()?.credential;
    if (credential === "chatgpt_plan") return "plan";
    if (credential === "deepseek_account") return "account";
    return null;
  };

  const loadConfig = async (): Promise<void> => {
    if (!available) return;
    try {
      const next = await transport.query<ConfigDto>({ type: "config.load" });
      setConfig(next);
      setError(null);
      // 生效那一家的模型目录：不拉的话，接入页与输入区都只能显示"空列表"。
      const kind = catalogKindOf(providerKindOfCredential(next.credential));
      if (kind != null) void ensureCatalog(kind);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const refreshStatus = async (): Promise<void> => {
    if (!available) return;
    try {
      setStatus(await siwcStatus());
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  /** 读 DeepSeek 账号态；已登录才去读余额（未登录时后端给 not_signed_in）。 */
  const refreshDs = async (): Promise<void> => {
    if (!available) return;
    try {
      const next = await dsaccountStatus();
      setDsStatus(next);
      setDsBalance(next.signedIn ? await dsaccountBalance() : null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  onSettled(() => {
    if (!available) return;
    void loadConfig();
    void refreshRegistry();
    void refreshStatus();
    void refreshDs();
    const timer = window.setInterval(() => {
      if (flowId() == null) void refreshStatus();
      // 登录进行中由流程驱动自己轮询，页面这边不掺和（免得两个轮询抢状态）。
      if (dsAttempt() == null) void refreshDs();
    }, 10_000);
    return () => window.clearInterval(timer);
  });

  const contextFor = (entry: AccountEntry): number =>
    entry.kind === "plan" ? OAUTH_CONTEXT_LENGTH : DSACCOUNT_CONTEXT_LENGTH;

  /** 官方端点只从后端取：套餐来自 `siwc.status.apiBase`，DeepSeek 来自账号态。 */
  const accountBaseUrl = (entry: AccountEntry): string | null =>
    entry.kind === "plan" ? siwcApiBase(status()) : (dsStatus()?.inferenceOrigin ?? null);

  /**
   * 把账号落成 Provider + 存档。
   *
   * `makeDefault = true` = 用户明确「启用 / 设为当前来源」；`false` = 只更新该账号
   * 的规范存档（例如在卡里换了模型，但当前用的是另一家）。
   *
   * `fromSignIn` 给登录流程用：登录本身已经占着 busy，那一路是**同一次用户意图**
   * 的延续，不该被并发保护挡下来。
   */
  const configureAccount = async (
    entry: AccountEntry,
    makeDefault: boolean,
    options: { fromSignIn?: boolean } = {},
  ): Promise<boolean> => {
    if (busy() && options.fromSignIn !== true) return false;
    const baseUrl = accountBaseUrl(entry);
    if (baseUrl == null) {
      setError(`还没有读到 ${entry.name} 的官方端点：请先完成登录`);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const kind = catalogKindOf(entry.kind);
      let catalog: ModelEntry[] = [];
      if (kind != null) {
        try {
          catalog = await fetchModelCatalog(kind);
          patchSlot(kind, { entries: catalog, error: null, busy: false });
        } catch (cause) {
          patchSlot(kind, { error: messageOf(cause), busy: false });
        }
      }
      const profile = accountProfile(entry);
      const chosen = profile?.model.trim();
      const model =
        chosen != null && chosen !== ""
          ? chosen
          : (preferredModel({ catalog }) ?? "");
      if (model === "") {
        setError(`${entry.name} 的模型目录为空：先刷新目录，或到「设置 → 存档」手填模型 id`);
        return false;
      }
      const result = await ensureAccountProfile({
        kind: entry.kind,
        baseUrl,
        model,
        contextLength: contextFor(entry),
        makeDefault,
      });
      if (result == null) {
        setError(registryError() ?? "账号存档写入失败");
        return false;
      }
      await loadConfig();
      toast(
        makeDefault ? `已启用 ${entry.name}` : `${entry.name} 的存档已更新`,
        "ok",
        { dedupeKey: "account-saved" },
      );
      return true;
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await runSignInFlow(
        { onStarted: (id) => setFlowId(id) },
        {
          start: siwcSignInStart,
          status: siwcSignInStatus,
          cancel: siwcSignInCancel,
          openExternal,
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
      );
      if (outcome.kind === "completed") {
        await refreshStatus();
        await loadConfig();
        if (status()?.sharing === true && !firstRunSeen()) setFirstRun(true);
        toast("ChatGPT 账户已连接", "info", { dedupeKey: "siwc-connected" });
        await activateIfIdle(ACCOUNT_PROVIDERS[0]!);
      } else if (outcome.kind === "failed") {
        setError(outcome.message);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setFlowId(null);
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const id = flowId();
    if (id == null) return;
    try {
      await siwcSignInCancel(id);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await siwcSignOut();
      await refreshStatus();
      if (!result.revoked) {
        toast("已在本机登出；远端撤销未确认，可在 ChatGPT 设置里断开本应用", "info", {
          dedupeKey: "siwc-revoke-unconfirmed",
        });
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 在接入页选一条模型：写进该账号的规范存档。
   *
   * 当前默认就是这家时，`config.load` 的读投影会跟着变；不是这家时只更新存档，
   * 不动默认指针 —— 不能因为给未启用的账号挑模型就把正在用的来源换掉。
   */
  const pickModel = async (target: AccountEntry, slug: string): Promise<void> => {
    if (config() == null || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const baseUrl = accountBaseUrl(target);
      if (baseUrl == null) {
        setError(`还没有读到 ${target.name} 的官方端点：请先完成登录`);
        return;
      }
      const result = await ensureAccountProfile({
        kind: target.kind,
        baseUrl,
        model: slug,
        contextLength: contextFor(target),
        makeDefault: activeId() === target.id,
      });
      if (result == null) {
        setError(registryError() ?? "模型写入失败");
        return;
      }
      await loadConfig();
      toast(`已切换模型：${slug}`, "ok", { dedupeKey: "model-switch" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 登录成功后该不该自动启用这一家。
   *
   * 只在**当前还停在 BYOK** 时启用：登录账号额度的目的就是用它推理，登录后还要
   * 用户自己找「切到这一家」，等于把一次操作拆成两次（而且期间胶囊开关的样子
   * 与事实相反）。已经在用**另一家**账号额度时不动 —— 用户可能只是顺手多登一个
   * 账户，静默换掉正在跑的额度比少一步更糟。
   */
  const activateIfIdle = async (entry: AccountEntry): Promise<void> => {
    if (config() == null || activeId() != null) return;
    await configureAccount(entry, true, { fromSignIn: true });
  };

  const dsSignIn = async (): Promise<void> => {
    setDsBusy(true);
    setError(null);
    try {
      const outcome = await runDeepSeekSignIn(
        { onStarted: (attemptId) => setDsAttempt(attemptId) },
        defaultDsSignInDeps,
      );
      if (outcome.kind === "completed") {
        await refreshDs();
        await loadConfig();
        toast("DeepSeek 账号已连接", "info", { dedupeKey: "dsaccount-connected" });
        await activateIfIdle(ACCOUNT_PROVIDERS[1]!);
      } else if (outcome.kind === "failed") {
        setError(outcome.message);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDsAttempt(null);
      setDsBusy(false);
    }
  };

  const dsCancel = async (): Promise<void> => {
    const attemptId = dsAttempt();
    if (attemptId == null) return;
    try {
      await dsaccountSignInCancel(attemptId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const [dsVerify, setDsVerify] = createSignal<DsVerifyResult | null>(null);
  const [dsVerifyBusy, setDsVerifyBusy] = createSignal(false);

  /**
   * 「刷新」的真实含义是**验证**：问一次远端"这把凭据还有效吗"。
   *
   * 这是唯一能回答它的动作——本地有密文不等于凭据有效。失效时后端会**顺手清掉
   * 本地凭据**（那条一直缺的 401→清凭据链），所以这里只负责把状态与余额重读一遍。
   */
  const dsVerifyNow = async (): Promise<void> => {
    setDsVerifyBusy(true);
    try {
      const result = await dsaccountVerify();
      setDsVerify(result);
      if (result.cleared) setDsBalance(null);
      await refreshDs();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDsVerifyBusy(false);
    }
  };

  const dsSignOut = async (): Promise<void> => {
    setDsBusy(true);
    try {
      await dsaccountSignOut();
      setDsBalance(null);
      // 刚断开就不该再挂着上一次"验证失败"的提示。
      setDsVerify(null);
      await refreshDs();
      toast("已断开 DeepSeek 账号", "info", { dedupeKey: "dsaccount-signout" });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDsBusy(false);
    }
  };

  return (
    <div class="oauth-page settings-page">
      <header class="oauth-page-head">
        <h1>接入</h1>
        <p>管理推理来源、账号与模型。</p>
      </header>

      <div class="oauth-page-body">
        <Show
          when={available}
          fallback={<p class="field-hint">浏览器预览下不可用：请在桌面壳里打开本页面。</p>}
        >
          <section class="oauth-section">
            <div class="oauth-mode">
              <span class="oauth-pill__text">
                <span class="oauth-pill__title">当前默认存档</span>
                <span class="oauth-pill__hint">
                  {config() == null
                    ? "正在读取配置…"
                    : activeId() == null
                      ? "自带 API key（在「设置 → 存档」维护）"
                      : (ACCOUNT_PROVIDERS.find((entry) => entry.id === activeId())?.name ??
                        "账号额度")}
                </span>
              </span>
            </div>
          </section>

          <section class="oauth-section">
            <h2 class="oauth-section-title">服务商</h2>
            <div class="oauth-provider-list">
              <For each={ACCOUNT_PROVIDERS}>
                {(entry) => {
                  const slot = () => slotOf(entry);
                  return (
                    <ProviderRow
                      entry={entry}
                      active={activeId() === entry.id}
                      model={
                        activeId() === entry.id
                          ? (config()?.model ?? null)
                          : (accountProfile(entry)?.model ?? null)
                      }
                      options={optionsOf(entry)}
                      catalogBusy={slot().busy}
                      catalogError={slot().error}
                      onEnsureCatalog={(force = false) => {
                        const kind = catalogKindOf(entry.kind);
                        if (kind != null) void ensureCatalog(kind, force);
                      }}
                      onPickModel={(slug) => void pickModel(entry, slug)}
                      status={status()}
                      busy={busy()}
                      onSwitch={() => void configureAccount(entry, true)}
                      onSignIn={() => void signIn()}
                      onCancel={() => void cancel()}
                      onSignOut={() => void signOut()}
                      onOpenUsage={(url) => void openExternal(url)}
                      dsStatus={dsStatus()}
                      dsBalance={dsBalance()}
                      dsBusy={dsBusy()}
                      onDsSignIn={() => void dsSignIn()}
                      onDsCancel={() => void dsCancel()}
                      onDsSignOut={() => void dsSignOut()}
                      dsVerify={dsVerify()}
                      dsVerifyBusy={dsVerifyBusy()}
                      onDsVerify={() => void dsVerifyNow()}
                      onDsOpenLink={(url) => void openExternal(url)}
                    />
                  );
                }}
              </For>
            </div>
          </section>

          <section class="oauth-section oauth-byok">
            <div>
              <h2 class="oauth-section-title">API key 与端点</h2>
              <p>自带 API key 的服务商与存档统一在「设置 → 存档」维护；启用其中一条存档即可切回。</p>
            </div>
            <Show when={props.onOpenSettings}>
              <button type="button" class="ghost-mini" onClick={() => props.onOpenSettings?.()}>管理存档</button>
            </Show>
          </section>
          <p class="oauth-page-note">凭据加密保存在本机，登录将在系统浏览器中完成。</p>
          <Show when={error()}>
            {(message) => <p role="alert" class="field-hint is-error oauth-page-error">{message()}</p>}
          </Show>
        </Show>

        <SiwcFirstRunNotice
          open={firstRun()}
          onDismiss={() => {
            markFirstRunSeen();
            setFirstRun(false);
          }}
        />
      </div>
    </div>
  );
};
