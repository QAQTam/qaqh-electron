// Mock 接线层：浏览器/dev 形态下驱动 TabsStore + projection + 交互事件。
// Electron 真形态由 lib/client.ts 替代本文件（App 按 bridge() 是否存在二选一）。
import type { SessionView } from "qaqh-js-sdk";
import { MOCK_SESSIONS, archivedSession, type MockSession } from "./mockData";
import { tabsStore } from "../../src/state/tabs";
import { pushToast } from "../../src/ui/Toast";
import { connectionStore } from "../../src/state/connection";

function toView(m: MockSession): SessionView {
  return {
    seed: m.seed,
    title: m.title,
    activity: m.activity,
    turns: m.snapshot.turns.map((t) => ({
      turnId: t.turn_id,
      createdSeq: t.created_seq,
      userText: t.user_text,
      sealed: t.sealed,
      state: t.state,
      failure: t.failure,
      usage: null,
      rounds: t.rounds.map((r) => ({
        roundNum: r.round_num,
        isFinal: r.is_final,
        sealed: r.sealed,
        thinking: null,
        answer: null,
        outputRef: null,
        streaming: { thinking: "", answer: "" },
        blocks: r.blocks,
      })),
    })),
    tools: m.snapshot.turns.flatMap((t) =>
      t.rounds.flatMap((r) =>
        r.blocks
          .filter((b) => b.tool)
          .map((b) => ({
            toolCallId: b.tool!.tool_call_id,
            turnId: t.turn_id,
            roundNum: r.round_num,
            name: b.tool!.name,
            argsSoFar: b.tool!.args_json ?? "",
            status: b.tool!.state === "succeeded" || b.tool!.state === "failed" ? "finished" : b.tool!.state === "running" ? "running" : "prepared",
            result: b.tool!.state === "succeeded" || b.tool!.state === "failed"
                ? {
                  status: b.tool!.state === "failed" ? ("error" as const) : ("ok" as const),
                  summary: b.tool!.summary ?? "",
                  data: null,
                  model: { text: "", truncated: false, total_tokens: 0 },
                  diff: b.tool!.diff ?? undefined,
                  output_ref: null,
                  error: null,
                }
              : undefined,
            permission: undefined,
          })),
      ),
    ),
    pendingPermissions: m.pendingPermission
      ? [
          {
            toolCallId: m.pendingPermission.toolCallId,
            turnId: "t2",
            roundNum: 2,
            name: m.pendingPermission.toolName,
            argsSoFar: "",
            status: "prepared" as const,
            permission: {
              toolCallId: m.pendingPermission.toolCallId,
              toolName: m.pendingPermission.toolName,
              reason: m.pendingPermission.reason,
              paths: m.pendingPermission.paths,
              category: m.pendingPermission.category,
              level: m.pendingPermission.level,
              risk: m.pendingPermission.risk,
              consequence: m.pendingPermission.consequence,
            },
          },
        ]
      : [],
    notices: [],
  };
}

/** 视图注册表：App 通过 useSession 从 projection 读；mock 直接塞 view map。 */
const mockViews = new Map<string, SessionView>();

export function mockSessionView(seed: string): SessionView | null {
  return mockViews.get(seed) ?? null;
}

export function initMockWorld(): void {
  // mock 连接态：直接 ready（视觉验收）
  connectionStore.setInfo({
    endpoint: "http://127.0.0.1:8712",
    serverEpoch: "epoch-9f21c4a7",
    leaseTtlMs: 300_000,
    leasedAt: Date.now(),
    adopted: true,
  });
  tabsStore.ingestList(
    [...MOCK_SESSIONS, archivedSession].map((m) => ({
      seed: m.seed,
      title: m.title,
      cwd: m.cwd,
      model: m.model,
      mode: m.mode,
      archived: m === archivedSession,
    })),
  );
  for (const m of [...MOCK_SESSIONS, archivedSession]) {
    mockViews.set(m.seed, toView(m));
    tabsStore.patch(m.seed, {
      activity: m.activity,
      pendingCount: m.pendingPermission ? 1 : m.ask ? m.ask.questions.length : 0,
    });
    tabsStore.patchMeta(m.seed, {
      contextUsed: m.contextUsed,
      contextLimit: m.contextLimit,
    });
  }
  const qs = new URLSearchParams(window.location.search).get("tab");
  const idx = qs ? parseInt(qs, 10) : 0;
  tabsStore.setActive(MOCK_SESSIONS[idx]!.seed);

  // ── 交互事件接线（UI 动作 → mock 响应） ──
  window.addEventListener("qaqh:activateTab", (e) => {
    const seed = (e as CustomEvent<string>).detail;
    tabsStore.setActive(seed);
  });

  window.addEventListener("qaqh:newSession", () => {
    const seed = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    tabsStore.adoptCreated(seed);
    mockViews.set(seed, {
      seed,
      title: "未命名会话",
      activity: "idle",
      turns: [],
      tools: [],
      pendingPermissions: [],
      notices: [],
    });
    tabsStore.patch(seed, { activity: "idle", attached: true, hydrated: true });
  });

  window.addEventListener("qaqh:closeSession", (e) => {
    tabsStore.remove((e as CustomEvent<string>).detail);
  });

  window.addEventListener("qaqh:toast", (e) => {
    pushToast((e as CustomEvent<string>).detail);
  });

  window.addEventListener("qaqh:setMode", (e) => {
    const { seed, mode } = (e as CustomEvent<{ seed: string; mode: "plan" | "code" }>).detail;
    if (seed) tabsStore.patchMeta(seed, { mode });
    pushToast(`已切换到 ${mode.toUpperCase()} 模式`);
  });

  window.addEventListener("qaqh:send", (e) => {
    const { seed, text } = (e as CustomEvent<{ seed: string; text: string }>).detail;
    const view = mockViews.get(seed);
    if (!view) return;
    // 模拟一个立即完成的回合（视觉验收：用户消息 + 简短回复）
    const turnId = `t${Date.now()}`;
    view.turns.push({
      turnId,
      createdSeq: view.turns.length + 1,
      userText: text,
      sealed: true,
      state: "completed",
      failure: null,
      usage: { total: 128, input: 100, output: 28 },
      rounds: [
        {
          roundNum: 1,
          isFinal: true,
          sealed: true,
          thinking: null,
          answer: null,
          outputRef: null,
          streaming: { thinking: "", answer: "" },
          blocks: [
            {
              block_id: `b-${turnId}-0`,
              block_order: 0,
              kind: "text",
              state: "sealed",
              text: "（mock 回复）收到你的消息：\n\n> " + text.slice(0, 120) + "\n\n这是 mock 模式的静态回复，用于视觉验收。连接真实 daemon 后将由 worker 流式生成。",
              tool: null,
            },
          ],
        },
      ],
    });
    const tab = tabsStore.tab(seed);
    if (tab) {
      tabsStore.patch(seed, { activity: "working" });
      setTimeout(() => tabsStore.patch(seed, { activity: "idle" }), 1500);
    }
    // 触发 rev 更新：mock 下直接发全局事件让 App 重读
    window.dispatchEvent(new CustomEvent("qaqh:mockBatch"));
  });
}
