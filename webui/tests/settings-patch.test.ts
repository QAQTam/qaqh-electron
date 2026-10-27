/**
 * 设置页差异 patch 的纯逻辑单测(不碰 Solid,故走 bun 运行时也安全)。
 *
 * fixture 与 `crates/qaqh-config-api/src/lib.rs` 的 wire fixture 逐字段对齐——
 * 读模型**拒绝残缺载荷**(缺字段即解析失败),所以测试数据必须是完整形状。
 */
import { describe, expect, test } from "vitest";
import type { ConfigDto } from "../src/api/qaqh/ConfigDto";
import type { SubagentDto } from "../src/api/qaqh/SubagentDto";
import {
  MASK,
  REASONING_EFFORTS,
  buildPatch,
  formatToolList,
  isPatchEmpty,
  needsBypassConfirm,
  parseToolList,
  validatePatch,
  type ConfigPatchWire,
} from "../src/settings/patch";
import { EFFORT_LADDER } from "../src/models/specs";

function dto(overrides: Partial<ConfigDto> = {}): ConfigDto {
  const base: ConfigDto = {
    model: "ox-alpha-free",
    baseUrl: "https://opencode.ai/zen/go/v1",
    wire: "chat",
    maxTokens: 96000,
    contextLength: 1000000,
    reasoningEffort: "max",
    autoCompactThreshold: 0.95,
    permissionLevel: 2,
    apiKey: MASK,
    lang: null,
    fontFamily: "",
    theme: null,
    notificationsEnabled: true,
    activeProfile: "default",
    profiles: ["default"],
    complianceEnabled: false,
    exec: { defaultShell: null },
    sessionIdleUnloadSecs: 0,
    subagent: {
      model: "",
      baseUrl: "",
      apiKey: "",
      apiKeySet: false,
      maxTokens: 4096,
      timeoutSecs: 120,
      defaultTools: [],
      maxDepth: 1,
      messageInFlightPerPair: 16,
      messageOutboundPerSender: 1024,
    },
    mcp: { enabled: false, idleShutdownSecs: 300, servers: [] },
    lsp: { enabled: false, idleShutdownSecs: 600, servers: [] },
    tokenizerPath: null,
  };
  return { ...base, ...overrides };
}

function withSubagent(base: ConfigDto, overrides: Partial<SubagentDto>): ConfigDto {
  return { ...base, subagent: { ...base.subagent, ...overrides } };
}

describe("buildPatch", () => {
  test("完全相同的草稿得到空 patch——保存端据此跳过落盘与 reload 广播", () => {
    const patch = buildPatch(dto(), dto());
    expect(isPatchEmpty(patch)).toBe(true);
    expect(Object.keys(patch)).toEqual([]);
  });

  test("只装改过的字段:改 model 不会把整份配置写回", () => {
    const patch = buildPatch(dto(), dto({ model: "other-model" }));
    expect(Object.keys(patch)).toEqual(["model"]);
    expect(patch.model).toBe("other-model");
  });

  test("掩码与空串 = 保持现值:apiKey 只有填了新密钥才发", () => {
    expect(buildPatch(dto(), dto({ apiKey: MASK })).apiKey).toBeUndefined();
    expect(buildPatch(dto(), dto({ apiKey: "" })).apiKey).toBeUndefined();
    expect(buildPatch(dto(), dto({ apiKey: "sk-new" })).apiKey).toBe("sk-new");
  });

  test("空串=保持的字符串清空即视作未改动(model/baseUrl/endpoint/reasoningEffort)", () => {
    const cleared = dto({ model: "", baseUrl: "", endpoint: "", reasoningEffort: "" });
    const patch = buildPatch(dto(), cleared);
    expect(isPatchEmpty(patch)).toBe(true);
  });

  test("tokenizerPath 是反向语义:改成空串要显式发出(= 清除)", () => {
    const patch = buildPatch(dto({ tokenizerPath: "/tmp/tok.json" }), dto());
    expect(patch.tokenizerPath).toBe("");
  });

  test("theme 不进写模型:主题是桌面壳本地偏好(localStorage)", () => {
    // 后端仍保留读模型字段给其它客户端,但写模型刻意不含它——所以改主题
    // 不该产生任何 patch,更不该触发 daemon 的 config.save 热载广播。
    expect(buildPatch(dto(), dto({ theme: "dark" }))).toEqual({});
    expect(buildPatch(dto({ theme: "dark" }), dto({ theme: null }))).toEqual({});
  });

  test("exec 段:只在真改动时整段发出,空串也算将 defaultShell 清成自动探测", () => {
    expect(buildPatch(dto(), dto()).exec).toBeUndefined();
    expect(buildPatch(dto(), dto({ exec: { defaultShell: "pwsh" } })).exec).toEqual({ defaultShell: "pwsh" });
    // 空串是合法值(回到平台自动探测),不是"未改动"。
    expect(buildPatch(dto({ exec: { defaultShell: "pwsh" } }), dto()).exec).toEqual({ defaultShell: "" });
  });

  test("布尔与数值只在变化时发,complianceEnabled 翻回原值不算改动", () => {
    const patch = buildPatch(dto(), dto({ complianceEnabled: true, maxTokens: 32000, sessionIdleUnloadSecs: 900 }));
    expect(patch).toEqual({ complianceEnabled: true, maxTokens: 32000, sessionIdleUnloadSecs: 900 });
    expect(buildPatch(dto(), dto({ complianceEnabled: false })).complianceEnabled).toBeUndefined();
  });

  test("子代理段:无变化整段缺席;有变化只装子段差异", () => {
    expect(buildPatch(dto(), dto()).subagent).toBeUndefined();
    const patch = buildPatch(dto(), withSubagent(dto(), { timeoutSecs: 240 }));
    expect(patch.subagent).toEqual({ timeoutSecs: 240 });
  });

  test("defaultTools 按内容比较:非空要发,清空成 [] 也要发(= 全部工具可用)", () => {
    const added = buildPatch(dto(), withSubagent(dto(), { defaultTools: ["read"] }));
    expect(added.subagent).toEqual({ defaultTools: ["read"] });
    const emptied = buildPatch(withSubagent(dto(), { defaultTools: ["read"] }), dto());
    expect(emptied.subagent).toEqual({ defaultTools: [] });
    const same = buildPatch(
      withSubagent(dto(), { defaultTools: ["read", "write"] }),
      withSubagent(dto(), { defaultTools: ["read", "write"] }),
    );
    expect(same.subagent).toBeUndefined();
  });

  test("wire 变更:比较按规范名、出网按 daemon 认的旧拼写;同义拼写不算改动", () => {
    // 读模型回显规范名、下拉也摆规范名,但直发规范名会被 daemon 的
    // `ConfigPatch::validate` 400 掉——出网必须换成旧拼写(chat→openai 等)。
    expect(buildPatch(dto({ wire: "messages" }), dto()).wire).toBe("openai");
    expect(buildPatch(dto(), dto({ wire: "messages" })).wire).toBe("anthropic");
    expect(buildPatch(dto(), dto({ wire: "gemini" })).wire).toBe("gemini");
    // 规范名与旧拼写是同一个值(后端 `Wire::parse` 同一枚举):比较先归一,不产生差异。
    expect(isPatchEmpty(buildPatch(dto({ wire: "openai" }), dto({ wire: "chat" })))).toBe(true);
    // 没改就不发。
    expect(buildPatch(dto(), dto()).wire).toBeUndefined();
  });

  test("档位从 2 改成 3 才触发 bypass 确认;2→1 不要", () => {
    expect(needsBypassConfirm(buildPatch(dto(), dto({ permissionLevel: 3 })))).toBe(true);
    expect(needsBypassConfirm(buildPatch(dto(), dto({ permissionLevel: 1 })))).toBe(false);
  });
});

describe("validatePatch", () => {
  test("干净草稿通过校验", () => {
    expect(validatePatch(buildPatch(dto(), dto()))).toBeNull();
  });

  test("autoCompactThreshold 闭区间:[0,1] 放行,0=关闭;1.5 与 NaN 拒绝", () => {
    expect(validatePatch({ autoCompactThreshold: 0 })).toBeNull();
    expect(validatePatch({ autoCompactThreshold: 1 })).toBeNull();
    expect(validatePatch({ autoCompactThreshold: 1.5 })).toContain("autoCompactThreshold");
    expect(validatePatch({ autoCompactThreshold: Number.NaN })).toContain("autoCompactThreshold");
  });

  test("maxTokens/contextLength 必须 > 0(后端 u64→u32 饱和,0 无意义)", () => {
    expect(validatePatch({ maxTokens: 0 })).toContain("maxTokens");
    expect(validatePatch({ contextLength: 0 })).toContain("contextLength");
    expect(validatePatch({ maxTokens: 96000 })).toBeNull();
  });

  test("wire 两种拼写都收;出网落成 daemon 写模型认的旧拼写(规范名被改写)", () => {
    // 规范名(读模型回显)与旧拼写(更早配置)是同一个枚举的两种写法;收全,
    // 但落成 daemon `ConfigPatch::validate` 认的那组(直发 chat/messages = 400)。
    const mappings: Array<[string, string]> = [
      ["chat", "openai"],
      ["responses", "responses"],
      ["messages", "anthropic"],
      ["gemini", "gemini"],
    ];
    for (const [wire, expected] of mappings) {
      const patch: ConfigPatchWire = { wire };
      expect(validatePatch(patch), wire).toBeNull();
      expect(patch.wire, wire).toBe(expected);
    }
    // 旧拼写直通且幂等。
    const legacy: ConfigPatchWire = { wire: "anthropic" };
    expect(validatePatch(legacy)).toBeNull();
    expect(legacy.wire).toBe("anthropic");
    // 词表外的值与空串照旧拒绝。
    expect(validatePatch({ wire: "deepseek" })).toContain("wire");
    expect(validatePatch({ wire: "" })).toContain("wire");
  });

  test("reasoningEffort 逐档对齐后端词表(六档,ultra 收尾)", () => {
    // 词表权威 = 上游 `origin/main`:`ConfigPatch::validate` 收
    // `low|medium|high|xhigh|max|ultra`(qaqh-config-api/src/lib.rs,随 aa7f2b3 一起改)。
    // 本地那份 `../qaqh-backend` checkout 停在加 ultra 之前(五档),照它改会砍掉合法档。
    for (const effort of REASONING_EFFORTS) {
      expect(validatePatch({ reasoningEffort: effort }), effort).toBeNull();
    }
    // 后端拒的值前端也不许放行:空串走"保持现值"语义,不进 patch;越词表的直接拒。
    expect(validatePatch({ reasoningEffort: "off" })).toContain("reasoningEffort");
    expect(validatePatch({ reasoningEffort: "extreme" })).toContain("reasoningEffort");
  });

  test("设置页词表与强度轨道同源:两处档位不许各自漂移", () => {
    // composer 的轨道档位来自 `models/specs::EFFORT_LADDER`,设置页下拉来自
    // `settings/patch::REASONING_EFFORTS`。两份名单一旦不同序,就会出现
    // "轨道能拖到的值下拉里没有 / 下拉里选得到后端却不认"。
    expect([...REASONING_EFFORTS]).toEqual([...EFFORT_LADDER]);
  });

  test("permissionLevel 三档制:4(旧 Unrestricted)与 5 都拒", () => {
    for (const level of [1, 2, 3]) expect(validatePatch({ permissionLevel: level })).toBeNull();
    expect(validatePatch({ permissionLevel: 4 })).toContain("permissionLevel");
    expect(validatePatch({ permissionLevel: 5 })).toContain("permissionLevel");
  });

  test("子代理值域:maxDepth 1..=16,timeoutSecs/maxTokens > 0", () => {
    expect(validatePatch({ subagent: { maxDepth: 17 } })).toContain("subagent.maxDepth");
    expect(validatePatch({ subagent: { maxDepth: 1 } })).toBeNull();
    expect(validatePatch({ subagent: { timeoutSecs: 0 } })).toContain("subagent.timeoutSecs");
    expect(validatePatch({ subagent: { maxTokens: 0 } })).toContain("subagent.maxTokens");
  });
});

describe("工具清单文本互转", () => {
  test("逗号分隔解析:空白项丢弃,空串得空数组(= 全部可用)", () => {
    expect(parseToolList("read, write ,")).toEqual(["read", "write"]);
    expect(parseToolList("")).toEqual([]);
    expect(formatToolList(["read", "write"])).toBe("read, write");
  });
});
