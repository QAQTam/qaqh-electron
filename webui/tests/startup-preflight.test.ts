/**
 * 启动页预检态的判合规则(阶段B)。
 *
 * 纯函数层,不吃 solid 也不吃 transport——这里定的叶子语义必须**能**脱离宿主验证:
 * - 换模型清掉 options 的档位叶子(跨模型沿用旧档位会被后端 resolver 400 拒,
 *   交接文档 §3;丢叶子是正确行为);
 * - 清除(null)在没有可清的叶子时是无操作,设定值却没有整对时以**存档默认**为底
 *   ——与会话页 `setSessionEffort/setSessionModel` 同一套语义(`session/store.ts`)。
 */
import { expect, test } from "vitest";
import type { ModelSelection } from "../src/api/qaqh/ModelSelection";
import type { Registry, RegistryProvider } from "../src/settings/registry";
import {
  EMPTY_PREFLIGHT,
  normalizePreflight,
  preflightCreateArgs,
  readPreflight,
  writePreflight,
  writePreflightEffort,
  writePreflightMaxTokens,
  writePreflightModel,
  writePreflightToolMode,
  type StartupPreflight,
} from "../src/composer/startup-preflight";

const selection = (overrides: Partial<ModelSelection> = {}): ModelSelection => ({
  provider_id: "prov-a", model_id: "model-a", options: {}, ...overrides,
});

const provider = (id: string, models: Array<[string, boolean]>): RegistryProvider => ({
  id, name: id, baseUrl: "https://example.invalid", wire: "openai", credential: "api_key",
  apiKeySet: true, headers: {}, compat: null, referencedBy: [],
  models: models.map(([modelId, enabled]) => ({
    id: modelId, definition: { display_name: modelId, enabled } as never,
  })),
});

const catalog = (defaultSelection: ModelSelection | null, providers: RegistryProvider[]): Registry =>
  ({ revision: 1, defaultSelection, providers });

const WITH_PAIR = catalog(selection({ model_id: "model-default" }), [
  provider("prov-a", [["model-a", true], ["model-b", true], ["model-off", false]]),
  provider("prov-b", [["model-c", true]]),
  provider("prov-dead", [["model-a", false]]),
]);

test("换模型整对清叶子:provider 优先沿用当前一对", () => {
  const current: StartupPreflight = {
    modelSelection: selection({ options: { reasoning_effort: "high", max_output_tokens: 4096 } }),
    toolMode: "minimal:b", customTools: [],
  };
  const next = writePreflightModel(current, WITH_PAIR, "model-b");
  expect(next.modelSelection).toEqual({ provider_id: "prov-a", model_id: "model-b", options: {} });
  // 与模型无关的预检叶子(工具模式)必须原样保留。
  expect(next.toolMode).toBe("minimal:b");
});

test("当前 provider 没有这个模型时,退回存档默认 provider,再退回首个启用登记它的 provider", () => {
  const pinned = catalog(selection({ model_id: "model-a" }), [
    provider("prov-a", [["model-a", true]]),
    provider("prov-archive", [["model-c", true]]),
  ]);
  // 存档默认 provider 持有 → 用它。
  expect(writePreflightModel(EMPTY_PREFLIGHT, pinned, "model-c").modelSelection?.provider_id)
    .toBe("prov-archive");
  const nobody = catalog(null, [provider("prov-a", [["model-a", true]])]);
  expect(() => writePreflightModel(EMPTY_PREFLIGHT, nobody, "model-x"))
    .toThrow(/不在任何已启用的服务商登记里/);
  // 停用的登记不算数。
  expect(() => writePreflightModel(EMPTY_PREFLIGHT, WITH_PAIR, "model-off"))
    .toThrow(/不在任何已启用的服务商登记里/);
});

test("「跟随存档默认」把预检整对清掉,不动其他叶子", () => {
  const current: StartupPreflight = { modelSelection: selection(), toolMode: "custom", customTools: ["exec"] };
  const next = writePreflightModel(current, WITH_PAIR, null);
  expect(next.modelSelection).toBeNull();
  expect(next.toolMode).toBe("custom");
  expect(next.customTools).toEqual(["exec"]);
});

test("设定强度/上限却没有整对时,以存档默认那一对为底落叶子;清除是 no-op 且同一引用返回", () => {
  const effort = writePreflightEffort(EMPTY_PREFLIGHT, WITH_PAIR, "high");
  expect(effort.modelSelection).toEqual({
    provider_id: "prov-a", model_id: "model-default", options: { reasoning_effort: "high" },
  });
  const tokens = writePreflightMaxTokens(EMPTY_PREFLIGHT, WITH_PAIR, 8192);
  expect(tokens.modelSelection?.options.max_output_tokens).toBe(8192);

  expect(writePreflightEffort(EMPTY_PREFLIGHT, WITH_PAIR, null)).toBe(EMPTY_PREFLIGHT);
  expect(writePreflightMaxTokens(EMPTY_PREFLIGHT, WITH_PAIR, null)).toBe(EMPTY_PREFLIGHT);

  const noDefault = catalog(null, [provider("prov-a", [["model-a", true]])]);
  expect(() => writePreflightEffort(EMPTY_PREFLIGHT, noDefault, "high")).toThrow(/先在「模型」行选一个/);
  expect(() => writePreflightMaxTokens(EMPTY_PREFLIGHT, noDefault, 1024)).toThrow(/先在「模型」行选一个/);
});

test("已有整对时,设定只动自己的叶子,清除只删自己的叶子", () => {
  const both: StartupPreflight = {
    modelSelection: selection({ options: { reasoning_effort: "low", max_output_tokens: 4096 } }),
    toolMode: "", customTools: [],
  };
  expect(writePreflightEffort(both, WITH_PAIR, "high").modelSelection?.options)
    .toEqual({ reasoning_effort: "high", max_output_tokens: 4096 });
  expect(writePreflightEffort(both, WITH_PAIR, null).modelSelection?.options)
    .toEqual({ max_output_tokens: 4096 });
  expect(writePreflightMaxTokens(both, WITH_PAIR, null).modelSelection?.options)
    .toEqual({ reasoning_effort: "low" });
});

test("custom 的空白名单被写口挡下(后端会 400);切离 custom 清掉白名单", () => {
  expect(writePreflightToolMode(EMPTY_PREFLIGHT, "custom", [])).toBe(EMPTY_PREFLIGHT);
  const custom = writePreflightToolMode(EMPTY_PREFLIGHT, "custom", ["exec", "read"]);
  expect(custom).toEqual({ modelSelection: null, toolMode: "custom", customTools: ["exec", "read"] });
  const switched = writePreflightToolMode(custom, "minimal:b", []);
  expect(switched.toolMode).toBe("minimal:b");
  expect(switched.customTools).toEqual([]);
});

test("发送组装:null 选择/空档/standard 都省略给后端回落,custom 连白名单一起发", () => {
  expect(preflightCreateArgs(EMPTY_PREFLIGHT))
    .toEqual({ modelSelection: null, toolMode: null, customTools: null });
  expect(preflightCreateArgs(writePreflightToolMode(EMPTY_PREFLIGHT, "standard", [])))
    .toEqual({ modelSelection: null, toolMode: null, customTools: null });
  const pinned = preflightCreateArgs(writePreflightToolMode(
    { ...EMPTY_PREFLIGHT, modelSelection: selection() }, "custom", ["exec"]));
  expect(pinned).toEqual({ modelSelection: selection(), toolMode: "custom", customTools: ["exec"] });
});

test("回读只信自己的形状:坏 JSON、缺字段、非 custom 的白名单一律塌回", () => {
  expect(normalizePreflight(null)).toBe(EMPTY_PREFLIGHT);
  expect(normalizePreflight({ modelSelection: { provider_id: "", model_id: "m" } })).toBe(EMPTY_PREFLIGHT);
  const partial = normalizePreflight({
    modelSelection: { provider_id: "prov-a", model_id: "model-a", options: { reasoning_effort: 7 } },
    toolMode: "custom", customTools: ["read", 42],
  });
  expect(partial.modelSelection!.options.reasoning_effort).toBeUndefined(); // 非字符串叶子整键省略
  expect(partial.customTools).toEqual(["read"]); // 非字符串条目丢弃
  const orphan = normalizePreflight({ toolMode: "minimal", customTools: ["exec"] });
  expect(orphan.customTools).toEqual([]); // 非 custom 不复活白名单
});

const fakeStorage = (): { map: Map<string, string>; removed: string[]; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } => {
  const map = new Map<string, string>();
  const removed: string[] = [];
  return {
    map, removed,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { removed.push(key); map.delete(key); },
  };
};

test("空预检不落存;有预检时 JSON 往返;读坏数据塌回空", () => {
  const store = fakeStorage();
  writePreflight(store, EMPTY_PREFLIGHT);
  expect(store.map.size).toBe(0);
  expect(store.removed).toContain("qaqh.startup.preflight");

  const pinned = writePreflightEffort(EMPTY_PREFLIGHT, WITH_PAIR, "high");
  writePreflight(store, pinned);
  expect(readPreflight(store)).toEqual(pinned);

  store.map.set("qaqh.startup.preflight", "{ not json");
  expect(readPreflight(store)).toBe(EMPTY_PREFLIGHT);
});
