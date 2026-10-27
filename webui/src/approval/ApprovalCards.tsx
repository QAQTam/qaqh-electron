/**
 * 授权窗口与 AskUser(spec §11):居中阻塞对话框,保留会话消息作为背景上下文。
 * 不折叠、不截断;长内容在卡片正文内滚动,操作栏始终属于卡片本身;
 * 待处理状态完全由后端 approvals RPC 重建(重连/切标签后仍在)。
 *
 * [契约缺口 A-1] spec §11.2 要求按钮只渲染后端 choices[];网关 challenge
 * details 目前不携带 choices,合法决策集由网关 command_for 固定
 * (approve/reject/trust;submit/dismiss;approve/reject),此处与之对齐。
 * 后端补 choices 后按列表渲染即可。
 *
 * [契约缺口 A-2] ask 的 challenge 一次性消费,重签发就换 challenge_id,view 里没有
 * 稳定的 interaction id —— 草稿只能按"问题集合签名"归位(见 ask-state.signature)。
 */
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { ApprovalView } from "../lib/transport";
import { STR } from "../lib/strings";
import { toast } from "../ui/toast";
import {
  buildAnswers,
  countdownTone,
  formatCountdown,
  isAnswered,
  optionRows,
  parseAsk,
  remainingSec,
  type AskDraft,
  type AskModel,
  type AskQuestion,
  type AskRow,
  type AskSelection,
} from "./ask-state";

function isHighRisk(view: ApprovalView): boolean {
  return String(view.details?.risk ?? "").toLowerCase() === "high";
}

/**
 * 提交状态单一来源:模态栈与 ask 内嵌卡共用同一套 busy/error 语义。
 *
 * 错误必须按 challenge 归位:宿主 `respond_approval` 先 `consume` 再映射命令,
 * 所以任何一次失败都意味着这张卡的 challenge 已经没了,store 随即重签发新 id。
 * 挂在栈上的旧错误若跟着渲染,就会出现在一张全新的、其实能提交的卡上
 * (截图里「表单空着 + approval_not_found」即此)。
 * 卡换 id 就再也读不到旧错误,原因改由 toast 告知——它活得过重挂载。
 */
function useApprovalSend(respond: (challengeId: string, decision: string, payload?: Record<string, unknown>) => Promise<void>) {
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const send = async (view: ApprovalView, decision: string, payload: Record<string, unknown> = {}): Promise<void> => {
    setBusyId(view.challenge_id);
    setErrors((previous) => {
      if (previous[view.challenge_id] == null) return previous;
      const next = { ...previous };
      delete next[view.challenge_id];
      return next;
    });
    try {
      await respond(view.challenge_id, decision, payload);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setErrors((previous) => ({ ...previous, [view.challenge_id]: message }));
      toast(STR.approvalRespondFailed(message), "err", { dedupeKey: "approval-respond" });
    } finally {
      setBusyId(null);
    }
  };
  return { busy: (id: string) => busyId() === id, errorFor: (id: string) => errors()[id] ?? null, send };
}

/** 卡片键盘:焦点在卡片内 Enter=主操作、Esc=拒绝;high risk 禁用 Enter。 */
function useCardKeys(highRisk: () => boolean, onPrimary: () => void, onReject: () => void, rootRef: () => HTMLElement | undefined): void {
  createEffect(
    rootRef,
    (root) => {
      if (root == null) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Enter" && !event.isComposing) {
          if (highRisk()) return;
          event.preventDefault();
          onPrimary();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onReject();
        }
      };
      root.addEventListener("keydown", onKey);
      return () => root.removeEventListener("keydown", onKey);
    },
  );
}

export const ApprovalCard: Component<{ view: ApprovalView; pendingCount: number; busy: () => boolean; error: () => string | null; respond: (decision: string) => void }> = (props) => {
  let root: HTMLDivElement | undefined;
  const details = () => props.view.details ?? {};
  useCardKeys(() => isHighRisk(props.view), () => props.respond("approve"), () => props.respond("reject"), () => root);
  return (
    <div class={{ card: true, perm: true, high: isHighRisk(props.view) }} tabindex={-1} ref={root}>
      <div class="card-head">
        <span id="approval-dialog-title">{STR.approvalTitle}</span>
        <Show when={isHighRisk(props.view)}>
          <b class="card-risk">{STR.highRisk}</b>
        </Show>
        <Show when={props.pendingCount > 1}>
          <span class="card-more">{STR.morePending(props.pendingCount - 1)}</span>
        </Show>
      </div>
      <div class="card-body">
        <div class="card-tool"><b>{details().tool_name ?? "unknown"}</b><Show when={details().action_summary}>{` · ${details().action_summary}`}</Show></div>
        <Show when={details().reason}>
          <div class="card-line"><span class="card-key">{STR.reason}</span>{details().reason}</div>
        </Show>
        <Show when={Array.isArray(details().paths) && details().paths.length > 0}>
          <pre class="card-paths">{(details().paths as string[]).join("\n")}</pre>
        </Show>
        <div class="card-line">
          <span class="card-key">{STR.riskLabel}</span>
          {`${details().risk ?? "?"} · ${details().level_name || `level ${details().level ?? "?"}`} · ${details().category ?? "?"}`}
        </div>
        <Show when={details().consequence}>
          <div class="card-line"><span class="card-key">{STR.consequence}</span>{details().consequence}</div>
        </Show>
        <Show when={props.error() != null}><p class="card-error" role="alert">{props.error()}</p></Show>
      </div>
      <div class="card-actions" aria-busy={props.busy() ? "true" : "false"}>
        <button type="button" class="primary button-primary" disabled={props.busy()} onClick={() => props.respond("approve")}>{STR.allowOnce}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={() => props.respond("reject")}>{STR.reject}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={() => props.respond("trust")}>{STR.allowTrust}</button>
      </div>
    </div>
  );
};

/**
 * AskUser:一次一问 + 问题轨。
 *
 * 真实负载是 2–3 问、选项 p50=22 字 / 问题 p90=92 字的长句,旧版把整批摊成一列滚动,
 * 每问还挂一个常显的自定义框(实测 20/20 个 ask 都允许自定义)——三问就是三张空框。
 * 现在:轨给全景(轨是导航,可截断;问题正文在卡身永远完整),卡身只呈现当前一问,
 * 「其它」降级成一条与选项互斥的行,答案因此只有一个落点,不再出现"文本框悄悄覆盖 radio"。
 */
export const AskCard: Component<{
  view: ApprovalView;
  model: AskModel;
  pendingCount: number;
  busy: () => boolean;
  draft: () => AskDraft;
  onDraft: (next: AskDraft) => void;
  respond: (payload: Record<string, unknown>) => void;
  skip: () => void;
  refresh: () => void;
}> = (props) => {
  let root: HTMLDivElement | undefined;
  const [index, setIndex] = createSignal(0);
  const [validationError, setValidationError] = createSignal(false);
  const questions = () => props.model.questions;

  // TTL 从这一刻起算:卡片是 keyed 的,一次挂载对应一个 challenge。
  // expires_in 缺失(旧宿主/预览夹具)就当没有 TTL,不拿 0 把卡判死。
  const hasTtl = () => props.view.expires_in > 0;
  const expiresAtMs = Date.now() + Math.max(0, props.view.expires_in) * 1000;
  const [now, setNow] = createSignal(Date.now());
  createEffect(hasTtl, (live) => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  });
  const remaining = () => remainingSec(expiresAtMs, now());
  // 到点即失效:此时服务端 challenge 已被 TTL 清掉,再提交只会换回一个 not_found。
  const expired = () => hasTtl() && remaining() <= 0;

  const current = createMemo(() => questions()[Math.min(index(), questions().length - 1)] ?? null);
  // 行对象必须稳定:<For each={optionRows(q)}> 每次新建数组会让「其它」的输入框在
  // 每次按键后被重建,光标与焦点全丢。
  const list = createMemo(() => {
    const question = current();
    return question == null ? [] : optionRows(question);
  });

  const selectionOf = (question: AskQuestion): AskSelection | undefined => props.draft()[question.id];
  const customValue = (question: AskQuestion): string => {
    const selection = selectionOf(question);
    return selection?.kind === "custom" ? selection.value : "";
  };
  const isPicked = (question: AskQuestion, row: AskRow): boolean => {
    const selection = selectionOf(question);
    if (selection == null) return false;
    return selection.kind === "option"
      ? row.kind === "option" && selection.value === row.value
      : row.kind === "custom";
  };
  const pick = (question: AskQuestion, row: AskRow): void => {
    props.onDraft({
      ...props.draft(),
      [question.id]: row.kind === "option"
        ? { kind: "option", value: row.value }
        : { kind: "custom", value: customValue(question) },
    });
    setValidationError(false);
    // 选中「其它」就把光标送进输入框;等 Show 挂上节点再找它,不留 ref 指向已卸载的框。
    if (row.kind === "custom") queueMicrotask(() => root?.querySelector<HTMLInputElement>("input[data-custom]")?.focus());
  };
  /** 无选项的问题直接摊开输入框,不必先点一下「其它」。 */
  const customOpen = (question: AskQuestion, row: AskRow): boolean =>
    row.kind === "custom" && (isPicked(question, row) || question.options.length === 0);

  const atLast = () => index() >= questions().length - 1;
  const submit = (): void => {
    const { answers, missing } = buildAnswers(questions(), props.draft());
    if (missing.length > 0) {
      setValidationError(true);
      const target = questions().findIndex((question) => question.id === missing[0]);
      if (target >= 0) setIndex(target);
      root?.focus();
      return;
    }
    setValidationError(false);
    props.respond({ answers });
  };
  const advance = (): void => {
    if (atLast()) submit();
    else setIndex(index() + 1);
  };
  /** 上下键只在焦点位于卡根时接管;焦点已在 radio 上就交给原生方向键。 */
  const moveWithinQuestion = (delta: number): void => {
    const question = current();
    if (question == null) return;
    const options = list();
    const picked = options.findIndex((row) => isPicked(question, row));
    const next = options[Math.min(options.length - 1, Math.max(0, (picked < 0 ? 0 : picked) + delta))];
    if (next != null) pick(question, next);
  };

  // 换问会整块重挂载卡身(Show keyed),焦点掉回 body;不接回来,数字键与方向键
  // 就找不到监听的宿主了——只在没人持有焦点时补,不抢用户正在输入的框。
  createEffect(current, () => {
    queueMicrotask(() => {
      if (document.activeElement === document.body) root?.focus();
    });
  });

  // 声明式挂到卡根:`createEffect(() => root, …)` 的 source 在组件 setup 期就求值,
  // 那时 ref 还没赋值,监听器永远挂不上(旧授权卡的 Enter/Esc 就是这么静默失效的)。
  const onKey = (event: KeyboardEvent): void => {
    // 中文输入法在拼写中:按键属于候选窗,卡一律不抢。
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!expired()) props.skip();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!expired()) advance();
      return;
    }
    if (expired() || event.target instanceof HTMLInputElement) return;
    if (/^[1-9]$/.test(event.key)) {
      const question = current();
      const row = list()[Number(event.key) - 1];
      if (question != null && row != null) {
        event.preventDefault();
        pick(question, row);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveWithinQuestion(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <div class="card ask" data-state={expired() ? "expired" : "live"} tabindex={-1} ref={root} onKeyDown={onKey}>
      <div class="card-head">
        <span id="approval-dialog-title">{STR.askTitle}</span>
        <Show when={questions().length > 1}>
          <span class="ask-step">{STR.askStepOf(index() + 1, questions().length)}</span>
        </Show>
        <Show when={hasTtl()}>
          <span class="ask-timer" data-tone={countdownTone(remaining())} title={STR.askTimeLeft(formatCountdown(remaining()))} aria-hidden="true">
            {formatCountdown(remaining())}
          </span>
        </Show>
        <Show when={props.pendingCount > 1}>
          <span class="card-more">{STR.morePending(props.pendingCount - 1)}</span>
        </Show>
      </div>
      <Show when={questions().length > 1}>
        <nav class="ask-rail" aria-label={STR.askTitle}>
          <For each={questions()}>
            {(question, position) => {
              const answered = () => isAnswered(selectionOf(question));
              return (
                <button
                  type="button"
                  class="ask-rail-row"
                  data-state={answered() ? "done" : "todo"}
                  aria-current={position() === index() ? "step" : undefined}
                  title={question.question}
                  onClick={() => setIndex(position())}
                >
                  <span class="ask-rail-n" aria-hidden="true">{answered() ? "✓" : position() + 1}</span>
                  <span class="ask-rail-q">{question.question}</span>
                  <span class="sr-only">{answered() ? STR.askAnswered : STR.askUnanswered}</span>
                </button>
              );
            }}
          </For>
        </nav>
      </Show>
      <div class="card-body">
        <Show when={questions().length === 0}>
          <div class="card-line">(缺少问题详情)</div>
        </Show>
        <Show when={current()} keyed>
          {(question) => (
            <div class="ask-q">
              <div class="card-q-text">{question.question}</div>
              <div class="ask-opts" role="radiogroup" aria-label={question.question}>
                <For each={list()}>
                  {(row, position) => (
                    <div class="ask-opt-row">
                      <label class="ask-opt" data-picked={isPicked(question, row) ? "true" : undefined}>
                        <input
                          type="radio"
                          name={`ask-${props.view.challenge_id}-${question.id}`}
                          value={row.kind === "option" ? row.value : STR.askOther}
                          checked={isPicked(question, row)}
                          disabled={expired()}
                          onInput={() => pick(question, row)}
                        />
                        <span class="ask-opt-n" aria-hidden="true">{position() + 1}</span>
                        <span class="ask-opt-text">{row.kind === "option" ? row.value : STR.askOther}</span>
                      </label>
                      <Show when={customOpen(question, row)}>
                        <input
                          class="ask-custom"
                          type="text"
                          data-custom
                          placeholder={STR.customAnswer}
                          value={customValue(question)}
                          disabled={expired()}
                          onInput={(event) => {
                            props.onDraft({ ...props.draft(), [question.id]: { kind: "custom", value: event.currentTarget.value } });
                            setValidationError(false);
                          }}
                        />
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
        <Show when={validationError()}>
          <p class="card-error" role="alert">{STR.askAnswerRequired}</p>
        </Show>
      </div>
      <div class="card-actions" aria-busy={props.busy() ? "true" : "false"}>
        <Show
          when={!expired()}
          fallback={
            <>
              <p class="card-line ask-expired-line" role="status">
                <b class="card-key">{STR.askExpired}</b>
                {STR.askExpiredHint}
              </p>
              <button type="button" class="primary button-primary" onClick={props.refresh}>{STR.askRefresh}</button>
            </>
          }
        >
          <button type="button" class="button-secondary" disabled={props.busy()} onClick={props.skip}>{STR.skip}</button>
          <Show when={index() > 0}>
            <button type="button" class="button-secondary" onClick={() => setIndex(index() - 1)}>{STR.askPrev}</button>
          </Show>
          <span class="ask-gap" aria-hidden="true" />
          <button type="button" class="primary button-primary" disabled={props.busy()} onClick={advance}>
            {atLast() ? STR.submit : STR.askNext}
          </button>
        </Show>
      </div>
    </div>
  );
};

export const PlanCard: Component<{ view: ApprovalView; pendingCount: number; busy: () => boolean; error: () => string | null; respond: (approved: boolean, message: string, autonomous: boolean) => void }> = (props) => {
  let root: HTMLDivElement | undefined;
  const [message, setMessage] = createSignal("");
  const [autonomous, setAutonomous] = createSignal(false);
  useCardKeys(() => false, () => props.respond(true, message(), autonomous()), () => props.respond(false, message(), autonomous()), () => root);
  return (
    <div class="card plan" tabindex={-1} ref={root}>
      <div class="card-head"><span id="approval-dialog-title">{STR.planTitle}</span><Show when={props.pendingCount > 1}><span class="card-more">{STR.morePending(props.pendingCount - 1)}</span></Show></div>
      <div class="card-body">
        <pre class="card-plan">{props.view.details?.plan_content ?? "(缺少计划内容)"}</pre>
        <input class="card-message" type="text" placeholder={STR.planPlaceholder} value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
        <label class="card-opt">
          <input type="checkbox" checked={autonomous()} onInput={(e) => setAutonomous(e.currentTarget.checked)} />
          <span>{STR.autonomous}</span>
        </label>
        <Show when={props.error() != null}><p class="card-error" role="alert">{props.error()}</p></Show>
      </div>
      <div class="card-actions" aria-busy={props.busy() ? "true" : "false"}>
        <button type="button" class="primary button-primary" disabled={props.busy()} onClick={() => props.respond(true, message(), autonomous())}>{STR.allowOnce}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={() => props.respond(false, message(), autonomous())}>{STR.reject}</button>
      </div>
    </div>
  );
};

/** 卡片组:只展示最早一个,头部显示「还有 N 个待处理」;滚动滚入视野。
 *  授权/计划评审/AskUser 共用同一个居中模态(`#approval-slot`)。 */
export const ApprovalStack: Component<{
  pending: ApprovalView[];
  respond: (challengeId: string, decision: string, payload?: Record<string, unknown>) => Promise<void>;
  /** 卡失效后重取待处理列表:仍挂着的交互会换一个新 challenge 重新签发。 */
  refresh: () => Promise<void>;
}> = (props) => {
  const { busy, errorFor, send } = useApprovalSend(props.respond);
  let root: HTMLDivElement | undefined;
  const head = createMemo(() => props.pending[0] ?? null);
  const askModel = createMemo(() => (head()?.kind === "ask" ? parseAsk(head()?.details) : null));
  // 草稿挂在栈上、按问题签名存续:challenge 一次性,重签发会换 id 并整卡重挂载,
  // 但同一批问题的答案不该跟着蒸发。签名变了(换了一批问题)才清空。
  const [askDraft, setAskDraft] = createSignal<AskDraft>({});
  createEffect(
    () => askModel()?.signature ?? "",
    (signature, previous) => {
      if (signature !== previous) setAskDraft({});
    },
  );
  createEffect(
    () => props.pending.length,
    (count) => {
      // 焦点在 body 时才自动聚焦卡片(§11.1),不抢输入框。
      if (count > 0 && document.activeElement === document.body) {
        root?.querySelector<HTMLElement>(".card")?.focus();
      }
    },
  );
  const trapTab = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLElement;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first == null || last == null) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };
  // 模态栈为空时不挂 #approval-slot 容器本身:fixed inset:0 的空遮罩会拦截全页面点击。
  return (
    <Show when={head()} keyed>
      {(view) => (
        <div id="approval-slot" ref={root}>
          {/* keyed:换一个 challenge 就是一张新卡(内部草稿/展开态不该串到下一个请求) */}
          <div class="approval-wrap" role="dialog" aria-modal="true" aria-labelledby="approval-dialog-title" tabindex={-1} onKeyDown={trapTab}>
            {view.kind === "tool_permission" ? (
              <ApprovalCard view={view} pendingCount={props.pending.length} busy={() => busy(view.challenge_id)} error={() => errorFor(view.challenge_id)} respond={(decision) => void send(view, decision)} />
            ) : view.kind === "plan" ? (
              <PlanCard view={view} pendingCount={props.pending.length} busy={() => busy(view.challenge_id)} error={() => errorFor(view.challenge_id)} respond={(approved, message, autonomous) => void send(view, approved ? "approve" : "reject", { message: message || null, autonomous })} />
            ) : (
              <AskCard
                view={view}
                model={askModel() ?? { questions: [], signature: "" }}
                pendingCount={props.pending.length}
                busy={() => busy(view.challenge_id)}
                draft={askDraft}
                onDraft={setAskDraft}
                respond={(payload) => void send(view, "submit", payload)}
                skip={() => void send(view, "dismiss")}
                refresh={() => void props.refresh()}
              />
            )}
          </div>
        </div>
      )}
    </Show>
  );
};
