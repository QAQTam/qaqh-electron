/**
 * 「接入」页 —— GlobalNav 的独立页。
 *
 * ## 这一页在做什么
 *
 * **前端代管多 provider**：名册在 `./providers`，每家的状态（模型/端点/协议）在
 * `./provider-state`，模型特判（档位/窗口/展示名）在 `../models/specs`。后端只承担
 * 一件小事：把**当前生效那家**的字段收进配置（合并补丁）。凭据始终留在 daemon。
 *
 * 为什么这么切：后端短期内没有 per-provider 的结构可挂，而单一的全局 `model`
 * 装不下两份状态——**切走之前先快照**（`captureProviderState`）才谈得上切回来。
 *
 * ## 三条硬约束
 *
 * 1. 本页只写「provider 相关的字段」（credential/wire/baseUrl/model/contextLength），
 *    绝不整包写回：设置页可能正有未保存草稿，整包会把它一起提交。
 * 2. 授权 URL 交给**系统浏览器**打开；daemon 不 spawn 进程、也不内嵌 webview。
 * 3. 胶囊开关说的是「**有没有在用账号额度**」（套餐或 DeepSeek 账号），不是
 *    "是不是套餐"——设置页那批 BYOK 字段的置灰判据也是这个（`isAccountCredential`），
 *    两边必须同一个判据，否则切到 DeepSeek 时开关会自己弹回"关"。模型目录按
 *    provider 归口（`./model-catalog`），本页与输入区共用同一份判定。
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
import { isTauriRuntime } from "../lib/transport/backend";
import { notifyConfigChanged } from "../lib/config-events";
import { modelSpec, type SpecBucket } from "../models/specs";
import { siwcApiBase, siwcPlanBadgeVisible, type SiwcSessionStatus } from "../siwc/brand";
import { SiwcConnectionCard } from "../siwc/components/ConnectionCard";
import { SiwcFirstRunNotice } from "../siwc/components/FirstRunNotice";
import { SiwcSignInButton } from "../siwc/components/SignInButton";
import { siwcAccountView } from "../siwc/state";
import { toast } from "../ui/toast";
import { oauthPillView } from "./mode";
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
  activeProviderId,
  captureProviderState,
  loadLastAccountProvider,
  loadState,
  rememberState,
  saveLastAccountProvider,
  saveState,
  switchFields,
  type ProviderStateMap,
} from "./provider-state";
import {
  ACCOUNT_PROVIDERS,
  BYOK_PROVIDER_ID,
  DSACCOUNT_PROVIDER_ID,
  PLAN_PROVIDER_ID,
  accountTargetId,
  providerById,
  type ProviderEntry,
} from "./providers";

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
  entry: ProviderEntry;
  active: boolean;
  /** 当前生效的模型名（用于展示；来自 daemon 配置，不是本卡的本地状态）。 */
  model: string | null;
  /** 这一家的模型目录条目；`null` = 还没拿到。 */
  options: ModelEntry[] | null;
  catalogBusy: boolean;
  catalogError: string | null;
  /** 展开 / 点「刷新目录」：按这一家的来源拉一次目录。 */
  onEnsureCatalog: (force?: boolean) => void;
  /** 选一条模型：生效中 → 落盘；未生效 → 只记进该 provider 的槽位。 */
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
          <Match when={props.entry.kind === "byok"}>
            <p class="oauth-provider__status">
              自带 key 的模型与端点由你在设置页维护；切换回来时，我们把你**切走之前**
              那套（模型 / 端点 / 协议）写回配置。
            </p>
          </Match>
        </Switch>

        <Show when={props.entry.kind !== "byok"}>
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
        </Show>

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
  const available = isTauriRuntime();
  /** 已保存事实（`config.load` 的整份读模型）：切换要快照它，所以留整份。 */
  const [config, setConfig] = createSignal<ConfigDto | null>(null);
  /** 每 provider 记住的状态（前端代管）。 */
  const [states, setStates] = createSignal<ProviderStateMap>(loadState());
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

  const slotOf = (entry: ProviderEntry): CatalogSlot => {
    const kind = catalogKindOf(entry.kind);
    return kind == null ? EMPTY_SLOT : (catalogs()[kind] ?? EMPTY_SLOT);
  };

  /** 一张卡该列出的模型条目（`null` = 目录还没到位）。 */
  const optionsOf = (entry: ProviderEntry): ModelEntry[] | null => {
    const entries = slotOf(entry).entries;
    if (entries == null) return null;
    const current = config();
    // 当前生效的模型与槽位里记住的那条都可能不在目录里（切过账户、上游改名），
    // 也要列出来 —— 否则列表里没有选中项，用户以为目录是坏的。
    const extras = [
      current != null && activeProviderId(current) === entry.id ? current.model : null,
      states()[entry.id]?.model,
    ];
    return modelOptions(entry.kind, entries, extras);
  };

  /**
   * 胶囊开关：判据与文案都在 `./mode::oauthPillView`（那里有测试）。
   * 本页只渲染它 —— 不在组件里另写一份"是不是套餐"的判断，那正是这次翻车的形状。
   */
  const pill = () => oauthPillView(config(), activeName());
  const activeId = (): string | null => {
    const current = config();
    return current == null ? null : activeProviderId(current);
  };
  /** 当前生效那一家（配置还没读到时 `null`）：胶囊那一行要说得出是哪家。 */
  const activeName = (): string | null => {
    const id = activeId();
    return id == null ? null : (providerById(id)?.name ?? null);
  };

  const loadConfig = async (): Promise<void> => {
    if (!available) return;
    try {
      const next = await transport.rpc<ConfigDto>("config.load");
      setConfig(next);
      setError(null);
      // 生效那一家的模型目录：不拉的话，接入页与输入区都只能显示"空列表"。
      const kind = catalogKindOf(providerById(activeProviderId(next))?.kind ?? "byok");
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
    void refreshStatus();
    void refreshDs();
    const timer = window.setInterval(() => {
      if (flowId() == null) void refreshStatus();
      // 登录进行中由流程驱动自己轮询，页面这边不掺和（免得两个轮询抢状态）。
      if (dsAttempt() == null) void refreshDs();
    }, 10_000);
    return () => window.clearInterval(timer);
  });

  /**
   * 切到某一家。四步走：
   * 1. **先把当前这套抓下来**存进它自己的槽位（不做这步，切回来就还原不了）；
   * 2. 目标那家的槽位**没有**模型名时，先从它的目录里取一条补上 —— 合并补丁没法
   *    "清空 `model`"，不补就是把上一家的 slug 留在这一家的配置里（选择器随之
   *    显示"没有匹配项"，看起来就像"这家没有模型可用"）；
   * 3. 用目标那家的状态算出要写的字段（合并补丁，只发这几个键）；
   * 4. 落盘后把模型名记回槽位、重新读配置（草稿不是事实），并记下"上次在用的是
   *    哪一家账号额度"，供胶囊开关拨回来时落回同一家。
   *
   * `fromSignIn` 给登录流程用：登录本身已经占着 busy，那一路是**同一次用户意图**
   * 的延续，不该被自己的并发保护挡下来（挡下来就变成"登录成功但没启用"）。
   */
  const switchTo = async (
    target: ProviderEntry,
    options: { fromSignIn?: boolean } = {},
  ): Promise<void> => {
    const current = config();
    if (current == null) return;
    if (busy() && options.fromSignIn !== true) return;
    setBusy(true);
    setError(null);
    try {
      let next = rememberState(states(), activeProviderId(current), captureProviderState(current));
      // 官方端点只从后端取：ChatGPT 那条来自 `siwc.status.apiBase`，DeepSeek 账号
      // 这条来自 `dsaccount.status.inferenceOrigin`。前端**不拼** URL。
      const apiBase =
        target.kind === "account"
          ? (dsStatus()?.inferenceOrigin ?? null)
          : siwcApiBase(status());
      const kind = catalogKindOf(target.kind);
      if (kind != null && (next[target.id]?.model ?? "").trim() === "") {
        try {
          const entries = await fetchModelCatalog(kind);
          patchSlot(kind, { entries, error: null, busy: false });
          const model = preferredModel({
            remembered: next[target.id]?.model,
            current: current.model,
            catalog: entries,
          });
          if (model != null) next = rememberState(next, target.id, { model });
        } catch (cause) {
          // 目录拉不到**不阻断切换**：端点与凭据才是这一家的主体，模型名可以后补。
          patchSlot(kind, { error: messageOf(cause), busy: false });
        }
      }
      const fields = switchFields(target, next, apiBase);
      await transport.rpc("config.save", fields);
      const model = fields.model;
      if (typeof model === "string" && model !== "") {
        next = rememberState(next, target.id, { model });
      }
      setStates(next);
      saveState(next);
      if (target.kind !== "byok") saveLastAccountProvider(target.id);
      await loadConfig();
      // 切 provider 会**连分母一起换**（`switchFields` 写 `contextLength`：套餐 565K /
      // DeepSeek 账号 1MiB）。不广播的话输入区的百分比还按上一家的窗口算，
      // 一半就显示满、自动压缩提前触发。
      notifyConfigChanged();
      toast(
        target.kind === "plan"
          ? "已切换到 ChatGPT 套餐"
          : target.kind === "account"
            ? "已切换到 DeepSeek 账号"
            : "已切回自带 API key",
        "ok",
        { dedupeKey: "provider-switch" },
      );
      if (kind != null && typeof model !== "string") {
        toast("已切换服务商，但这一家的模型目录没拿到：请在接入页或输入区确认模型名", "info", {
          dedupeKey: "provider-switch-model",
        });
      }
    } catch (cause) {
      setError(messageOf(cause));
      toast(`切换失败：${messageOf(cause)}`, "err", { dedupeKey: "provider-switch-error" });
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
        await activateIfIdle(PLAN_PROVIDER_ID);
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
   * 拨开关。关掉 = 切回 BYOK（那条路径会还原切换前抓下来的那套配置）；
   * 拨回开 = 落回**上次在用的那家账号额度**，而不是一律回套餐。
   */
  const toggleOauth = (next: boolean): void => {
    const targetId = next ? accountTargetId(loadLastAccountProvider()) : BYOK_PROVIDER_ID;
    const target = providerById(targetId);
    if (target != null) void switchTo(target);
  };

  /**
   * 在接入页选一条模型。生效那一家 → `config.save {model}`；还没生效的那家 →
   * 只记进它的槽位（切过去时由 `switchFields` 一起写），**不**碰当前配置。
   */
  const pickModel = async (target: ProviderEntry, slug: string): Promise<void> => {
    const current = config();
    if (current == null || busy()) return;
    const remembered = rememberState(states(), target.id, { model: slug });
    setStates(remembered);
    saveState(remembered);
    if (activeProviderId(current) !== target.id) {
      toast(`已记下：切到${target.name}时用 ${slug}`, "info", { dedupeKey: "model-slot" });
      return;
    }
    setBusy(true);
    try {
      await transport.rpc("config.save", { model: slug });
      await loadConfig();
      notifyConfigChanged();
      toast(`已切换模型：${slug}`, "ok", { dedupeKey: "model-switch" });
    } catch (cause) {
      setError(messageOf(cause));
      toast(`模型切换失败：${messageOf(cause)}`, "err", { dedupeKey: "model-switch-error" });
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
  const activateIfIdle = async (providerId: string): Promise<void> => {
    const current = config();
    if (current == null || activeProviderId(current) !== BYOK_PROVIDER_ID) return;
    const target = providerById(providerId);
    if (target != null) await switchTo(target, { fromSignIn: true });
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
        await activateIfIdle(DSACCOUNT_PROVIDER_ID);
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
            <div class={`oauth-mode${pill().on ? " is-on" : ""}`}>
              <label class="oauth-pill">
                <input
                  type="checkbox"
                  checked={pill().on}
                  disabled={busy() || config() == null}
                  onChange={(event) => toggleOauth(event.currentTarget.checked)}
                />
                <span class="oauth-pill__track" aria-hidden="true">
                  <span class="oauth-pill__thumb" />
                </span>
                <span class="oauth-pill__text">
                  <span class="oauth-pill__title">使用账号额度</span>
                  <span class="oauth-pill__hint">{config() == null ? "正在读取配置…" : pill().on ? `当前来源：${activeName() ?? "账号额度"}` : "关闭时使用已保存的 API key 配置"}</span>
                </span>
              </label>
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
                      model={config()?.model ?? null}
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
                      onSwitch={() => void switchTo(entry)}
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
              <p>{config() == null ? "正在读取配置…" : pill().on ? "账号额度已启用，切回 API key 时会恢复原配置。" : "当前使用设置页中保存的配置。"}</p>
            </div>
            <Show when={props.onOpenSettings}>
              <button type="button" class="ghost-mini" onClick={() => props.onOpenSettings?.()}>前往设置</button>
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
