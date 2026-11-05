// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));
vi.mock("../src/lib/transport/backend", () => ({ isDesktopRuntime: () => true }));
vi.mock("../src/lib/transport", () => ({ transport: { query: vi.fn() } }));
vi.mock("../src/lib/siwc", () => ({
  siwcStatus: vi.fn(), siwcModels: vi.fn(), openExternal: vi.fn(), runSignInFlow: vi.fn(),
  siwcSignInCancel: vi.fn(), siwcSignInStart: vi.fn(), siwcSignInStatus: vi.fn(), siwcSignOut: vi.fn(),
}));
vi.mock("../src/lib/dsaccount", () => ({
  dsaccountStatus: vi.fn(), dsaccountModels: vi.fn(), dsaccountBalance: vi.fn(), dsaccountVerify: vi.fn(),
  dsaccountSignInCancel: vi.fn(), dsaccountSignOut: vi.fn(), runDeepSeekSignIn: vi.fn(), defaultDsSignInDeps: {},
}));
vi.mock("../src/settings/registry", () => ({
  registry: () => ({ providers: [], profiles: [], defaultSelection: null }), registryError: () => null,
  registryBusy: () => false, refreshRegistry: vi.fn(), syncAccountCatalog: vi.fn(), ensureAccountProfile: vi.fn(),
}));
vi.mock("../src/siwc/components/SignInButton", () => ({ SiwcSignInButton: () => null }));
vi.mock("../src/siwc/components/FirstRunNotice", () => ({ SiwcFirstRunNotice: () => null }));
vi.mock("../src/siwc/components/ConnectionCard", () => ({ SiwcConnectionCard: () => null }));
vi.mock("../src/dsaccount/components/AccountCard", () => ({ DsAccountCard: () => null }));
vi.mock("../src/ui/toast", () => ({ toast: vi.fn() }));

import { createComponent, flush } from "solid-js";
import { render } from "@solidjs/web";
import { dsaccountBalance, dsaccountModels, dsaccountStatus } from "../src/lib/dsaccount";
import { siwcStatus } from "../src/lib/siwc";
import { transport } from "../src/lib/transport";
import { ensureAccountProfile, syncAccountCatalog } from "../src/settings/registry";
import { OAuthPage } from "../src/oauth/OAuthPage";
import type { DsAccountStatus } from "../src/dsaccount/state";

const models = [{ slug: "deepseek-flash", displayName: "DeepSeek Flash", contextWindow: 1_048_576, maxOutputTokens: 393_216 }];
const account = (userId = "user-a"): DsAccountStatus => ({
  signedIn: true, account: { user_id: userId, saved_at_ms: 1, label: userId, inference_origin: "https://api.deepseek.com",
    provider: null, currency: null, has_credential: true },
  storageError: null, inferenceOrigin: "https://api.deepseek.com", usageUrl: "", topUpUrl: "",
  flow: { attemptId: null, state: "idle", authorizeUrl: null, expiresAtMs: 0, error: null },
});

const settle = async () => { for (let index = 0; index < 6; index += 1) { await flush(); await Promise.resolve(); } };
let dispose: (() => void) | undefined;
function mount() {
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => createComponent(OAuthPage, {}), root);
  return root;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T09:00:00Z"));
  vi.mocked(dsaccountStatus).mockResolvedValue(account());
  vi.mocked(dsaccountModels).mockResolvedValue(models);
  vi.mocked(dsaccountBalance).mockResolvedValue({ recharge: [], bonus: [], totalCost: [], hasUsableBalance: true });
  vi.mocked(siwcStatus).mockResolvedValue({ status: "disconnected", sharing: false });
  vi.mocked(transport.query).mockResolvedValue({ credential: "deepseek_account", model: "old-model" });
  vi.mocked(syncAccountCatalog).mockResolvedValue("deepseek-account");
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); document.body.replaceChildren(); });

test("an already signed-in account discovers and imports models automatically, without changing the default", async () => {
  const root = mount(); await settle();
  expect(dsaccountModels).toHaveBeenCalledOnce();
  expect(syncAccountCatalog).toHaveBeenCalledWith(expect.objectContaining({ kind: "account", models }));
  expect(ensureAccountProfile).not.toHaveBeenCalled();
  const section = root.querySelector("[data-provider=account]")!;
  section.querySelector<HTMLButtonElement>(".oauth-provider__toggle")!.click(); await settle();
  expect(dsaccountModels).toHaveBeenCalledOnce();
  expect(section.querySelector(".oauth-models__list")!.textContent).toContain("DeepSeek Flash");
  await vi.advanceTimersByTimeAsync(600_000); await settle();
  expect(dsaccountModels).toHaveBeenCalledTimes(2);
  expect(ensureAccountProfile).not.toHaveBeenCalled();
});

test("discovery waits for login and refresh failures retain the previous listing", async () => {
  vi.mocked(dsaccountStatus).mockResolvedValue({ ...account(), signedIn: false, account: null });
  const root = mount(); await settle();
  expect(dsaccountModels).not.toHaveBeenCalled();
  vi.mocked(dsaccountStatus).mockResolvedValue(account());
  await vi.advanceTimersByTimeAsync(10_000); await settle();
  expect(dsaccountModels).toHaveBeenCalledOnce();
  const section = root.querySelector("[data-provider=account]")!;
  vi.mocked(dsaccountModels).mockRejectedValueOnce(new Error("offline"));
  section.querySelector<HTMLButtonElement>(".oauth-models__head button")!.click(); await settle();
  expect(section.querySelector(".oauth-models__list")!.textContent).toContain("DeepSeek Flash");
  expect(section.querySelector("[role=alert]")!.textContent).toContain("offline");
});

test("a late listing from the previous account is ignored", async () => {
  let resolveOld!: (value: typeof models) => void;
  vi.mocked(dsaccountModels).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const root = mount(); await settle();
  vi.mocked(dsaccountStatus).mockResolvedValue(account("user-b"));
  vi.mocked(dsaccountModels).mockResolvedValue([{ ...models[0]!, slug: "account-b-model", displayName: "Account B" }]);
  await vi.advanceTimersByTimeAsync(10_000); await settle();
  resolveOld([{ ...models[0]!, slug: "old-account-model", displayName: "Old Account" }]); await settle();
  expect(root.querySelector("[data-provider=account] .oauth-models__list")!.textContent).toContain("Account B");
  expect(root.querySelector("[data-provider=account] .oauth-models__list")!.textContent).not.toContain("Old Account");
  expect(syncAccountCatalog).toHaveBeenCalledOnce();
});

test("leaving the page stops refreshes and discards an unfinished discovery", async () => {
  let resolveListing!: (value: typeof models) => void;
  vi.mocked(dsaccountModels).mockImplementationOnce(() => new Promise((resolve) => { resolveListing = resolve; }));
  mount(); await settle();
  dispose!(); dispose = undefined;
  resolveListing(models); await settle();
  await vi.advanceTimersByTimeAsync(600_000); await settle();
  expect(syncAccountCatalog).not.toHaveBeenCalled();
  expect(dsaccountModels).toHaveBeenCalledOnce();
});
