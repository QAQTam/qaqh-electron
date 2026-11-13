/**
 * 交接链路的渲染面验收（施工单 §三 + §五）。
 *
 * 盯三条：
 * 1. **看门狗插话不是用户说的话**：它渲染成系统插话行，且**绝不**出现在用户气泡里
 *    （后端把它按普通 timeline input 落库，老渲染会把用户原话顶掉）；
 * 2. 回合尾部常驻「继续这条交接 →」——客户端掉线时唯一接得回 B 的入口；
 * 3. `handoff_path` 不上屏：那是本地镜像 `.md`，不是 URL，也不是权威副本。
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

import { createComponent, flush } from "solid-js";
import { render } from "@solidjs/web";
import { TurnView } from "../src/turn/TurnView";
import type { HandoffSealedView } from "../src/session/handoff";
import type { SessionStore } from "../src/session/store";
import type { Turn } from "../src/session/types";

const REPORT = {
  handed_off: true,
  from_session_id: "ses_A",
  turn_id: "turn_A",
  work_summary: "把交接链路接通",
  handoff_doc: "## 当前任务\n继续 §七 第 1 条",
  handoff_path: "C:\\Users\\QAQTam\\.qaqh\\sessions\\ses_A\\handoff\\handoff-11-10-190233.md",
  modified_files: ["webui/src/session/reducer.ts"],
  context_used_tokens: 960,
  context_window_tokens: 1000,
};
const SEALED = `已封箱交接。本会话到此为止。\n\n\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``;
const WATCHDOG_TEXT = "[系统] 上下文占用 96%（960 / 1000 tokens）。本轮必须调用 handoff 写交接文档";

function makeTurn(options: { withUserPrompt: boolean; sealed: boolean; endedAt?: number }): Turn {
  const steps: Turn["steps"] = [
    {
      kind: "interject",
      id: "block_watchdog",
      seq: 0,
      purpose: "interject",
      actorKind: "api",
      actorId: "handoff-watchdog",
      actorName: "上下文看门狗",
      text: WATCHDOG_TEXT,
    },
  ];
  if (options.sealed) {
    steps.push({
      kind: "tool",
      id: "call_handoff",
      seq: 1,
      name: "handoff",
      status: "finished",
      state: { kind: "finished", outcome: { kind: "completed" } },
      argsJson: JSON.stringify({ handoff_doc: REPORT.handoff_doc, work_summary: REPORT.work_summary }),
      output: { text: SEALED },
      ...(options.endedAt != null ? { endedAt: options.endedAt } : {}),
    });
  }
  return {
    id: "turn_A",
    key: "turn_A",
    inputId: null,
    turnIndex: null,
    user: options.withUserPrompt ? { text: "帮我把测试跑通", blockId: "block_primary" } : { text: "" },
    steps,
    answer: null,
    answerStepId: null,
    status: "done",
    expanded: true,
  };
}

/** TurnView 只读这几路信号；视图测试不需要真的状态机。 */
function fakeStore(turn: Turn, latest = true, sealed: HandoffSealedView | null = null): SessionStore {
  // latest=false 时在槽位尾部塞一个更新的回合键:isLatestTurn 据此判这条卡不是最新。
  const slots: Array<{ kind: "turn"; key: string }> = latest
    ? [{ kind: "turn", key: turn.key }]
    : [{ kind: "turn", key: turn.key }, { kind: "turn", key: "turn_newer" }];
  return {
    seed: REPORT.from_session_id,
    state: [{ slots, turns: { [turn.key]: turn } }],
    composerProfile: [{ providerKind: "byok" }],
    composerModel: ["gpt-5-flash"],
    contentStatus: [{}],
    handoffSealed: () => sealed,
    retryContent: () => {},
    sendMessage: async () => {},
  } as unknown as SessionStore;
}

let root: HTMLElement;

function mount(turn: Turn, latest = true, sealed: HandoffSealedView | null = null): void {
  root = document.createElement("div");
  document.body.append(root);
  render(() => createComponent(TurnView, {
    turn, waits: [], store: fakeStore(turn, latest, sealed),
    // latest=false 时必须留给 TurnView 自己扫槽位:显式 true 会短路 isLatestTurn。
    isLatestTurn: latest ? true : undefined,
  }), root);
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { document.body.replaceChildren(); });

test("看门狗插话渲染成系统插话行，用户气泡里仍是用户原话", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: false }));
  await flush();

  const bubble = root.querySelector(".turn-user .bubble");
  expect(bubble?.textContent).toBe("帮我把测试跑通");
  expect(bubble?.textContent).not.toContain("[系统]");

  const row = root.querySelector(".interject-row");
  expect(row?.classList.contains("is-system")).toBe(true);
  expect(row?.querySelector(".interject-label")?.textContent).toBe("上下文看门狗");
  expect(row?.textContent).toContain("96%");
});

test("同回合只有插话时不造空的用戶气泡", async () => {
  mount(makeTurn({ withUserPrompt: false, sealed: false }));
  await flush();
  expect(root.querySelector(".turn-user")).toBeNull();
  expect(root.querySelector(".interject-row.is-system")).not.toBeNull();
});

test("封箱的交接把常驻入口挂在回合尾部，且本地镜像路径不上屏", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: true }));
  await flush();

  const card = root.querySelector(".handoff-card");
  expect(card).not.toBeNull();
  // 无封箱时间戳(历史重放)不挂「刚封箱」动画类:重开/滚动重挂不翻旧账。
  expect(card?.classList.contains("is-fresh")).toBe(false);
  expect(card?.querySelector(".handoff-head strong")?.textContent).toBe("已封箱交接");
  expect(card?.querySelector(".handoff-summary")?.textContent).toContain(REPORT.work_summary);
  expect(card?.querySelector(".handoff-occupancy")?.textContent).toContain("96%");
  expect(root.querySelector<HTMLButtonElement>(".handoff-continue")?.textContent?.trim()).toBe("继续这条交接 →");
  expect(root.querySelector(".handoff-opened")).toBeNull();
  // §二：那是本地镜像 .md，不是 URL；摆出来只会被当成可下载的链接。
  expect(root.textContent).not.toContain("handoff-11-10-190233");
});

test("刚封箱（挂载时距封箱 10s 内）才播动画：is-fresh 只挂在这条上", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: true, endedAt: Date.now() }));
  await flush();
  expect(root.querySelector(".handoff-card")?.classList.contains("is-fresh")).toBe(true);
});

test("封箱已过去（超过动画窗口）不播动画", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: true, endedAt: Date.now() - 60_000 }));
  await flush();
  expect(root.querySelector(".handoff-card")?.classList.contains("is-fresh")).toBe(false);
});

test("未交接的卡自动武装 10s 倒计时，取消即回人工入口", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: true, endedAt: Date.now() }));
  await flush();

  expect(root.querySelector(".handoff-countdown")).not.toBeNull();
  expect(root.querySelector(".handoff-countdown-label")?.textContent).toContain("10s 后自动继续交接");
  root.querySelector<HTMLButtonElement>(".handoff-countdown-cancel")?.click();
  await flush();

  expect(root.querySelector(".handoff-countdown")).toBeNull();
  expect(root.querySelector(".handoff-continue")).not.toBeNull();
});

test("更早的历史交接卡不武装倒计时（重开客户端不成批点火）", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: true, endedAt: Date.now() - 60_000 }), false);
  await flush();

  expect(root.querySelector(".handoff-countdown")).toBeNull();
  expect(root.querySelector(".handoff-continue")).not.toBeNull();
});

test("后继已知(HandoffSealed 到过/血缘在场):只给「打开交接会话」,不再武装倒计时", async () => {
  const sealed: HandoffSealedView = {
    sealedSessionId: REPORT.from_session_id,
    successorSessionId: "ses_CHILD",
    turnId: REPORT.turn_id,
    workSummary: REPORT.work_summary,
    atMs: Date.now(),
  };
  mount(makeTurn({ withUserPrompt: true, sealed: true }), true, sealed);
  await flush();

  expect(root.querySelector(".handoff-continue")).toBeNull();
  expect(root.querySelector(".handoff-opened")?.textContent).toBe("打开交接会话");
  expect(root.querySelector(".handoff-countdown")).toBeNull();
});

test("机器面整段读不出来时入口照样在，并标明这条是推定", async () => {
  const turn = makeTurn({ withUserPrompt: true, sealed: true });
  // 账本的同步权威是模块级 Map，清 localStorage 清不掉它：这条用例换一把自己的
  // key，免得读到上一条留下的 fork 记录（那是被测行为，不是夹具）。
  turn.id = "turn_dup";
  turn.key = "turn_dup";
  // 同回合重复调用（或 tool_result 正文取不到）：输出只有人话，没有 handed_off。
  const step = turn.steps[1];
  if (step?.kind === "tool") step.output = { text: "这一回合已经交接过了，不再重复封箱。" };
  mount(turn);
  await flush();

  expect(root.querySelector(".handoff-card")).not.toBeNull();
  expect(root.querySelector(".handoff-continue")?.textContent).toContain("继续这条交接");
  expect(root.textContent).toContain("没读到机器面");
});

test("交接工具行显示工作简述，不是整篇文档的第一个字符串", async () => {
  mount(makeTurn({ withUserPrompt: true, sealed: true }));
  await flush();
  // 终态回合的工作段默认折叠(Collapse 折叠时不挂子树)，点开才看得见工具行。
  root.querySelector<HTMLButtonElement>(".collapsed-row")?.click();
  await flush();

  const row = root.querySelector("[data-tool-call-id=\"call_handoff\"]");
  expect(row?.querySelector(".tool-name")?.textContent).toBe("交接给新会话");
  // TextShimmer 是字符级双层(base + glow),textContent 天然重复 —— 只验内容与边界。
  const summary = row?.querySelector(".tool-summary")?.textContent ?? "";
  expect(summary).toContain(REPORT.work_summary);
  expect(summary).not.toContain("##");   // 不是整篇 handoff_doc 的第一个字符串
  expect(row?.querySelector(".tool-state")?.textContent).toBe("已封箱交接");
});
