/**
 * 会话设置的清除语义:`SettingValue::Inherit`。
 *
 * 后端把 `model_selection` 的 `Use` 落 JSON、`Inherit` **清列并跟随全局默认**
 * (qaqh-session `db/store.rs:305`),卡片上那句「跟随存档」说的就是这件事。
 * 本轮之前全仓从没发出过 inherit:`setSessionModel(null)` 直接 throw,那个按钮
 * 一点就报错;而 effort/maxTokens 在无选择时也是抛错,尽管「清除」本应是无操作。
 */
import { afterEach, expect, test, vi } from "vitest";
import type { ModelSelection } from "../src/api/qaqh/ModelSelection";
import { transport } from "../src/lib/transport";
import { refreshRegistry } from "../src/settings/registry";
import { SessionStore } from "../src/session/store";

const SEED = "ses-settings-inherit";

type MetaInput = {
  selection?: ModelSelection | null;
  revision?: number;
  /** 存档的全局默认(`provider.list.default_model_selection`)。 */
  archiveDefault?: ModelSelection | null;
};

function metaOf(input: MetaInput) {
  return {
    session_id: SEED,
    created_at: 0,
    updated_at: 0,
    model: input.selection?.model_id ?? "global-model",
    model_selection: input.selection ?? null,
    requested_model_selection: input.selection ?? null,
    turn_count: 0,
    settings_revision: input.revision ?? 4,
    compact_skip: 0,
    tool_mode: "standard",
    custom_tools: [],
    archived: false,
    ephemeral: false,
    skills: { enabled: [], disabled: [] },
    usage_totals: {},
    usage_requests: 0,
    cache_reported_requests: 0,
    title: null,
    cwd: null,
  };
}

/**
 * 装好 `session.meta` 与命令通道,把每次 `session.settings.patch` 的
 * (命令, 目标, 前置条件)原样记下来——CAS 的 revision 也是被断言的一部分。
 */
function harness(input: MetaInput = {}) {
  const patches: Array<{ command: unknown; target: unknown; preconditions: unknown }> = [];
  vi.spyOn(transport, "query").mockImplementation(async () => metaOf(input) as never);
  vi.spyOn(transport, "command").mockImplementation(async (command, target, preconditions) => {
    if (command.type === "provider.list") {
      return {
        command_id: "read", status: "accepted",
        result: structuredClone({ revision: 0, default_model_selection: input.archiveDefault ?? null, providers: {} }),
      } as never;
    }
    if (command.type === "session.settings.patch") {
      patches.push({ command: structuredClone(command), target, preconditions });
      return { command_id: "patch", status: "accepted", revision: (input.revision ?? 4) + 1 } as never;
    }
    return { command_id: "noop", status: "accepted", result: {} } as never;
  });
  return { store: new SessionStore(SEED), patches };
}

const selection = (overrides: Partial<ModelSelection> = {}): ModelSelection => ({
  provider_id: "prov-a", model_id: "model-a", options: {}, ...overrides,
});

afterEach(() => vi.restoreAllMocks());

test("模型行的「跟随存档」发出 Inherit,并带着读到的 settings_revision", async () => {
  const { store, patches } = harness({ selection: selection() });
  await expect(store.setSessionModel(null)).resolves.toBeUndefined();

  expect(patches).toHaveLength(1);
  expect(patches[0]!.command).toEqual({
    type: "session.settings.patch",
    patch: { model_selection: { kind: "inherit" } },
  });
  expect(patches[0]!.target).toEqual({ kind: "session", session_id: SEED });
  expect(patches[0]!.preconditions).toEqual([{ kind: "settings_revision", revision: 4 }]);
});

test("本会话已经跟随存档时,清除强度/上限是无操作,不是报错", async () => {
  const { store, patches } = harness({ selection: null });
  await store.refreshProfile(); // 让「没有选择」来自后端答话,而不是没读过 meta
  await expect(store.setSessionEffort(null)).resolves.toBeUndefined();
  await expect(store.setSessionMaxTokens(null)).resolves.toBeUndefined();
  expect(patches).toHaveLength(0);
});

test("没有可依附的选择时要设定档位/上限,报的是能照做的错", async () => {
  const { store, patches } = harness({ selection: null });
  await store.refreshProfile();
  await expect(store.setSessionEffort("high")).rejects.toThrow(/先在「模型」行选一个/);
  await expect(store.setSessionMaxTokens(8192)).rejects.toThrow(/先在「模型」行选一个/);
  expect(patches).toHaveLength(0);
});

test("换强度沿用本会话的 provider/model 对,只改 options 的叶子", async () => {
  const { store, patches } = harness({
    selection: selection({ options: { reasoning_effort: "low", max_output_tokens: 4096 } }),
  });
  // 卡片的写口读的是**已重读过的** meta(激活、或上一次写入后各重读一次)。
  // 没有这一步就没有可继承的选择——这条前提本身也是被断言的一部分。
  await store.refreshProfile();
  await store.setSessionEffort("high");
  expect(patches[0]!.command).toEqual({
    type: "session.settings.patch",
    patch: { model_selection: { kind: "use", value: {
      provider_id: "prov-a", model_id: "model-a",
      options: { reasoning_effort: "high", max_output_tokens: 4096 },
    } } },
  });
});

test("换模型沿用 provider(后端要求整对合法,缺档位/超上限会 400)", async () => {
  const { store, patches } = harness({ selection: selection() });
  await store.refreshProfile();
  await store.setSessionModel("model-b");
  const value = (patches[0]!.command as { patch: { model_selection: { value: ModelSelection } } })
    .patch.model_selection.value;
  expect(value.provider_id).toBe("prov-a");
  expect(value.model_id).toBe("model-b");
});

test("清成「跟随存档」之后仍能从模型行换回来:以存档默认那一对为底落 Use", async () => {
  const { store, patches } = harness({
    selection: null,
    archiveDefault: selection({ provider_id: "prov-archive", model_id: "model-archive" }),
  });
  await store.refreshProfile(); // 读 meta:本会话没有选择,但有 settings_revision 可用
  // registry 是模块级缓存,前面的用例已经拿「无默认」填过一次;这里显式重读,
  // 否则继承的底会被上一条用例的缓存污染成 null。
  await refreshRegistry();
  await expect(store.setSessionModel("model-b")).resolves.toBeUndefined();
  const value = (patches[0]!.command as { patch: { model_selection: { value: ModelSelection } } })
    .patch.model_selection.value;
  expect(value.provider_id).toBe("prov-archive");
  expect(value.model_id).toBe("model-b");
});
