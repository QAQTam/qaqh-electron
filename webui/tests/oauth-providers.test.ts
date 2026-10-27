import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  EFFORT_LADDER,
  MODEL_SPECS,
  modelContextWindow,
  modelDefaultEffort,
  modelEfforts,
  modelSpec,
} from "../src/models/specs";
import {
  DSACCOUNT_CONTEXT_LENGTH,
  isAccountCredential,
  isDeepseekAccountMode,
  isOauthMode,
  isPlanMode,
  oauthPillView,
  OAUTH_CONTEXT_LENGTH,
} from "../src/oauth/mode";
import {
  activeProviderId,
  captureProviderState,
  LAST_ACCOUNT_KEY,
  loadLastAccountProvider,
  loadState,
  PROVIDER_STATE_KEY,
  rememberState,
  saveLastAccountProvider,
  saveState,
  switchFields,
  type StorageLike,
} from "../src/oauth/provider-state";
import {
  ACCOUNT_PROVIDERS,
  BYOK_PROVIDER_ID,
  DSACCOUNT_PROVIDER_ID,
  PLAN_PROVIDER_ID,
  PROVIDERS,
  accountTargetId,
  providerById,
  providerRegistryProblems,
} from "../src/oauth/providers";

/** 键值版内存存储（胶囊那条记录与 provider 状态表**各占各的键**，测试要能分辨）。 */
function memStorage(initial?: string): StorageLike {
  const store = new Map<string, string>();
  if (initial != null) store.set(PROVIDER_STATE_KEY, initial);
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, next) => {
      store.set(key, next);
    },
  };
}

/** 一个「BYOK 已经配好」的读模型快照。 */
const BYOK_CONFIG = {
  model: "deepseek-v4.1-flash",
  reasoningEffort: "high",
  baseUrl: "https://api.deepseek.com",
  wire: "chat",
  contextLength: 128_000,
};

describe("套餐模式判定", () => {
  it("只有 credential=chatgpt_plan 才算开启", () => {
    expect(isOauthMode({ credential: "chatgpt_plan" })).toBe(true);
    expect(isOauthMode({ credential: "api_key" })).toBe(false);
    // 读模型未加载 / 未知取值都按「没开」处理——置灰是破坏性呈现。
    expect(isOauthMode(null)).toBe(false);
    expect(isOauthMode(undefined)).toBe(false);
    expect(isOauthMode({ credential: "" })).toBe(false);
  });
});

/**
 * 胶囊开关的判据（回归：切到 DeepSeek 账号时开关自己弹回"关"）。
 *
 * 那一页的开关说的是「有没有在用账号额度」，不是「是不是套餐」：设置页那批 BYOK
 * 字段的置灰判据就是 `isAccountCredential`，两边不同判据时界面会自己否认正在发生
 * 的事 —— 用户看到的就是"我一登录 DeepSeek，OAuth 就被关了"。
 */
describe("胶囊开关判据 = 账号额度", () => {
  it("DeepSeek 账号：不是套餐，但**是**账号额度（开关该开着）", () => {
    expect(isPlanMode({ credential: "deepseek_account" })).toBe(false);
    expect(isDeepseekAccountMode({ credential: "deepseek_account" })).toBe(true);
    expect(isAccountCredential({ credential: "deepseek_account" })).toBe(true);
  });

  it("两家都算开着；只有 api_key（与没读到）算关着", () => {
    expect(isAccountCredential({ credential: "chatgpt_plan" })).toBe(true);
    expect(isAccountCredential({ credential: "api_key" })).toBe(false);
    expect(isAccountCredential(null)).toBe(false);
    expect(isAccountCredential({ credential: "" })).toBe(false);
  });

  it("旧名字 `isOauthMode` 仍然是「是不是套餐」的别名（语义没被偷偷扩大）", () => {
    expect(isOauthMode).toBe(isPlanMode);
  });

  /** 接入页那一行的实际产出（文案与判据一起钉：只测 `on` 的话，文案会慢慢说谎）。 */
  it("胶囊文案：开着 DeepSeek 时说得出是 DeepSeek，不是套餐", () => {
    expect(oauthPillView({ credential: "deepseek_account" }, "DeepSeek 账号")).toEqual({
      on: true,
      hint: "已开启（DeepSeek 账号）：模型与端点(BYOK) 由本模式接管（那几个字段在设置页置灰）",
    });
    expect(oauthPillView({ credential: "chatgpt_plan" }, "OpenAI").on).toBe(true);
    // 生效那一家还没名字（名录改过 / 配置刚读出来）时不编一个名字出来。
    expect(oauthPillView({ credential: "chatgpt_plan" }, null).hint).toContain("（账号额度）");
    const off = oauthPillView({ credential: "api_key" }, "自带 API key（BYOK）");
    expect(off.on).toBe(false);
    expect(off.hint).toBe("关闭时回到设置页里那套自带 key 的配置");
    // 配置还没读到：按"没开"处理（与 `isAccountCredential` 同一口径）。
    expect(oauthPillView(null, null).on).toBe(false);
  });
});

/** 胶囊拨回"开"的落点（回归：硬编码套餐把「关一下再打开」变成静默换服务商）。 */
describe("拨回「开」落到哪一家", () => {
  it("上次在用 DeepSeek 就回 DeepSeek", () => {
    expect(accountTargetId(DSACCOUNT_PROVIDER_ID)).toBe(DSACCOUNT_PROVIDER_ID);
    expect(accountTargetId(PLAN_PROVIDER_ID)).toBe(PLAN_PROVIDER_ID);
  });

  it("没记录 / 记录指向 BYOK / 记录已不在名录里 → 落到名录里第一家账号 provider", () => {
    const first = ACCOUNT_PROVIDERS[0]?.id;
    expect(first).toBe(PLAN_PROVIDER_ID);
    for (const last of [null, undefined, BYOK_PROVIDER_ID, "openai-已经下线"]) {
      expect(accountTargetId(last)).toBe(first);
    }
  });

  it("落点永不是 BYOK：拨「开」不该把人放回自带 key", () => {
    for (const last of [PLAN_PROVIDER_ID, DSACCOUNT_PROVIDER_ID, BYOK_PROVIDER_ID, null]) {
      expect(providerById(accountTargetId(last))?.kind).not.toBe("byok");
    }
  });
});

describe("服务商名录", () => {
  it("自检无问题，且恰好一家 byok（关掉套餐才有地方可退）", () => {
    expect(PROVIDERS.length).toBeGreaterThan(1);
    expect(providerRegistryProblems()).toEqual([]);
    expect(PROVIDERS.filter((p) => p.kind === "byok")).toHaveLength(1);
  });

  it("自检能抓出重复 id / 空字段 / byok 家数不对", () => {
    const dup = [
      { id: "a", name: "A", blurb: "x", kind: "byok" as const },
      { id: "a", name: "B", blurb: "y", kind: "byok" as const },
    ];
    const problems = providerRegistryProblems(dup);
    expect(problems.some((p) => p.includes("id 重复"))).toBe(true);
    expect(problems.some((p) => p.includes("byok provider 应恰好一家"))).toBe(true);
    expect(providerById("nope")).toBeNull();
    expect(providerById(PLAN_PROVIDER_ID)?.kind).toBe("plan");
  });
});

describe("模型特判合集", () => {
  it("实测到的套餐 slug 都有条目（565K + 展示名）", () => {
    for (const slug of [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]) {
      const { spec, known } = modelSpec("plan", slug);
      expect(known, slug).toBe(true);
      expect(spec.displayName, slug).toBeTruthy();
      expect(modelContextWindow(spec), slug).toBe(565_000);
    }
  });

  it("未收录的模型不报错但必须标出 known=false，字段走保守缺省", () => {
    const { spec, known } = modelSpec("plan", "brand-new-model");
    expect(known).toBe(false);
    expect(modelContextWindow(spec)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelEfforts(spec)).toEqual(EFFORT_LADDER);
    expect(modelContextWindow(spec)).toBeLessThan(OAUTH_CONTEXT_LENGTH);
  });

  it("efforts 可以收窄档位；默认档不在可选里时落到最弱档", () => {
    expect(modelEfforts({ efforts: ["low", "high"] })).toEqual(["low", "high"]);
    expect(modelDefaultEffort({ efforts: ["low", "high"], defaultEffort: "ultra" })).toBe("low");
    expect(modelDefaultEffort({ defaultEffort: "xhigh" })).toBe("xhigh");
    // byok 桶空是有意的：说不出差异就别写。
    expect(MODEL_SPECS.byok).toEqual({});
  });

  it("档位按桶分开：套餐不含 max，DeepSeek 账号原样收平台的 max", () => {
    // 后端阶梯是六档（含 max）；Codex 那套只有五档（无 max），所以套餐桶显式排除它。
    // ultra 的来历见 `models/specs.ts`：上游 origin/main 有它，本地后端 checkout 没有。
    expect(EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    for (const spec of Object.values(MODEL_SPECS.plan)) {
      expect(modelEfforts(spec)).not.toContain("max");
    }
    // 平台自报 `effort.supported_levels: ["low","high","max"]`——原样收，不用 ultra 顶替。
    for (const spec of Object.values(MODEL_SPECS.account)) {
      expect(modelEfforts(spec)).toEqual(["low", "high", "max"]);
    }
    // 未收录模型仍走全阶梯（BYOK 端点由用户自己声明，后端 allowlist 兜底钳制）。
    expect(modelEfforts({})).toEqual(EFFORT_LADDER);
  });
});

describe("每 provider 状态：切换与还原", () => {
  it("DeepSeek 账号的切换字段：openai wire + 端点自报的 1M 分母", () => {
    const entry = providerById(DSACCOUNT_PROVIDER_ID);
    expect(entry?.kind).toBe("account");
    if (entry == null) return;
    expect(switchFields(entry, {}, "https://api.deepseek.com")).toMatchObject({
      credential: "deepseek_account",
      // 写模型用 daemon 校验认的旧拼写(规范名 `chat` 会被 400 掉)。
      wire: "openai",
      baseUrl: "https://api.deepseek.com",
      contextLength: DSACCOUNT_CONTEXT_LENGTH,
    });
    // 分母是"本地压缩何时发生"，用户自己调过就尊重他的值（每 provider 状态要还原回来）。
    expect(
      switchFields(entry, { [DSACCOUNT_PROVIDER_ID]: { contextLength: 128_000 } }, null),
    ).toMatchObject({ contextLength: 128_000 });
  });

  it("当前生效的是哪家：读配置里的 credential", () => {
    expect(activeProviderId({ credential: "chatgpt_plan" })).toBe(PLAN_PROVIDER_ID);
    expect(activeProviderId({ credential: "api_key" })).toBe(BYOK_PROVIDER_ID);
  });

  it("切到套餐：写 credential/wire/565K，端点用后端下发的官方值", () => {
    const plan = providerById(PLAN_PROVIDER_ID)!;
    const fields = switchFields(plan, {}, "https://api.openai.com/v1");
    expect(fields).toEqual({
      credential: "chatgpt_plan",
      wire: "responses",
      contextLength: OAUTH_CONTEXT_LENGTH,
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("拿不到官方端点时不猜 URL（只写 credential/wire/上下文）", () => {
    const plan = providerById(PLAN_PROVIDER_ID)!;
    expect(switchFields(plan, {}, null)).toEqual({
      credential: "chatgpt_plan",
      wire: "responses",
      contextLength: OAUTH_CONTEXT_LENGTH,
    });
  });

  /// 这条就是「关掉 OAuth 会丢配置」的回归：先抓 BYOK 那套，切到套餐，再切回来。
  it("切回自带 key 时把模型/端点/协议还原回去（不丢配置）", () => {
    const byok = providerById(BYOK_PROVIDER_ID)!;
    const plan = providerById(PLAN_PROVIDER_ID)!;

    // 1) 开套餐之前先抓一份，存进 byok 槽位。
    let states = rememberState({}, byok.id, captureProviderState(BYOK_CONFIG));
    // 2) 切到套餐。
    const toPlan = switchFields(plan, states, "https://api.openai.com/v1");
    expect(toPlan.credential).toBe("chatgpt_plan");
    // 3) 关套餐。快照里的 `chat` 是读模型回显的规范名，出网要换成旧拼写。
    const back = switchFields(byok, states, "https://api.openai.com/v1");
    expect(back).toEqual({
      credential: "api_key",
      model: "deepseek-v4.1-flash",
      baseUrl: "https://api.deepseek.com",
      wire: "openai",
    });
    // 没抓过的槽位不写空值（合并补丁的空串 = 保持现值，写空等于没写还更容易误读）。
    states = rememberState(states, plan.id, {});
    expect(switchFields(byok, states, null)).toEqual(back);
  });

  it("还原 wire 时统一换成 daemon 认的拼写;认不出的值不发(不制造必然 400 的请求)", () => {
    const byok = providerById(BYOK_PROVIDER_ID)!;
    // 规范名(读模型回显)与更早版本存下的旧拼写都归一到 daemon 词表。
    expect(switchFields(byok, { [byok.id]: { wire: "messages" } }, null).wire).toBe("anthropic");
    expect(switchFields(byok, { [byok.id]: { wire: "claude" } }, null).wire).toBe("anthropic");
    expect(switchFields(byok, { [byok.id]: { wire: "openai" } }, null).wire).toBe("openai");
    // 坏数据落在本地存储里时宁可少发一个键,也不发一个 daemon 必拒的串。
    expect("wire" in switchFields(byok, { [byok.id]: { wire: "deepseek" } }, null)).toBe(false);
  });

  it("套餐槽位记住了模型时，切回套餐用它；没记住就不发 model（不覆盖用户选的）", () => {
    const plan = providerById(PLAN_PROVIDER_ID)!;
    const withModel = switchFields(plan, { [plan.id]: { model: "gpt-6-luna" } }, null);
    expect(withModel.model).toBe("gpt-6-luna");
    expect("model" in switchFields(plan, {}, null)).toBe(false);
  });

  it("存储往返：写得进读得出；坏数据/非对象一律退回空表", () => {
    const storage = memStorage();
    saveState({ [PLAN_PROVIDER_ID]: { model: "gpt-6-sol" } }, storage);
    expect(loadState(storage)).toEqual({ [PLAN_PROVIDER_ID]: { model: "gpt-6-sol" } });
    expect(storage.getItem(PROVIDER_STATE_KEY)).toContain("gpt-6-sol");

    expect(loadState(memStorage("{ not json"))).toEqual({});
    expect(loadState(memStorage("[1,2,3]"))).toEqual({});
    expect(loadState(memStorage('{"openai": 42}'))).toEqual({});
    // 没有存储（隐私模式/SSR）也不炸。
    expect(loadState(null)).toEqual({});
    expect(() => saveState({}, null)).not.toThrow();
  });

  /**
   * 胶囊开关"上次在用的是哪一家"单独一个键。
   *
   * 刻意不进 `PROVIDER_STATE_KEY` 那份表：那份的约定是"每家一个嵌套对象"，
   * 塞一个字符串进去要么被 `loadState` 当坏数据丢掉，要么把整份表判成坏数据
   * 清光（后者会把用户的模型/端点快照一起赔进去）。
   */
  it("「上次在用的是哪一家」与状态表各占各的键，互不覆盖", () => {
    const storage = memStorage();
    expect(loadLastAccountProvider(storage)).toBeNull();
    saveLastAccountProvider(DSACCOUNT_PROVIDER_ID, storage);
    saveState({ [PLAN_PROVIDER_ID]: { model: "gpt-6-sol" } }, storage);
    expect(loadLastAccountProvider(storage)).toBe(DSACCOUNT_PROVIDER_ID);
    expect(storage.getItem(LAST_ACCOUNT_KEY)).toBe(DSACCOUNT_PROVIDER_ID);
    // 状态表没被那条记录带坏，反之亦然。
    expect(loadState(storage)).toEqual({ [PLAN_PROVIDER_ID]: { model: "gpt-6-sol" } });

    const blank: StorageLike = { getItem: () => "   ", setItem: () => undefined };
    expect(loadLastAccountProvider(blank)).toBeNull();
    // 隐私模式 / 配额：读抛异常按「没记录」处理，写抛异常不炸页面。
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(loadLastAccountProvider(hostile)).toBeNull();
    expect(() => saveLastAccountProvider(PLAN_PROVIDER_ID, hostile)).not.toThrow();
    expect(loadLastAccountProvider(null)).toBeNull();
    expect(() => saveLastAccountProvider("x", null)).not.toThrow();
  });
});
