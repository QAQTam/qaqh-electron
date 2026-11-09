/**
 * 「接入」页 —— 账号额度（ChatGPT 套餐 / DeepSeek 账号）的登录与启用。
 *
 * 登录只建立账号授权。用户填写模型 ID 后，才通过 `ensureAccountProfile` 登记
 * 模型并显式启用。页面不维护内置模型名单，
 * 也不再改写 `ConfigDto` 的顶层模型字段 —— 那些只是读投影。
 *
 * 授权 URL 交给**系统浏览器**打开；daemon 不 spawn 进程、也不内嵌 webview。
 * 自带 API key 的配置统一在「设置 → 服务商」维护，这里只展示入口。
 */
import { loadConfigSnapshot } from "../lib/config-snapshot";

import { createEffect, createSignal, For, Match, onSettled, Show, Switch, untrack, type Component } from "solid-js";
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
import { isDesktopRuntime } from "../lib/transport/backend";
import { siwcApiBase, siwcPlanBadgeVisible, type SiwcSessionStatus } from "../siwc/brand";
import { SiwcConnectionCard } from "../siwc/components/ConnectionCard";
import { SiwcFirstRunNotice } from "../siwc/components/FirstRunNotice";
import { SiwcSignInButton } from "../siwc/components/SignInButton";
import { siwcAccountView } from "../siwc/state";
import { toast } from "../ui/toast";
import { ModelList } from "./ModelList";
import {
  providerKindOfCredential,
} from "./mode";
import {
  catalogKindOf,
  fetchModelCatalog,
  type CatalogKind,
  type ModelEntry,
} from "./model-catalog";
import {
  ensureAccountProfile,
  refreshRegistry,
  registryError,
  registryBusy,
  syncAccountCatalog,
} from "../settings/registry";

/** 接入页只管理两类账号额度；BYOK 在「设置 → 服务商」。 */
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
type CatalogSlot = { entries: ModelEntry[] | null; error: string | null; busy: boolean; fetchedAt: number };

const EMPTY_SLOT: CatalogSlot = { entries: null, error: null, busy: false, fetchedAt: 0 };
const CATALOG_MAX_AGE_MS = 10 * 60_000;

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
  catalogBusy: boolean;
  catalogModels: ModelEntry[] | null;
  catalogError: string | null;
  /** 展开 / 点「刷新目录」：按这一家的来源拉一次目录。 */
  onEnsureCatalog: (force?: boolean) => void;
  /** 选一条模型：写进该账号的规范存档。 */
  onPickModel: (slug: string) => void;
  status: SiwcSessionStatus | null;
  busy: boolean;
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

  /** 原样展示用户选择的模型 ID。 */
  const modelLabel = (): string | null => {
    if (props.model == null || props.model === "") return null;
    return props.model;
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
            <Show when={props.active}><span class="oauth-provider__active">全局默认来源</span></Show>
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
          model={props.model}
          models={props.catalogModels}
          signedIn={props.entry.kind === "account" ? props.dsStatus?.signedIn === true
            : props.status?.status === "connected" && siwcPlanBadgeVisible(props.status)}
          busy={props.catalogBusy || props.busy || props.dsBusy || registryBusy()}
          refreshing={props.catalogBusy}
          error={props.catalogError}
          onReload={() => props.onEnsureCatalog(true)}
          onPick={(slug) => props.onPickModel(slug)}
        />

      </div>
    </article>
  );
};

export const OAuthPage: Component<{ onOpenSettings?: () => void }> = (props) => {
  const available = isDesktopRuntime();
  let disposed = false;
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
  const catalogState: Partial<Record<CatalogKind, CatalogSlot>> = {};

  const patchSlot = (kind: CatalogKind, next: Partial<CatalogSlot>): void => {
    // Keep request bookkeeping synchronous while Solid publishes the UI projection.
    catalogState[kind] = { ...EMPTY_SLOT, ...catalogState[kind], ...next };
    setCatalogs({ ...catalogState });
  };

  const catalogIdentity = (kind: CatalogKind): string | null => {
    if (kind === "plan") {
      const current = status();
      return current?.status === "connected" && current.sharing
        ? `${current.profileId ?? ""}:${siwcApiBase(current) ?? ""}` : null;
    }
    const current = dsStatus();
    return current?.signedIn === true
      ? `${current.account?.user_id ?? ""}:${current.account?.saved_at_ms ?? ""}:${current.inferenceOrigin}` : null;
  };
  const requests: Partial<Record<CatalogKind, symbol>> = {};
  const clearCatalog = (kind: CatalogKind): void => {
    requests[kind] = Symbol();
    patchSlot(kind, EMPTY_SLOT);
  };

  /** Refresh on login/expiry; keep the previous listing on transient failures. */
  const ensureCatalog = async (kind: CatalogKind, force = false): Promise<void> => {
    const identity = catalogIdentity(kind);
    if (!available || disposed || identity == null) return;
    const slot = catalogState[kind];
    if (slot?.busy === true) return;
    if (!force && slot != null && Date.now() - slot.fetchedAt < CATALOG_MAX_AGE_MS) return;
    const request = Symbol();
    requests[kind] = request;
    const isCurrent = () => !disposed && requests[kind] === request && catalogIdentity(kind) === identity;
    patchSlot(kind, { busy: true });
    try {
      const entries = await fetchModelCatalog(kind);
      if (!isCurrent()) return;
      patchSlot(kind, { entries, error: null, fetchedAt: Date.now() });
      const entry = ACCOUNT_PROVIDERS.find((provider) => provider.kind === kind)!;
      const baseUrl = accountBaseUrl(entry);
      if (baseUrl != null && entries.length > 0) {
        const synced = await syncAccountCatalog({ kind, baseUrl, models: entries, isCurrent });
        if (synced == null && isCurrent()) throw new Error(registryError() ?? "模型目录同步失败");
      }
      if (isCurrent()) patchSlot(kind, { busy: false });
    } catch (cause) {
      if (isCurrent()) patchSlot(kind, { error: messageOf(cause), busy: false, fetchedAt: Date.now() });
    }
  };

  // Run after the account state commits: Solid 2 setters do not publish immediately.
  createEffect(
    () => [catalogIdentity("plan"), catalogIdentity("account")] as const,
    (identities, previous) => untrack(() => {
      for (const [index, kind] of (["plan", "account"] as const).entries()) {
        if (identities[index] !== previous?.[index]) clearCatalog(kind);
        if (identities[index] != null) void ensureCatalog(kind);
      }
    }),
  );

  const slotOf = (entry: AccountEntry): CatalogSlot => {
    const kind = catalogKindOf(entry.kind);
    return kind == null ? EMPTY_SLOT : (catalogs()[kind] ?? EMPTY_SLOT);
  };

  const loadConfig = async (): Promise<void> => {
    if (!available) return;
    try {
      const next = await loadConfigSnapshot();
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
      void ensureCatalog("plan");
      void ensureCatalog("account");
    }, 10_000);
    return () => { disposed = true; window.clearInterval(timer); };
  });

  /** 官方端点只从后端取：套餐来自 `siwc.status.apiBase`，DeepSeek 来自账号态。 */
  const accountBaseUrl = (entry: AccountEntry): string | null =>
    entry.kind === "plan" ? siwcApiBase(status()) : (dsStatus()?.inferenceOrigin ?? null);

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
   * 将账号目录中的模型登记到服务商，供会话选择。
   */
  const pickModel = async (target: AccountEntry, slug: string): Promise<void> => {
    if (config() == null || busy() || registryBusy() || catalogIdentity(target.kind) == null) return;
    setBusy(true);
    setError(null);
    try {
      const baseUrl = accountBaseUrl(target);
      if (baseUrl == null) {
        setError(`还没有读到 ${target.name} 的官方端点：请先完成登录`);
        return;
      }
      await ensureCatalog(target.kind);
      const result = await ensureAccountProfile({
        kind: target.kind,
        baseUrl,
        model: slug,
        modelMetadata: catalogs()[target.kind]?.entries?.find((item) => item.slug === slug),
      });
      if (result == null) {
        setError(registryError() ?? "模型写入失败");
        return;
      }
      await loadConfig();
      await refreshRegistry();
      toast(`已添加模型：${slug}，可在会话中选择`, "ok", { dedupeKey: "model-switch" });
    } finally {
      setBusy(false);
    }
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
            <h2 class="oauth-section-title">服务商</h2>
            <div class="oauth-provider-list">
              <For each={ACCOUNT_PROVIDERS}>
                {(entry) => {
                  const slot = () => slotOf(entry);
                  return (
                    <ProviderRow
                      entry={entry}
                      active={false}
                      model={null}
                      catalogBusy={slot().busy}
                      catalogModels={slot().entries}
                      catalogError={slot().error}
                      onEnsureCatalog={(force = false) => {
                        const kind = catalogKindOf(entry.kind);
                        if (kind != null) void ensureCatalog(kind, force);
                      }}
                      onPickModel={(slug) => void pickModel(entry, slug)}
                      status={status()}
                      busy={busy()}
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
              <p>API key、端点与模型目录在「设置 → 服务商」维护；账号模型可在这里刷新目录并设为默认。</p>
            </div>
            <Show when={props.onOpenSettings}>
              <button type="button" class="ghost-mini" onClick={() => props.onOpenSettings?.()}>管理服务商和模型</button>
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
