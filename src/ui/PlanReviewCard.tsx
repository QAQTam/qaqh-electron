// PlanReviewCard：plan_content markdown 渲染 + TodoItem 清单 + 通过/驳回。
// → plan_review_respond{approved, autonomous}。
import { For, Show, createSignal } from "solid-js";
import type { Component } from "solid-js";
import type { TodoItem } from "qaqh-js-sdk";
import { MarkdownText } from "./blocks";

export interface PlanReviewActions {
  respond: (interactionId: string, approved: boolean, autonomous: boolean) => void;
}

export const PlanReviewCard: Component<{
  interactionId: string;
  planContent: string;
  todoItems: TodoItem[] | null;
  actions: PlanReviewActions;
}> = (props) => {
  const [answered, setAnswered] = createSignal(false);

  const answer = (approved: boolean) => {
    if (answered()) return;
    props.actions.respond(props.interactionId, approved, false);
    setAnswered(true);
  };

  return (
    <div class="plan-card">
      <div class="plan-title-row">◇ 计划评审</div>
      <div class="md">
        <MarkdownText text={props.planContent} actions={{ openExternal: () => {}, copyText: () => {} }} />
      </div>
      <Show when={props.todoItems && props.todoItems.length > 0}>
        <div style={{ "margin-top": "8px" }}>
          <For each={props.todoItems}>
            {(t) => (
              <div class="plan-todo">
                <span class="todo-cplx">{t.complexity}</span>
                <span>
                  <span class="todo-title">{t.title}</span>
                  <Show when={t.description}>
                    <span class="todo-desc"> — {t.description}</span>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="approval-actions">
        <button class="approval-btn" disabled={answered()} onClick={() => answer(false)}>
          驳回
        </button>
        <button class="approval-btn primary" disabled={answered()} onClick={() => answer(true)}>
          通过执行
        </button>
      </div>
    </div>
  );
};
