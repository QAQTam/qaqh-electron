/**
 * 会话头部的 goal 徽标与详情卡(ADR-0015 §二)。
 *
 * 徽标负责「有 goal 且一眼可读」:状态色点 + 状态词;点开详情卡——objective
 * 全文、用量/预算/剩余(直显后端记账值,tokens_used 是权威值,前端不算)。
 * 控制按钮只暴露用户可控的迁移:暂停(active)/恢复(其余未完成态);
 * `complete` 只读展示——那是模型审计后的声明。预算编辑服务于预算熔断的
 * 唯一恢复路径(goal.set 调高/清除预算)。
 *
 * 语义备忘(施工单 §四):取消续跑回合≠停目标;blocked 是「需要人看一眼」,
 * 不是错误;拒绝码按 CommandRejectedError.code 分型,不 grep 文案。
 */
import { createSignal, Show, type Component } from "solid-js";
import IconTarget from "~icons/lucide/target";
import type { GoalStatus } from "../api/contract";
import { CommandRejectedError } from "../lib/transport";
import { STR } from "../lib/strings";
import { toast } from "../ui/toast";
import { useDismissable } from "../ui/dismissable";
import type { Tab } from "../tabs/store";

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: STR.goalStatusActive,
  paused: STR.goalStatusPaused,
  blocked: STR.goalStatusBlocked,
  usage_limited: STR.goalStatusUsageLimited,
  budget_limited: STR.goalStatusBudgetLimited,
  complete: STR.goalStatusComplete,
};

/** 状态语义注:只在对应状态下出现在详情卡,别拼成一句万能提示。 */
const statusNote = (status: GoalStatus): string | null => {
  if (status === "active") return STR.goalAutoNote;
  if (status === "blocked") return STR.goalBlockedNote;
  if (status === "usage_limited") return STR.goalUsageLimitedNote;
  if (status === "budget_limited") return STR.goalBudgetLimitedNote;
  return null;
};

export interface GoalBadgeProps {
  tab: Tab;
}

export const GoalBadge: Component<GoalBadgeProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [editText, setEditText] = createSignal("");
  const [budgetText, setBudgetText] = createSignal("");
  let cardRef: HTMLDivElement | undefined;

  const goal = () => props.tab.store.state[0].goal;

  /** no_goal = 本地状态面陈旧:goal.get 回填权威值(null 即清)。 */
  const reconcile = async (): Promise<void> => {
    try {
      const goal = await props.tab.store.goalGet();
      props.tab.store.state[1]((draft) => { draft.goal = goal; });
    } catch (error) {
      toast(STR.goalRefreshFailed(error instanceof Error ? error.message : String(error)), "err");
    }
  };

  const run = (fn: () => Promise<unknown>, fallback: (reason: string) => string): void => {
    void fn().catch((error: unknown) => {
      // 按后端稳定码分支:goal_exists 别静默覆盖、no_goal 刷状态面——都不是「再点一次」。
      const code = error instanceof CommandRejectedError ? error.code : "";
      if (code === "goal_exists") { toast(STR.goalExistsHint, "err"); return; }
      if (code === "no_goal") { void reconcile(); toast(STR.goalNoGoalHint, "err"); return; }
      toast(fallback(error instanceof Error ? error.message : String(error)), "err");
    });
  };

  const setStatus = (status: GoalStatus): void =>
    run(() => props.tab.store.goalSet({ status }), STR.goalSetFailed);

  const saveObjective = (): void => {
    const objective = editText().trim();
    setEditing(false);
    if (objective === "" || objective === goal()?.objective) return;
    run(() => props.tab.store.goalSet({ objective }), STR.goalSetFailed);
  };

  const setBudget = (tokenBudget: number | null): void => {
    setBudgetText("");
    run(() => props.tab.store.goalSet({ tokenBudget }), STR.goalSetFailed);
  };

  const commitBudget = (): void => {
    const text = budgetText().trim();
    if (text === "") return;
    const budget = Number(text);
    // NaN 过 JSON.stringify 会变 null,而 null 在 goal.set 里是「清除预算」——
    // 打错字清掉别人的预算。非数字拦在 wire 前;0/负数放行给后端 validate 拒。
    if (!Number.isFinite(budget)) { toast(STR.goalBudgetNotNumber, "err"); return; }
    setBudgetText("");
    run(() => props.tab.store.goalSet({ tokenBudget: budget }), STR.goalSetFailed);
  };

  const clearGoal = (): void => {
    setOpen(false);
    run(() => props.tab.store.goalClear(), STR.goalClearFailed);
  };

  useDismissable({
    active: open,
    onDismiss: () => setOpen(false),
    inside: () => [cardRef],
  });

  return (
    <div class="goal-badge-wrap" ref={cardRef}>
      <Show when={goal()}>
        {(current) => (
          <>
            <button
              type="button"
              class={{ "goal-badge": true, open: open() }}
              data-status={current().status}
              title={`${STR.goalBadgeTitle} · ${STATUS_LABELS[current().status]}`}
              aria-expanded={open() ? "true" : "false"}
              onClick={() => setOpen(!open())}
            >
              <IconTarget />
              {STATUS_LABELS[current().status]}
            </button>

            <Show when={open()}>
              <div class="goal-card" role="dialog" aria-label={STR.goalBadgeTitle}>
                <div class="goal-card-head">
                  <span class="goal-card-status" data-status={current().status}>{STATUS_LABELS[current().status]}</span>
                  <Show when={current().session_id !== props.tab.seed}>
                    {/* goal 行在链根:链上后继会话照常展示,标注来源免得像两条 goal。 */}
                    <span class="goal-card-root" title={current().session_id}>链根目标</span>
                  </Show>
                </div>

                <Show
                  when={editing()}
                  fallback={<p class="goal-card-objective">{current().objective}</p>}
                >
                  <input
                    type="text"
                    class="goal-card-edit"
                    value={editText()}
                    placeholder={STR.goalEditPlaceholder}
                    onInput={(e) => setEditText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); saveObjective(); }
                      else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
                    }}
                  />
                </Show>

                <p class="goal-card-usage">{STR.goalUsage(current().tokens_used, current().token_budget ?? null)}</p>
                <p class="goal-card-usage">{STR.goalTimeUsed(current().time_used_ms)}</p>
                <Show when={statusNote(current().status)}>{(note) => <p class="goal-card-note">{note()}</p>}</Show>

                <div class="goal-card-actions">
                  <Show when={current().status === "active"}>
                    <button type="button" class="goal-card-btn" onClick={() => setStatus("paused")}>{STR.goalPause}</button>
                  </Show>
                  <Show when={current().status !== "active" && current().status !== "complete"}>
                    <button type="button" class="goal-card-btn" onClick={() => setStatus("active")}>{STR.goalResume}</button>
                  </Show>
                  <Show when={!editing()}>
                    <button
                      type="button"
                      class="goal-card-btn"
                      onClick={() => { setEditText(current().objective); setEditing(true); }}
                    >{STR.goalEdit}</button>
                  </Show>
                  <button type="button" class="goal-card-btn danger" onClick={() => void clearGoal()}>{STR.goalClear}</button>
                </div>

                <div class="goal-card-budget">
                  <input
                    type="text"
                    class="goal-card-budget-input"
                    value={budgetText()}
                    placeholder={STR.goalBudgetPlaceholder}
                    onInput={(e) => setBudgetText(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitBudget(); } }}
                  />
                  <button type="button" class="goal-card-btn" onClick={() => void commitBudget()}>{STR.goalBudgetSet}</button>
                  <button type="button" class="goal-card-btn" onClick={() => void setBudget(null)}>{STR.goalBudgetClear}</button>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};
