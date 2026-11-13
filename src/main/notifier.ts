// 桌面通知（Windows toast 为主，Linux libnotify 兼容）。
//
// 接线点唯一：RingingClient 的 EventSender 总线（index.ts 双投进 onEvent）。
// 事件只覆盖活跃 seed 的会话流（Ringing v2 单流契约）；非活跃会话的待交互
// 由 session.list 轮询的 waiting_user 边沿补足。
//
// 授权/回答的回发**没有第二条路**：toast 按钮拿的是 collectPendingApprovals
// 签发的真 challenge id，回调进 submitApprovalDecision——verified/details 闸门、
// 一次性消费、unknown outcome 轮询与渲染层逐字一致。details 不可信
// （verified=false）时按钮直接不出，toast 降级为"点击打开窗口"。
//
// Windows 激活通道（探针实测，2026-11-13，Electron 45 / unpackaged）：
//  * typed 交互面全部可用：button actions、selection 下拉、hasReply 回复框；
//    同 id(=toast Tag) 重放顶卡。
//  * toastXml 只活视觉元素（<progress> 等）——<input>/<action> 被系统剥掉，
//    交互必须走 typed API。
//  * Notification.handleActivation 的 arguments 是 querystring，button/selection/
//    reply/click 全带 `tag=`；对象在内存时**实例事件与 handleActivation 双发**，
//    所以 win32 交互卡只挂 activation 单通道，且 tag 一次性消费（首发生效）。
//  * 进程死后的激活在下次 handleActivation 注册时回放——tag 表已清空则忽略
//    （challenge 本就一次性，重复提交由管线拒绝）。
import { app, Notification } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectPendingApprovals, submitApprovalDecision } from "./ipc-handlers.js";
import type { ChallengeManager } from "./challenges.js";
import type { RingingClient } from "./ringing-client.js";
import type { ApprovalView } from "./types.js";
import { parseAsk } from "../../webui/src/approval/ask-state";
import { HANDOFF_TOOL, HANDOFF_FATAL_CODES, handoffPayloadFromOutput } from "../../webui/src/session/handoff";

export interface NotifierDeps {
  client: () => RingingClient | null;
  challenges: ChallengeManager;
  showWindow: () => void;
  /** 窗口可见且有焦点：人在面板前，提示类事件不再打扰。 */
  windowEngaged: () => boolean;
  /** 向 renderer 广播宿主事件（与 index.ts 的 `qaqh:event:` 通道同一命名）。 */
  sendToRenderer: (eventName: string, payload: unknown) => void;
}

export interface Notifier {
  onEvent(eventName: string, payload: any): void;
  start(): void;
  stop(): void;
}

const POLL_INTERVAL_MS = 20_000;
const EXEC_NOTIFY_MIN_MS = 30_000;
const ANSWER_SNIPPET_MAX = 160;
const ERROR_TOAST_THROTTLE_MS = 60_000;
const MAX_TOAST_ACTIONS = 3;
/** 封箱阅读窗长度(纯展示):与内核 FORK_DELAY_MS / renderer AUTO_CONTINUE_MS 同值,到点只收卡。 */
const SEAL_WINDOW_MS = 10_000;

const isWin = process.platform === "win32";

function snippet(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

/** 封箱 hero 动画素材（scripts/make-notify-assets.mjs 烘的 GIF）：
 *  打包=extraResources 落 <resources>/notify;dev=harness 用 .tmp/resources/notify、
 *  壳走 dist/main 两级向上的仓库根 resources/notify（对齐 native-client 的推导先例）。 */
function heroGifUrl(): string {
  const file = app.isPackaged
    ? join(process.resourcesPath, "notify", "countdown-10s.gif")
    : join(__dirname, "..", "..", "resources", "notify", "countdown-10s.gif");
  return pathToFileURL(file).href;
}

interface ActivationEntry {
  onButton?: (index: number, userInputs: Record<string, string>) => void;
  onReply?: (text: string, userInputs: Record<string, string>) => void;
  onClick?: () => void;
}

interface ToastSpec {
  /** win32 交互卡：注册进 activation 表用的 tag（同 id 重放顶卡）。 */
  tag?: string;
  title: string;
  body?: string;
  buttons?: { text: string; onClick: () => void }[];
  /** win32：typed selection 下拉（与 buttons 二选一，探针确证同卡上限按保守取用）。 */
  selection?: { items: string[]; onPick: (index: number) => void };
  hasReply?: boolean;
  replyPlaceholder?: string;
  onReply?: (text: string) => void;
  onClick?: () => void;
  /** 驻留到主动 close 为止:封箱卡要活过 10s 表把（默认 ~7s 不够）,
   *  倒计时/按钮/到期三条路都会 dismissSeal() 收卡,不会悬挂。 */
  timeoutType?: "never";
  /** win32 纯视觉自定义 XML（hero 动画卡）。传了就接管视觉面——注意与 typed
   *  actions 物理互斥（探针 G3 确证:Electron 见自定义 XML 就不注入按钮）。 */
  toastXml?: string;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const supported = Notification.isSupported();
  if (!supported) console.warn("[notifier] desktop notifications unsupported; module disabled");

  let enabled = true;
  let timer: NodeJS.Timeout | null = null;
  /** seed → 该会话在飞的交互 toast，resolved/bootstrap 时统一 close()。 */
  const liveToasts = new Map<string, Set<Notification>>();
  const waitingSessions = new Set<string>();
  const answerSnippets = new Map<string, string>();
  let lastErrorToastAt = 0;
  let tagSeq = 0;

  /** tag → 一次性激活描述符；任何激活消费后即删（首发生效，杜绝双提交）。 */
  const activationTags = new Map<string, ActivationEntry>();

  function nextTag(): string {
    return `q-n${++tagSeq}`;
  }

  function toast(spec: ToastSpec): Notification {
    const actions = spec.selection
      ? [{ type: "selection" as const, items: spec.selection.items }]
      : spec.buttons?.map((button) => ({ type: "button" as const, text: button.text }));
    // win32：handleActivation 是唯一激活通道（对象可能已被 GC，实例事件不可靠），
    // 所以所有卡都发 tag；非 win32：仅交互卡才需要。
    const tag = isWin ? (spec.tag ?? nextTag()) : spec.tag;
    const notification = new Notification({
      ...(tag != null ? { id: tag } : {}),
      title: spec.title,
      body: spec.body ?? "",
      ...(actions != null ? { actions } : {}),
      hasReply: spec.hasReply ?? false,
      ...(spec.replyPlaceholder != null ? { replyPlaceholder: spec.replyPlaceholder } : {}),
      ...(spec.timeoutType != null ? { timeoutType: spec.timeoutType } : {}),
      ...(spec.toastXml != null ? { toastXml: spec.toastXml } : {}),
    });

    if (isWin && tag != null) {
      activationTags.set(tag, {
        onButton: (index, inputs) => {
          if (spec.selection) {
            // 下拉选中项在 userInputs.selection0（探针确证），空值 = 未选，不得当成第 0 项提交。
            const raw = inputs.selection0;
            if (raw != null && raw !== "") spec.selection.onPick(Number(raw));
            else deps.showWindow();
          }
          else spec.buttons?.[index]?.onClick();
        },
        onReply: spec.onReply != null ? (text) => spec.onReply!(text) : undefined,
        onClick: spec.onClick ?? deps.showWindow,
      });
    } else {
      // Linux/macOS（或 win32 无交互信息卡）：实例事件通道。
      notification.on("click", () => (spec.onClick ?? deps.showWindow)());
      spec.buttons?.forEach((button, index) => {
        notification.on("action", (details) => {
          if (details.actionIndex === index) button.onClick();
        });
      });
      if (spec.onReply) {
        const onReply = spec.onReply;
        notification.on("reply", (_event, reply) => onReply(reply));
      }
    }

    if (supported && enabled) notification.show();
    return notification;
  }

  function trackToast(seed: string, notification: Notification): void {
    let set = liveToasts.get(seed);
    if (!set) { set = new Set(); liveToasts.set(seed, set); }
    set.add(notification);
  }

  function closeSeedToasts(seed: string): void {
    for (const notification of liveToasts.get(seed) ?? []) {
      try { notification.close(); } catch { /* 已消失 */ }
    }
    liveToasts.delete(seed);
  }

  /**
   * 交互按钮的统一回发：拿 challenge id 走主进程审批管线。失败不外抛——
   * toast 场景下把用户带回窗口里处理（渲染层有完整的重试/降级 UI）。
   */
  function respond(seed: string, challengeId: string, decision: string, payload: unknown = {}): void {
    const client = deps.client();
    if (!client) return;
    submitApprovalDecision(client, deps.challenges, seed, challengeId, decision, payload).catch((error) => {
      console.warn(`[notifier] respond ${decision} failed for ${seed}:`, error);
      deps.showWindow();
    });
  }

  /**
   * ask 单题卡（win32 形态）：typed selection 下拉装预置选项 + hasReply 自由文本。
   * 提交答案取用：回复文本非空优先（探针确证 action 激活也会捎回当前输入态），
   * 否则取选项原文。非 win32 维持按钮 ≤3 形态。
   */
  function buildAskToast(seed: string, view: ApprovalView, title: string): void {
    const model = parseAsk(view.details as Record<string, unknown>);
    const interactive = view.verified && !view.details_unavailable;
    const single = model.questions.length === 1 ? model.questions[0]! : null;
    const submit = (answer: string) => respond(seed, view.challenge_id, "submit", {
      answers: [{ question_id: single!.id, answer }],
    });

    if (!interactive || !single) {
      const body = single
        ? snippet(single.question, ANSWER_SNIPPET_MAX)
        : `${snippet(model.questions[0]?.question ?? "需要回答", 80)}…（共 ${model.questions.length} 题，请在窗口内作答）`;
      toast({ title: `回答 · ${title}`, body });
      return;
    }

    if (single.options.length === 0) {
      toast({
        title: `回答 · ${title}`,
        body: snippet(single.question, ANSWER_SNIPPET_MAX),
        hasReply: true,
        replyPlaceholder: "输入回答后发送",
        onReply: (reply) => submit(reply),
      });
      return;
    }

    if (isWin) {
      toast({
        title: `回答 · ${title}`,
        body: snippet(single.question, ANSWER_SNIPPET_MAX),
        selection: {
          items: single.options,
          onPick: (index) => submit(single.options[index] ?? ""),
        },
        ...(single.allowCustom
          ? { hasReply: true, replyPlaceholder: "或直接打字回复", onReply: (reply: string) => submit(reply) }
          : {}),
      });
      return;
    }

    // Linux：libnotify 动作按钮，选项 ≤ 上限；超出靠开窗作答。
    const buttons = single.options.slice(0, MAX_TOAST_ACTIONS).map((option) => ({
      text: snippet(option, 40),
      onClick: () => submit(option),
    }));
    toast({ title: `回答 · ${title}`, body: snippet(single.question, ANSWER_SNIPPET_MAX), buttons });
  }

  function buildPermissionToast(seed: string, view: ApprovalView, title: string): void {
    const d = view.details as Record<string, unknown>;
    const tool = snippet(d.tool_name ?? "工具", 40);
    const summary = snippet(d.action_summary ?? d.reason ?? "", 120);
    const interactive = view.verified && !view.details_unavailable;
    const buttons: { text: string; onClick: () => void }[] = [];
    if (interactive) {
      // 「信任目录」不进 toast：它是带副作用的宽授权，留在窗口里点（决策 A）。
      buttons.push({ text: "拒绝", onClick: () => respond(seed, view.challenge_id, "reject") });
      buttons.push({ text: "允许", onClick: () => respond(seed, view.challenge_id, "approve") });
    }
    toast({
      title: `需要授权 · ${title}`,
      body: summary ? `${tool}：${summary}` : tool,
      buttons,
    });
  }

  /** interaction_requested 的唯一入口：重读审批管线拿带 challenge 的权威视图。 */
  async function notifyInteractions(seed: string): Promise<void> {
    const client = deps.client();
    if (!client || !supported || !enabled) return;
    let views: ApprovalView[];
    try {
      views = await collectPendingApprovals(client, deps.challenges, seed);
    } catch {
      return; // collectPendingApprovals 已广播 conn://error，这里不重复出 toast。
    }
    const title = sessionTitle(seed);
    for (const view of views) {
      if (view.kind === "tool_permission") buildPermissionToast(seed, view, title);
      else buildAskToast(seed, view, title);
    }
  }

  // ---- 会话标题缓存（session.list 轮询刷新）----
  const titles = new Map<string, string>();
  function sessionTitle(seed: string): string {
    return titles.get(seed) ?? seed.slice(0, 8);
  }

  // ---- 交接封箱（handoff 工具调用的事件流判据）----
  /** call_id → 声明时的回合 id；tool_finished 命中即消费（声明却没终态就自然搁置）。 */
  const handoffCalls = new Map<string, string>();
  /** 已封箱 key（`from_session_id|turn_id`）：同一条交接只提示、只表把一次。 */
  const sealedKeys = new Set<string>();
  /** key → 收卡表把(纯展示)。按钮只送两个纯前端标记,主进程绝不自己 fork(ADR-016)。 */
  const sealTimers = new Map<string, NodeJS.Timeout>();
  /** key → 封箱在飞卡（win32 是 hero 动画卡+按钮卡两张;其余平台仅按钮卡）。 */
  const sealCards = new Map<string, Notification[]>();

  /** 撤表并收卡：continue / cancel / auto 三条落点的共同动作。 */
  function dismissSeal(key: string): void {
    const timer = sealTimers.get(key);
    if (timer != null) clearTimeout(timer);
    sealTimers.delete(key);
    for (const card of sealCards.get(key) ?? []) {
      try { card.close(); } catch { /* 已消失 */ }
    }
    sealCards.delete(key);
  }

  /**
   * 封箱成立:hero 动画卡 + [立即继续][取消自动] 按钮卡。ADR-016 后主进程表把
   * 退役为**纯展示**——fork(建 B、投文档、开回合)由内核在 T+10s 一体完成,
   * 到点这里只收卡,不再向 renderer 发 auto。按钮语义是两个纯前端标记:
   * [立即继续]=eager、[取消自动]=「不拽我」,renderer 的 HandoffCard 消费。
   * 动画与按钮分卡是平台墙:自定义 toastXml 与 typed actions 物理互斥(探针 G3)。
   * 两卡都上 long 时长(~25s)——默认 ~7s 活不过 10s 阅读窗。
   * 窗口 engaged 时不发 toast(人在面板前,卡内倒计时即投影)。
   */
  function onSealed(seed: string, key: string, workSummary: string): void {
    if (sealedKeys.has(key)) return;
    sealedKeys.add(key);
    const title = sessionTitle(seed);
    const summary = `简述：${snippet(workSummary, 120)}`;
    if (!deps.windowEngaged()) {
      const cards: Notification[] = [];
      if (isWin) {
        cards.push(toast({
          title: `已封箱交接 · ${title}`,
          toastXml: `<toast duration="long"><visual><binding template="ToastGeneric">`
            + `<text>${xmlEscape(`已封箱交接 · ${title}`)}</text>`
            + `<text>${xmlEscape(summary)}</text>`
            + `<image src="${xmlEscape(heroGifUrl())}" placement="hero"/>`
            + `</binding></visual></toast>`,
        }));
      }
      cards.push(toast({
        title: `已封箱交接 · ${title}`,
        body: `${summary}；10s 后由内核自动继续交接，可点「取消自动」`,
        timeoutType: "never",
        buttons: [
          { text: "立即继续", onClick: () => { dismissSeal(key); deps.sendToRenderer("notify://handoff", { action: "continue", key }); } },
          { text: "取消自动", onClick: () => { dismissSeal(key); deps.sendToRenderer("notify://handoff", { action: "cancel", key }); } },
        ],
      }));
      sealCards.set(key, cards);
    }
    // 纯展示:GIF 长 11s(10..0 帧),阅读窗过后留 1s 宽限让动画播完再收卡。
    sealTimers.set(key, setTimeout(() => dismissSeal(key), SEAL_WINDOW_MS + 1_000));
  }

  /**
   * handoff 调用的 tool_finished：
   *  - fatal 码（handoff_missing / context_overflow）→「需要人看一眼」卡,无按钮；
   *    invalid_args / write_failed 回合继续、模型可重试,不打扰。
   *  - 其余终态 → 取机器面正文判 `handed_off === true`。ref 正文走 readContentText；
   *    读不出来就整条不成立——推断封箱是 renderer 事实层的职责,主进程只认硬判据。
   */
  async function handleHandoffFinished(seed: string, declaredTurnId: string, event: Record<string, unknown>): Promise<void> {
    const outcome = event.outcome as { kind: string; error?: { code?: string } | null } | undefined;
    if (outcome?.kind === "failed") {
      const code = outcome.error?.code ?? "";
      if (!(HANDOFF_FATAL_CODES as readonly string[]).includes(code)) return;
      if (deps.windowEngaged()) return;
      toast({
        title: `交接失败 · ${sessionTitle(seed)}`,
        body: snippet(`${code}：这类失败要人看一眼——模型没写交接文档就终止了,不会自动重试。`, ANSWER_SNIPPET_MAX),
      });
      return;
    }
    const output = event.output as { kind: string; data?: { text?: string; content_ref?: string } } | null | undefined;
    let text: string | null = null;
    if (output?.kind === "inline") text = output.data?.text ?? null;
    else if (output?.kind === "ref" && output.data?.content_ref != null) {
      const client = deps.client();
      if (client == null) return;
      try { text = await client.readContentText(output.data.content_ref); } catch { return; }
    } else return; // unavailable / 无正文：没有机器面就没有封箱。
    const payload = handoffPayloadFromOutput(text);
    if (payload?.handed_off !== true) return;
    const fromSessionId = typeof payload.from_session_id === "string" && payload.from_session_id !== "" ? payload.from_session_id : seed;
    const turnId = typeof payload.turn_id === "string" && payload.turn_id !== "" ? payload.turn_id : declaredTurnId;
    onSealed(seed, `${fromSessionId}|${turnId}`, typeof payload.work_summary === "string" ? payload.work_summary : "");
  }

  function dispatchEvent(seed: string, event: Record<string, unknown>): void {
    switch (event.type) {
      case "interaction_requested":
        void notifyInteractions(seed);
        break;
      case "interaction_resolved":
        // 先撤本会话全部交互 toast，再重读管线：若还挂着另一张未决卡
        // （ask 与 permission 可并存），它会被重新 toast 出来。
        closeSeedToasts(seed);
        void notifyInteractions(seed);
        break;
      case "tool_declared":
        if (event.tool_name === HANDOFF_TOOL && event.call_id != null) {
          handoffCalls.set(String(event.call_id), String(event.turn_id ?? ""));
        }
        break;
      case "tool_finished": {
        const declaredTurnId = event.call_id != null ? handoffCalls.get(String(event.call_id)) : undefined;
        if (declaredTurnId == null) break;
        handoffCalls.delete(String(event.call_id));
        void handleHandoffFinished(seed, declaredTurnId, event);
        break;
      }
      case "message_delta": {
        if (event.block_kind !== "answer") break;
        const turnId = String(event.turn_id ?? "");
        const next = ((answerSnippets.get(turnId) ?? "") + String(event.text ?? "")).slice(-ANSWER_SNIPPET_MAX);
        answerSnippets.set(turnId, next);
        break;
      }
      case "turn_ended": {
        const turnId = String(event.turn_id ?? "");
        const answer = answerSnippets.get(turnId);
        answerSnippets.delete(turnId);
        if (deps.windowEngaged()) break;
        const outcome = event.outcome as { kind: string; data?: { error?: { message?: string } | null } };
        if (outcome.kind === "interrupted") break;
        const error = outcome.data?.error;
        toast({
          title: error ? `回合失败 · ${sessionTitle(seed)}` : `回合完成 · ${sessionTitle(seed)}`,
          body: snippet(error?.message ?? answer ?? "", ANSWER_SNIPPET_MAX),
        });
        break;
      }
      case "subagent_updated": {
        const subagent = event.subagent as { status?: string | null; role?: string | null; child_session_id?: string };
        if (subagent.status == null) break; // 非终态（进行中更新）不出 toast。
        if (deps.windowEngaged()) break;
        toast({
          title: `子代理 ${subagent.status} · ${sessionTitle(seed)}`,
          body: snippet(subagent.role ?? subagent.child_session_id ?? "", 80),
        });
        break;
      }
      case "exec_session_finished": {
        const view = event.session as { command?: string; started_at_ms?: number; finished_at_ms?: number | null };
        const durationMs = (view.finished_at_ms ?? 0) - (view.started_at_ms ?? 0);
        if (durationMs < EXEC_NOTIFY_MIN_MS) break;
        if (deps.windowEngaged()) break;
        toast({
          title: `长命令完成 · ${sessionTitle(seed)}`,
          body: `${snippet(view.command ?? "", 100)}（${Math.round(durationMs / 1000)}s）`,
        });
        break;
      }
      default:
        break;
    }
  }

  async function pollTick(): Promise<void> {
    const client = deps.client();
    if (!client || !supported) return;
    try {
      const config = await client.serviceCall("config.load", {});
      enabled = config.notificationsEnabled !== false;
      if (!enabled) return;
      const list = await client.serviceCall("session.list", {});
      titles.clear();
      for (const entry of list) titles.set(entry.session_id, entry.title ?? entry.session_id.slice(0, 8));
      const activeSeed = client.getActiveSeed();
      const waitingNow = new Set<string>();
      for (const entry of list) {
        if (entry.archived || entry.ephemeral) continue;
        if (entry.session_id === activeSeed) continue; // 活跃会话走事件流。
        if (entry.status !== "waiting_user") continue;
        waitingNow.add(entry.session_id);
        if (!waitingSessions.has(entry.session_id) && !deps.windowEngaged()) {
          toast({
            title: `等待交互 · ${sessionTitle(entry.session_id)}`,
            body: "该会话有待处理的授权或提问；打开面板即可看到卡片（切换会话在窗口内操作）",
          });
        }
      }
      for (const seed of waitingSessions) {
        if (!waitingNow.has(seed)) closeSeedToasts(seed);
      }
      waitingSessions.clear();
      for (const seed of waitingNow) waitingSessions.add(seed);
    } catch (error) {
      console.warn("[notifier] poll tick failed:", error);
    }
  }

  let activationRegistered = false;

  return {
    onEvent(eventName: string, payload: any): void {
      if (!supported || !enabled) return;
      if (eventName === "projection://event") {
        dispatchEvent(String(payload.session_id), payload.event as Record<string, unknown>);
      } else if (eventName === "projection://bootstrap") {
        // 重基线：bootstrap 之后 pending 卡片由渲染层全量重建，旧 toast 撤回。
        closeSeedToasts(String(payload.session_id));
      } else if (eventName === "conn://error") {
        const now = Date.now();
        if (now - lastErrorToastAt < ERROR_TOAST_THROTTLE_MS) return;
        lastErrorToastAt = now;
        toast({ title: "连接异常", body: snippet(payload.message, ANSWER_SNIPPET_MAX) });
      }
    },
    start(): void {
      if (!supported || timer != null) return;
      if (isWin && !activationRegistered) {
        activationRegistered = true;
        Notification.handleActivation((details) => {
          const tag = new URLSearchParams(details.arguments ?? "").get("tag");
          if (tag == null) return;
          const entry = activationTags.get(tag);
          if (entry == null) return; // 迟到的回放/重复激活：一次性消费后无描述符，静默忽略。
          const inputs = details.userInputs ?? {};
          if (details.type === "action") {
            activationTags.delete(tag);
            entry.onButton?.(details.actionIndex ?? 0, inputs);
          } else if (details.type === "reply") {
            activationTags.delete(tag);
            entry.onReply?.(details.reply ?? String(inputs.reply ?? ""), inputs);
          } else {
            entry.onClick?.();
            // 纯信息卡的 click 即终点；交互卡 click 只是去窗口，保留提交能力。
            if (entry.onButton == null && entry.onReply == null) activationTags.delete(tag);
          }
        });
      }
      timer = setInterval(() => void pollTick(), POLL_INTERVAL_MS);
      void pollTick();
    },
    stop(): void {
      if (timer != null) clearInterval(timer);
      timer = null;
      for (const seed of [...liveToasts.keys()]) closeSeedToasts(seed);
      activationTags.clear();
      for (const key of [...sealTimers.keys(), ...sealCards.keys()]) dismissSeal(key);
      sealedKeys.clear();
      handoffCalls.clear();
    },
  };
}
