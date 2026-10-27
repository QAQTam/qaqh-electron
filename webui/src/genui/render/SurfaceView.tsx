/**
 * 受限 Surface 渲染器(原型):把校验过的 SurfaceIR 映射到受信组件目录。
 * 节点树在 IR 层已验证(封闭 props、引用完整、深度≤16),这里不做二次放宽;
 * 状态是 Surface local 域(spec §10),动作只在用户事件事务里求值,
 * 求值失败显示具名错误,不触发任何外部操作。
 * for/repeat 节点按 list 态逐项渲染模板,循环变量经 item 作用域传入求值。
 */
import { For, Match, Show, Switch, createSignal, type Component } from "solid-js";
import { createStore } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Action, Expr, IRNode, PropValue, StateValue, SurfaceIR } from "../compiler/ir";
import { forestRoots, GenUiError } from "../compiler/ir";
import { evaluate, type ItemScope } from "../runtime/eval";

const display = (value: StateValue): string => {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.join("、");
  return String(value);
};

const SurfaceView: Component<{ ir: SurfaceIR; onFollowUp?: (text: string) => void; streaming?: boolean }> = ({ ir, onFollowUp, streaming }) => {
  // ir 是静态值(Show keyed 保证 IR 变化即重挂):一次解构,避免 Solid 2 props
  // getter 链在非跟踪作用域里被读取触发 STRICT_READ_UNTRACKED 诊断。
  const initial = (): Record<string, StateValue> => {
    const record: Record<string, StateValue> = {};
    for (const [key, state] of Object.entries(ir.states)) record[key] = state.initial;
    return record;
  };
  const [states, setStates] = createStore<Record<string, StateValue>>(initial());
  const [error, setError] = createSignal<string | null>(null);

  const dispatch = async (action: Action, scope?: ItemScope): Promise<void> => {
    setError(null);
    try {
      // Solid 2 store setter 只有整体/函数形式:局部 set 用浅拷贝(状态域很小)。
      if (action.kind === "reset") {
        setStates(() => initial());
      } else if (action.kind === "followUp") {
        // 只提交选定字段(标签:值),不上传完整私有状态(spec §7.6);
        // 语义 = 现有会话输入排队,不产生 toolcall、不伪装 system 输入。
        const lines = action.fields.map((field) => `- ${field.label}：${display(evaluate({ op: "state", key: field.key }, states, scope))}`);
        onFollowUp?.([action.prompt, ...lines].join("\n"));
      } else if (action.kind === "copy") {
        const value = evaluate(action.value, states, scope);
        if (typeof value !== "string") throw new GenUiError("复制内容必须是字符串");
        await navigator.clipboard?.writeText(value);
      } else if (action.kind === "openLink") {
        window.open(action.url, "_blank", "noopener");
      } else if (action.kind === "append" || action.kind === "remove") {
        const value = evaluate(action.value, states, scope);
        if (typeof value !== "string") throw new GenUiError("append/remove 只接受字符串");
        setStates((record) => {
          const current = record[action.key];
          if (action.kind === "append") return { ...record, [action.key]: [...(Array.isArray(current) ? current : []), value] };
          return { ...record, [action.key]: (Array.isArray(current) ? current : []).filter((item) => item !== value) };
        });
      } else {
        const value = evaluate(action.value, states, scope);
        setStates((record) => ({ ...record, [action.key]: value }));
      }
    } catch (cause) {
      setError(cause instanceof GenUiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  const bindingKey = (node: IRNode, name: string): string | null => {
    const value = node.props[name];
    return value?.kind === "binding" ? value.key : null;
  };

  const setBinding = (node: IRNode, name: string, value: StateValue): void => {
    const key = bindingKey(node, name);
    if (key != null) setStates((record) => ({ ...record, [key]: value }));
  };

  const text = (expr: Expr, scope?: ItemScope): string => {
    try {
      return display(evaluate(expr, states, scope));
    } catch {
      // 渲染期不允许写信号(Solid 2 REACTIVE_WRITE_IN_OWNED_SCOPE):
      // 求值失败降级为占位符;具名错误只在用户事件事务(dispatch)里上报。
      return "—";
    }
  };

  const propText = (value: PropValue | undefined, scope?: ItemScope): string | undefined => {
    if (value == null) return undefined;
    if (value.kind === "lit") return display(value.value);
    if (value.kind === "expr") return text(value.expr, scope);
    return undefined;
  };

  /** expr 槽位接受字面量(校验层放宽):统一取成 Expr。 */
  const exprOf = (value: PropValue | undefined): Expr => {
    if (value?.kind === "expr") return value.expr;
    if (value?.kind === "lit") return { op: "lit", value: value.value };
    return { op: "lit", value: "" };
  };

  /** 数字槽位(maxLength):字面量直取,表达式在渲染期求值;非数字忽略。 */
  const propNumber = (value: PropValue | undefined, scope?: ItemScope): number | undefined => {
    if (value == null) return undefined;
    if (value.kind === "lit") return typeof value.value === "number" ? value.value : undefined;
    if (value.kind !== "expr") return undefined;
    try {
      const result = evaluate(value.expr, states, scope);
      return typeof result === "number" ? result : undefined;
    } catch {
      return undefined;
    }
  };

  /** 条件属性(show/disabled/required)统一真值;渲染期求值失败按真处理。 */
  const truthyProp = (value: PropValue | undefined, scope?: ItemScope): boolean => {
    if (value == null || value.kind !== "expr") return false;
    try {
      const result = evaluate(value.expr, states, scope);
      return result !== false && result !== 0 && result !== "";
    } catch {
      return true;
    }
  };

  const children = (node: IRNode, scope?: ItemScope): JSX.Element => {
    const list = node.props.children;
    if (list?.kind !== "list" || list.items.length === 0) return null;
    // IR 树不可变(变化即整树重挂),静态映射即可,不需要 For 的增量复用。
    return <>{list.items.map((id) => renderNode(id, 1, scope))}</>;
  };

  const renderNode = (id: string, depth: number, scope?: ItemScope): JSX.Element => {
    if (depth > 16) return null;
    const node = ir.nodes[id];
    if (node == null) return null;
    if (node.repeat != null) {
      // for/repeat:按 list 态逐项渲染模板,循环变量经作用域传给子树。
      // 注意:行内容走 renderContent,不能再进 renderNode(否则无限递归)。
      const source = states[node.repeat.source];
      const items = Array.isArray(source) ? source : [];
      return (
        <For keyed={false} each={items}>
          {(item) => renderContent(node, { as: node.repeat!.as, value: item() })}
        </For>
      );
    }
    return renderContent(node, scope);
  };

  const renderContent = (node: IRNode, scope?: ItemScope): JSX.Element => {
    const doneKey = node.type === "Todo" ? bindingKey(node, "done") : null;
    const isDone = (): boolean => doneKey != null && states[doneKey] === true;
    // 条件渲染:show 表达式求值假值时整个节点不渲染(渲染期不允许写信号,
    // 求值失败按可见处理;具名错误只在用户事件事务里上报)。
    if (node.props.show != null && !truthyProp(node.props.show, scope)) return null;
    const content = (
      <Switch fallback={null}>
        <Match when={node.type === "Card"}>
          <div class="genui-card">
            <Show when={propText(node.props.title, scope)}>{(title) => <div class="genui-card-title">{title()}</div>}</Show>
            {children(node, scope)}
          </div>
        </Match>
        <Match when={node.type === "Stack"}>
          <div class="genui-stack">{children(node, scope)}</div>
        </Match>
        <Match when={node.type === "Row"}>
          <div class="genui-row">{children(node, scope)}</div>
        </Match>
        <Match when={node.type === "Title"}>
          <div class="genui-title">{text(exprOf(node.props.text), scope)}</div>
        </Match>
        <Match when={node.type === "Text"}>
          <p class="genui-text">{text(exprOf(node.props.text), scope)}</p>
        </Match>
        <Match when={node.type === "Metric"}>
          <div class="genui-metric">
            <span class="genui-metric-label">{propText(node.props.label, scope)}</span>
            <b class="genui-metric-value">{text(exprOf(node.props.value), scope)}</b>
          </div>
        </Match>
        <Match when={node.type === "Badge"}>
          <span class="genui-badge">{text(exprOf(node.props.text), scope)}</span>
        </Match>
        <Match when={node.type === "Button"}>
          <button type="button" class="genui-btn" disabled={truthyProp(node.props.disabled, scope)}
            onClick={() => {
              const onPress = node.props.onPress;
              if (onPress?.kind === "action") void dispatch(onPress.action, scope);
            }}>{propText(node.props.label, scope)}</button>
        </Match>
        <Match when={node.type === "TextInput"}>
          <label class="genui-field">
            <span class="genui-metric-label">{propText(node.props.label, scope)}</span>
            <input class="genui-input" type="text"
              value={bindingKey(node, "value") != null ? String(states[bindingKey(node, "value")!] ?? "") : ""}
              placeholder={propText(node.props.placeholder, scope)}
              required={truthyProp(node.props.required, scope)}
              pattern={propText(node.props.pattern, scope)}
              maxlength={propNumber(node.props.maxLength, scope)}
              onInput={(event) => setBinding(node, "value", event.currentTarget.value)} />
          </label>
        </Match>
        <Match when={node.type === "Checkbox"}>
          <label class="genui-field genui-check">
            <input type="checkbox"
              checked={bindingKey(node, "checked") != null ? states[bindingKey(node, "checked")!] === true : false}
              onChange={(event) => setBinding(node, "checked", event.currentTarget.checked)} />
            <span class="genui-text">{propText(node.props.label, scope)}</span>
          </label>
        </Match>
        <Match when={node.type === "TodoList"}>
          <div class="genui-todos" role="group">
            <Show when={propText(node.props.title, scope)}>{(title) => <div class="genui-card-title">{title()}</div>}</Show>
            {children(node, scope)}
          </div>
        </Match>
        <Match when={node.type === "Todo"}>
          {/* todo v2:可点击,但点击只翻 Surface local 布尔态,不产生 toolcall。 */}
          <button type="button" class="genui-todo" role="checkbox" aria-checked={isDone() ? "true" : "false"}
            onClick={() => {
              if (doneKey != null) setStates((record) => ({ ...record, [doneKey]: !(states[doneKey] === true) }));
            }}>
            <span class="genui-todo-box" aria-hidden="true">{isDone() ? "✓" : ""}</span>
            <span class={{ "genui-todo-text": true, done: isDone() }}>{text(exprOf(node.props.text), scope)}</span>
            <Show when={propText(node.props.meta, scope)}>{(meta) => <span class="genui-metric-label">{meta()}</span>}</Show>
          </button>
        </Match>
        <Match when={node.type === "TagList"}>
          {(() => {
            const key = bindingKey(node, "items");
            const items = key != null ? states[key] : undefined;
            return (
              <div class="genui-row">
                <For each={Array.isArray(items) ? items : []}>{(tag) => <span class="genui-badge">{tag}</span>}</For>
              </div>
            );
          })()}
        </Match>
        <Match when={node.type === "Divider"}>
          <hr class="genui-divider" />
        </Match>
      </Switch>
    );
    return content;
  };

  // 树结构在 IR 层已定:root 优先;无 root(模型省略选项/流式未到齐)时只平铺
  // 森林顶层——按 order 全量平铺会把已随父渲染的子树再画一遍(重复三连的来源)。
  let body: JSX.Element;
  if (ir.rootId != null) body = renderNode(ir.rootId, 1);
  else body = <>{forestRoots(ir).map((id) => renderNode(id, 1))}</>;

  return (
    <div class="genui-view" data-surface={ir.surfaceId} data-streaming={streaming ? "true" : undefined}>
      <Show when={ir.title != null}><div class="genui-view-title">{ir.title}</div></Show>
      {body}
      <Show when={streaming}><span class="genui-streaming">生成中…</span></Show>
      {/* 软告警(孤儿节点):编译通过但某些节点挂不进树,提示不阻断渲染。 */}
      <For each={ir.warnings ?? []}>{(warning) => <p class="genui-surface-warn">{warning}</p>}</For>
      <Show when={error()}><p class="genui-surface-error" role="alert">{error()}</p></Show>
    </div>
  );
};

export default SurfaceView;
