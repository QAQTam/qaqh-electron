// AskCard：interaction_requested 内联问卷（AskQuestion{options, allow_custom}）。
// 单选组 + 可选自定义输入 + 提交 → interaction_ask_respond。
import { For, Show, createSignal } from "solid-js";
import type { Component } from "solid-js";
import type { AskQuestion } from "qaqh-js-sdk";

export interface AskActions {
  respond: (interactionId: string, answers: Array<{ question_id: string; answer: string }>) => void;
  dismiss: (interactionId: string) => void;
}

export const AskCard: Component<{
  interactionId: string;
  questions: AskQuestion[];
  actions: AskActions;
}> = (props) => {
  const [picks, setPicks] = createSignal<Record<string, string>>({});
  const [custom, setCustom] = createSignal<Record<string, string>>({});

  const canSubmit = () =>
    props.questions.every((q) => {
      const p = picks()[q.id];
      const c = custom()[q.id]?.trim();
      return Boolean(p || c);
    });

  const submit = () => {
    if (!canSubmit()) return;
    const answers = props.questions.map((q) => ({
      question_id: q.id,
      answer: custom()[q.id]?.trim() || picks()[q.id] || "",
    }));
    props.actions.respond(props.interactionId, answers);
  };

  return (
    <div class="ask-card">
      <For each={props.questions}>
        {(q) => (
          <div>
            <div class="ask-q">{q.question}</div>
            <Show when={(q.options?.length ?? 0) > 0}>
              <div class="ask-options">
                <For each={q.options}>
                  {(opt) => (
                    <button
                      class={["ask-option", { picked: picks()[q.id] === opt }]}
                      onClick={() => setPicks((p) => ({ ...p, [q.id]: opt }))}
                    >
                      <span class="radio" />
                      {opt}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={q.allow_custom}>
              <div class="ask-custom">
                <input
                  placeholder="或输入自定义答案…"
                  value={custom()[q.id] ?? ""}
                  onInput={(e) => setCustom((c) => ({ ...c, [q.id]: e.currentTarget.value }))}
                />
              </div>
            </Show>
          </div>
        )}
      </For>
      <div style={{ display: "flex", gap: "8px" }}>
        <button class="ask-submit" disabled={!canSubmit()} onClick={submit}>
          提交
        </button>
        <button class="approval-btn" onClick={() => props.actions.dismiss(props.interactionId)}>
          跳过
        </button>
      </div>
    </div>
  );
};
