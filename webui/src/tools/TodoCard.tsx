/**
 * todo v2 语义卡片:成功终态的 todo 工具调用在 timeline 原位渲染为清单快照。
 *
 * 数据事实来源是**该次调用自己的入参**(todo_write 全量覆写 / todo_update 单条),
 * 不读 store.todos——store 是"当前面板"的单源,而历史回合必须展示历史状态;
 * 两者语义不同,不能互相当真相。todo_list 没有写入内容,仍走普通语义行。
 *
 * 解析失败/非成功终态返回 null,由 StepRow 回退为普通工具行(错误与授权等待
 * 仍按既有规则展示),卡片不掩盖失败语义。
 */
import { For, Show, type Component } from "solid-js";
import IconListTodo from "~icons/lucide/list-todo";
import IconCheck from "~icons/lucide/check";
import IconLoader from "~icons/lucide/loader-circle";
import { normalizeStatus, todoStatusLabel, type TodoStatus } from "../lib/todo";
import { STR } from "../lib/strings";
import { parseJsonish } from "../session/reducer";
import type { ToolStep } from "../session/types";
import { toolPresentation } from "./presentation";

/** 单次渲染上限:卡片在聊天流内,超长清单截断展示(清单真相仍在右栏面板)。 */
const MAX_CARD_ITEMS = 50;

export type TodoCardItem = { title: string; status: TodoStatus; evidence?: string; description?: string };

export type TodoCardData =
  | { kind: "list"; items: TodoCardItem[] }
  | { kind: "update"; id: string; status: TodoStatus; evidence?: string };

function cardItem(raw: unknown): TodoCardItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!title) return null;
  return {
    title,
    status: normalizeStatus(item.status),
    evidence: typeof item.evidence === "string" && item.evidence ? item.evidence : undefined,
    description: typeof item.description === "string" && item.description ? item.description : undefined,
  };
}

/** null = 不适合卡片(非成功终态 / 无可展示条目),回退普通工具行。 */
export function todoCardData(step: ToolStep): TodoCardData | null {
  if (toolPresentation(step) !== "todo" || step.status !== "success" || step.name === "todo_list") return null;
  const args = parseJsonish(step.argsJson);
  if (args == null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : Array.isArray(record.todos) ? record.todos : null;
  if (rawItems != null) {
    const items = rawItems.slice(0, MAX_CARD_ITEMS).map(cardItem).filter((item): item is TodoCardItem => item != null);
    return items.length > 0 ? { kind: "list", items } : null;
  }
  if (typeof record.id === "string" && record.id) {
    return { kind: "update", id: record.id, status: normalizeStatus(record.status), evidence: typeof record.evidence === "string" && record.evidence ? record.evidence : undefined };
  }
  return null;
}

const CardDot: Component<{ status: TodoStatus }> = (props) => (
  <Show
    when={props.status === "in_progress"}
    fallback={<span class="todo-dot" aria-hidden="true"><Show when={props.status === "completed"}><IconCheck /></Show></span>}
  >
    <span class="todo-dot todo-spin" aria-hidden="true"><IconLoader /></span>
  </Show>
);

export const TodoCard: Component<{ step: ToolStep }> = (props) => {
  // 每个分支先把 accessor 读进局部变量再收窄类型:Solid 下同一 accessor 调两次
  // 是两次求值,TS 无法跨调用收窄联合类型。
  const items = (): TodoCardItem[] => {
    const data = todoCardData(props.step);
    return data?.kind === "list" ? data.items : [];
  };
  const update = () => {
    const data = todoCardData(props.step);
    return data?.kind === "update" ? data : null;
  };
  const done = () => items().filter((item) => item.status === "completed").length;
  const total = () => items().length;
  // 头部动作只保留动词(标题独立为「待办」);非成功终态不会有卡片,这里总带「已」。
  const action = () => (props.step.name === "todo_create" ? "已创建" : "已更新");
  return (
    <div class={{ "todo-card": true, "is-update": update() != null }} role="group" aria-label={`${STR.todoTitle},${action()}`}>
      <div class="todo-card-head">
        <IconListTodo />
        <span class="todo-card-title">{STR.todoTitle}</span>
        <span class="todo-card-action">{action()}</span>
        <Show when={total() > 0}><b class="todo-count">{STR.todoDone(done(), total())}</b></Show>
      </div>
      <Show when={total() > 0}>
        <div class="todo-card-bar" aria-hidden="true"><span style={{ width: `${Math.round((done() / total()) * 100)}%` }} /></div>
        <ul class="todo-card-list">
          <For each={items()}>
            {(item) => (
              <li class={{ "todo-row": true, "todo-card-row": true, [`st-${item.status}`]: true }}
                aria-label={`${item.title}，${todoStatusLabel(item.status)}`}>
                <CardDot status={item.status} />
                <span class="todo-title" title={item.evidence ?? item.description ?? item.title}>{item.title}</span>
                <span class="sr-only">{todoStatusLabel(item.status)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={update()} keyed>
        {(upd) => (
          <div class="todo-row todo-card-row" data-todo-id={upd.id}>
            <CardDot status={upd.status} />
            <span class="todo-title" title={upd.evidence}>
              <b>{upd.id}</b>
              <span class="todo-card-state">{todoStatusLabel(upd.status)}</span>
            </span>
          </div>
        )}
      </Show>
    </div>
  );
};
