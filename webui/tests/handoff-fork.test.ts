/**
 * fork 那条链路：三条现成命令 + 同一交接只 fork 一次。
 *
 * 对位施工单 §一·2 与 §七 第 4 条（客户端关掉再触发交接 → 重开后点「继续这条
 * 交接」→ B 正常生成）。这里不碰真 daemon，断言的是**命令面**：
 * `session.create` 抄齐 A 的 `session.meta` 四项、标题用 work_summary；
 * `conversation.send_message` 把交接文档投成 B 的第一条输入（`trigger_turn`）；
 * 接管走本仓既有路径（`openSession` → `SessionStore.activate` → 宿主 attach）。
 *
 * 假 store 与注入点都写在 `vi.mock` 工厂内部：工厂在 `../src/tabs/store` 被求值时
 * 才跑，但它比测试文件的顶层语句更早——引用测试文件里的变量会撞 TDZ。
 */
// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.dev.js"));
vi.mock("@solidjs/web", () => import("../node_modules/@solidjs/web/dist/web.dev.js"));

type SendCall = { seed: string; text: string; purpose?: string };
type StoreHarness = { __sent: SendCall[]; __failSend: { value: boolean } };

vi.mock("../src/session/store", () => {
  const sent: SendCall[] = [];
  const failSend = { value: false };
  class FakeSessionStore {
    seed: string;
    onSessionsChanged: (() => void) | null = null;
    onConnectionRestored: (() => void) | null = null;
    onSessionTitleChanged: ((title: string) => void) | null = null;
    onSessionDeleted: (() => void) | null = null;
    onHandoffDetected: ((fact: unknown) => void) | null = null;
    todos = [() => [] as never[], () => {}];
    composerToolMode = [{ mode: "standard", customTools: [] }, () => {}];
    constructor(seed: string) { this.seed = seed; }
    async activate(): Promise<void> {}
    deactivate(): void {}
    evictView(): void {}
    dispose(): void {}
    applySessionMeta(): void {}
    /**
     * 真实现见 `session/store.ts:sendMessageWithAttachments` —— 它把
     * `input_purpose:"trigger_turn"` 钉死在命令里。本用例要验的是**fork 流程把哪
     * 份文档投给了哪个会话**，所以这里只记这两样，不重述那条固定字段。
     */
    async sendMessageWithAttachments(text: string, _attachments?: unknown): Promise<void> {
      if (failSend.value) throw new Error("send_failed");
      sent.push({ seed: this.seed, text });
    }
  }
  return { SessionStore: FakeSessionStore, attachmentName: (path: string) => path, __sent: sent, __failSend: failSend };
});

vi.mock("../src/lib/config-events", () => ({
  notifyConfigChanged: vi.fn(),
  onConfigChanged: vi.fn(() => () => {}),
}));

vi.mock("../src/lib/transport", () => ({
  transport: { command: vi.fn(), query: vi.fn(), sessions: vi.fn(async () => []) },
  sessionTarget: (sessionId: string) => ({ kind: "session", session_id: sessionId }),
  workspaceTarget: (workspaceId: string) => ({ kind: "workspace", workspace_id: workspaceId }),
  execSessionTarget: (id: string) => ({ kind: "exec_session", id }),
  desktopHostSurface: () => null,
  isDesktopRuntime: () => true,
}));

const harness = (await import("../src/session/store")) as unknown as StoreHarness;
const { forkHandoffSession, handoffTitle } = await import("../src/tabs/store");
const { forkRecordOfFact } = await import("../src/session/handoff-journal");
const { transport } = await import("../src/lib/transport");

const FACT = {
  key: "ses_A|turn_A",
  fromSessionId: "ses_A",
  turnId: "turn_A",
  workSummary: "把交接链路接通",
  handoffDoc: "## 当前任务\n继续跑 §七 第 1 条",
  handoffPath: "C:\\Users\\QAQTam\\.qaqh\\sessions\\ses_A\\handoff\\handoff-11-10-190233.md",
  modifiedFiles: ["webui/src/session/reducer.ts"],
  contextUsedTokens: 960,
  contextWindowTokens: 1000,
  callId: "call_1",
  inferred: false,
};

/**
 * 每条用例一份自己的交接事实。
 *
 * 账本的同步权威是模块级 Map(去重必须立刻可读,见 handoff-journal 头注释),
 * 清 `localStorage` 清不掉它;用例之间因此必须用不同的 `from|turn`,否则第二条
 * 用例会读到上一条的 fork 记录——那是被测行为,不是测试夹具。
 */
let factSeq = 0;
function freshFact(): typeof FACT {
  factSeq += 1;
  const fromSessionId = `ses_A${factSeq}`;
  const turnId = `turn_A${factSeq}`;
  return { ...FACT, fromSessionId, turnId, key: `${fromSessionId}|${turnId}` };
}

/** A 的 `session.meta`：fork 时四项全从这里抄（都是导出字段）。 */
const META = {
  session_id: "ses_A",
  cwd: "D:/Projects/qaqh-electron",
  model_selection: { kind: "use", value: { provider_id: "p1", model_id: "m1", options: {} } },
  tool_mode: "custom",
  custom_tools: ["read", "edit"],
  title: "旧标题",
};

function mockBackend(childId: string): void {
  vi.mocked(transport.query).mockImplementation(async (method: string) => (method === "session.meta" ? META : []));
  vi.mocked(transport.command).mockImplementation(async (command: { type: string }) =>
    command.type === "session.create" ? { result: { session_id: childId } } : { result: null });
}

const callsOf = (type: string) => vi.mocked(transport.command).mock.calls
  .map(([command]) => command)
  .filter((command) => command.type === type);

beforeEach(() => {
  localStorage.clear();
  harness.__sent.length = 0;
  harness.__failSend.value = false;
  vi.mocked(transport.command).mockReset();
  vi.mocked(transport.query).mockReset();
  mockBackend("ses_CHILD");
});

test("标题直接用 work_summary：新 tab 一出生就可读，不等自动标题（那是死代码）", () => {
  expect(handoffTitle(FACT)).toBe("把交接链路接通");
  expect(handoffTitle({ workSummary: "   ", handoffDoc: "# 第一段\n正文" })).toBe("# 第一段");
});

test("fork 走三条现成命令：create 抄 A 的 meta，文档投成 B 的第一条输入", async () => {
  const fact = freshFact();
  const child = await forkHandoffSession("ses_A", fact);
  expect(child).toBe("ses_CHILD");

  expect(callsOf("session.create")).toHaveLength(1);
  expect(callsOf("session.create")[0]).toMatchObject({
    type: "session.create",
    cwd: META.cwd,
    model_selection: META.model_selection,
    tool_mode: "custom",
    custom_tools: ["read", "edit"],
    title: fact.workSummary,
  });

  // 文档经本仓既有发送路径投给 B（`input_purpose:"trigger_turn"` 钉在
  // `session/store.ts:sendMessageWithAttachments` 里）：交接文档落成 B 的第一条
  // user 角色消息，位置由这条输入天然决定，后端不拼。
  expect(harness.__sent).toEqual([{ seed: "ses_CHILD", text: fact.handoffDoc }]);
  expect(forkRecordOfFact(fact)).toMatchObject({ childSessionId: "ses_CHILD", delivered: true });
});

test("同一 from+turn 只允许 fork 一次：再点只把已有的那条打开", async () => {
  const fact = freshFact();
  await forkHandoffSession("ses_A", fact);
  const again = await forkHandoffSession("ses_A", fact);
  expect(again).toBe("ses_CHILD");
  expect(callsOf("session.create")).toHaveLength(1);
  expect(harness.__sent).toHaveLength(1);
});

test("会话建出来但文档没投出去：重试只补投递，绝不再 create", async () => {
  const fact = freshFact();
  harness.__failSend.value = true;
  const child = await forkHandoffSession("ses_A", fact);
  expect(child).toBe("ses_CHILD");
  expect(forkRecordOfFact(fact)).toMatchObject({ delivered: false });

  harness.__failSend.value = false;
  await expect(forkHandoffSession("ses_A", fact)).resolves.toBe("ses_CHILD");
  expect(callsOf("session.create")).toHaveLength(1);
  expect(forkRecordOfFact(fact)).toMatchObject({ delivered: true });
});

test("接管靠既有 attach 路径：fork 完这条交接的活动会话就是 B", async () => {
  const { activeTab } = await import("../src/tabs/store");
  await forkHandoffSession("ses_A", freshFact());
  expect(activeTab()?.seed).toBe("ses_CHILD");
});
