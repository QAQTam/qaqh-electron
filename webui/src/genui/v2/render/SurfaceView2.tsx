/**
 * SurfaceView2(v0.2):A2UI 消息流驱动的受限渲染器。
 *
 * 与 v0.1 SurfaceView 的本质差异:输入不再是每帧全量重编译的 SurfaceIR,而是
 * translate 产出的 A2UI 消息——createSurface 一次,updateComponents/updateDataModel
 * 每帧 patch。组件按 id keyed(Solid For 对字符串项按值复用),DOM 节点跨流式帧
 * 存活;dataModel 变更经 tick 信号驱动内容重解析,不整树重挂。
 * 动作语义:`qaqh.action.*` 前缀在渲染器本地拦截(set/append/remove/reset 改
 * dataModel;followUp 走会话输入队列;copy/openLink 外围),其余命名事件 P1
 * 静默、P2 转发 agent 通道。
 */
import { For, Match, Show, Switch, createMemo, createSignal, type Component } from "solid-js";
import type { JSX } from "@solidjs/web";

import { compileSurface } from "../../compiler";
import type { UiSourcePart } from "../../source/decoder";
import { pointerGet, pointerSet } from "../dataModel";
import { resolveDynamic, type TemplateScope } from "../eval2";
import { SurfaceRegistry, type SurfaceState } from "../store";
import { REPEAT_EXTENSION, translateCreate, translateUpdate } from "../translate";
import type { DynamicValue, WireComponent } from "../types";

type Feed =
  | { state: "ok"; surfaceId: string }
  | { state: "error"; message: string }
  | { state: "building" };

const display = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map(display).join("、");
  return value == null ? "" : String(value);
};

const SurfaceView2: Component<{ part: () => UiSourcePart; onFollowUp?: (text: string) => void }> = (props) => {
  const registry = new SurfaceRegistry();
  let created = false;
  let initialStates: { [key: string]: unknown } = {};
  const [feed, setFeed] = createSignal<Feed>({ state: "building" });
  const [compileError, setCompileError] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0);
  const [actionError, setActionError] = createSignal<string | null>(null);

  createMemo(() => {
    const part = props.part();
    try {
      const ir = compileSurface(part.source, part.format, { final: part.sealed });
      if (!created) {
        registry.apply(translateCreate(ir));
        created = true;
        initialStates = structuredClone(registry.get(ir.surfaceId)?.dataModel ?? {});
      } else {
        for (const message of translateUpdate(ir)) registry.apply(message);
      }
      setFeed({ state: "ok", surfaceId: ir.surfaceId });
      setTick((n) => n + 1);
    } catch (cause) {
      if (part.sealed) {
        setFeed({ state: "error", message: cause instanceof Error ? cause.message : String(cause) });
        setCompileError(cause instanceof Error ? cause.message : String(cause));
      } else {
        // 流式部分编译失败:静默保持占位卡,seal 后的失败才具名(与 v0.1 同约)。
        setFeed({ state: "building" });
      }
    }
  });

  const surface = (): SurfaceState | undefined => {
    const current = feed();
    return current.state === "ok" ? registry.get(current.surfaceId) : undefined;
  };

  const resolve = (value: DynamicValue | undefined, scope: TemplateScope | null): unknown => {
    const state = surface();
    if (state == null || value == null) return null;
    try {
      return resolveDynamic(value, state.dataModel, scope);
    } catch {
      return null; // 渲染期求值失败降级占位;具名错误只在动作事务里上报(对齐 v0.1)
    }
  };

  const text = (value: DynamicValue | undefined, scope: TemplateScope | null): string => display(resolve(value, scope));

  const truthy = (value: DynamicValue | undefined, scope: TemplateScope | null): boolean => {
    const resolved = resolve(value, scope);
    return resolved === true || (typeof resolved === "number" && resolved !== 0) || (typeof resolved === "string" && resolved !== "");
  };

  const dispatch = (event: { name: string; context: Record<string, DynamicValue> }, scope: TemplateScope | null): void => {
    setActionError(null);
    const state = surface();
    if (state == null) return;
    const here = (value: DynamicValue | undefined): unknown => {
      try {
        return resolveDynamic(value, state.dataModel, scope);
      } catch (cause) {
        throw rethrow(cause);
      }
    };
    const writeState = (path: string, value: unknown): void => {
      pointerSet(state.dataModel, path, value as never);
      setTick((n) => n + 1);
    };
    try {
      const key = typeof event.context.key === "string" ? event.context.key : "";
      switch (event.name) {
        case "qaqh.action.set":
          writeState(`/s/${key}`, here(event.context.value));
          break;
        case "qaqh.action.append": {
          const list = pointerGet(state.dataModel, `/s/${key}`);
          writeState(`/s/${key}`, [...(Array.isArray(list) ? list : []), here(event.context.value)]);
          break;
        }
        case "qaqh.action.remove": {
          const list = pointerGet(state.dataModel, `/s/${key}`);
          const item = here(event.context.value);
          writeState(`/s/${key}`, (Array.isArray(list) ? list : []).filter((entry) => entry !== item));
          break;
        }
        case "qaqh.action.reset":
          writeState("/s", structuredClone((initialStates.s as { [key: string]: unknown } | undefined) ?? {}));
          break;
        case "qaqh.action.copy":
          void navigator.clipboard?.writeText(display(here(event.context.value)));
          break;
        case "qaqh.action.openLink": {
          const url = display(here(event.context.url));
          if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
          break;
        }
        case "qaqh.action.followUp": {
          const prompt = display(here(event.context.prompt));
          const fields = Array.isArray(event.context.fields) ? event.context.fields : [];
          const lines = (fields as Array<{ label?: unknown; key?: unknown }>).map((field) =>
            `- ${display(field.label)}：${display(here({ "@path": `/s/${String(field.key)}` }))}`,
          );
          props.onFollowUp?.([prompt, ...lines].join("\n"));
          break;
        }
        default:
          break; // 其余命名事件:P1 静默,P2 转发 agent 通道
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  function renderNode(component: WireComponent, scope: TemplateScope | null): JSX.Element {
    if (component.show != null && !truthy(component.show as DynamicValue, scope)) return null;
    return renderContent(component, scope);
  }

  function renderChildren(component: WireComponent, scope: TemplateScope | null): JSX.Element {
    const state = surface();
    if (state == null) return null;
    const ids: string[] = [];
    if (typeof component.child === "string") ids.push(component.child);
    if (Array.isArray(component.children)) ids.push(...component.children);
    const expanded: Array<{ component: WireComponent; scope: TemplateScope | null }> = [];
    for (const id of ids) {
      const child = state.components.get(id);
      if (child == null) continue;
      const repeat = child.metadata?.extensions?.[REPEAT_EXTENSION] as { path?: string } | undefined;
      if (repeat?.path != null && scope == null) {
        // 模板:按 dataModel 列表展开,项进 TemplateScope(相对路径与 @index 可用)。
        const items = resolveDynamic({ "@path": repeat.path }, state.dataModel, null);
        if (Array.isArray(items)) {
          items.forEach((item, index) => expanded.push({ component: child, scope: { index, value: item ?? null } }));
        }
        continue;
      }
      expanded.push({ component: child, scope });
    }
    return (
      <For each={expanded.map((entry) => JSON.stringify({ id: entry.component.id, scope: entry.scope?.index ?? null }))}>
        {(key) => {
          const entry = expanded.find((candidate) => JSON.stringify({ id: candidate.component.id, scope: candidate.scope?.index ?? null }) === key);
          if (entry == null) return null;
          tick();
          return renderNode(entry.component, entry.scope);
        }}
      </For>
    );
  }

  function renderContent(component: WireComponent, scope: TemplateScope | null): JSX.Element {
    tick(); // 内容重解析跟随 dataModel 帧号;DOM 由 For keyed 复用,不重挂
    const prop = (name: string): DynamicValue | undefined => component[name] as DynamicValue | undefined;
    const children = renderChildren(component, scope);
    const action = (): { name: string; context: Record<string, DynamicValue> } | null => {
      const handler = component.onPress as { event?: { name: string; context: Record<string, DynamicValue> } } | undefined;
      return handler?.event ?? null;
    };
    const bindPath = (name: string): string | null => {
      const binding = component[name] as { "@path"?: string } | undefined;
      return binding?.["@path"] != null && binding["@path"].startsWith("/s/") ? binding["@path"] : null;
    };
    const bindWrite = (name: string, value: unknown): void => {
      const path = bindPath(name);
      const state = surface();
      if (path == null || state == null) return;
      pointerSet(state.dataModel, path, value as never);
      setTick((n) => n + 1);
    };
    return (
      <Switch fallback={null}>
        <Match when={component.component === "Card"}>
          <div class="genui-card">
            <Show when={text(prop("title"), scope) !== ""}>{(title) => <div class="genui-card-title">{title()}</div>}</Show>
            {children}
          </div>
        </Match>
        <Match when={component.component === "Stack"}>
          <div class="genui-stack">{children}</div>
        </Match>
        <Match when={component.component === "Row"}>
          <div class="genui-row">{children}</div>
        </Match>
        <Match when={component.component === "Title"}>
          <div class="genui-title">{text(prop("text"), scope)}</div>
        </Match>
        <Match when={component.component === "Text"}>
          <p class="genui-text">{text(prop("text"), scope)}</p>
        </Match>
        <Match when={component.component === "Metric"}>
          <div class="genui-metric">
            <span class="genui-metric-label">{text(prop("label"), scope)}</span>
            <b class="genui-metric-value">{text(prop("value"), scope)}</b>
          </div>
        </Match>
        <Match when={component.component === "Badge"}>
          <span class="genui-badge">{text(prop("text"), scope)}</span>
        </Match>
        <Match when={component.component === "Button"}>
          <button
            type="button"
            class="genui-btn"
            disabled={component.disabled != null && truthy(prop("disabled"), scope)}
            onClick={() => {
              const event = action();
              if (event != null) dispatch(event, scope);
            }}
          >
            {text(prop("label"), scope)}
          </button>
        </Match>
        <Match when={component.component === "Divider"}>
          <hr class="genui-divider" />
        </Match>
        <Match when={component.component === "TextInput"}>
          <label class="genui-field">
            <span class="genui-metric-label">{text(prop("label"), scope)}</span>
            <input
              class="genui-input"
              type="text"
              value={display(resolve(prop("value"), scope))}
              placeholder={text(prop("placeholder"), scope)}
              maxlength={typeof component.maxLength === "number" ? component.maxLength : undefined}
              onInput={(event) => bindWrite("value", event.currentTarget.value)}
            />
          </label>
        </Match>
        <Match when={component.component === "Checkbox"}>
          <label class="genui-field genui-check">
            <input
              type="checkbox"
              checked={resolve(prop("checked"), scope) === true}
              onChange={(event) => bindWrite("checked", event.currentTarget.checked)}
            />
            <span class="genui-text">{text(prop("label"), scope)}</span>
          </label>
        </Match>
        <Match when={component.component === "TodoList"}>
          <div class="genui-todos" role="group">
            <Show when={text(prop("title"), scope) !== ""}>{(title) => <div class="genui-card-title">{title()}</div>}</Show>
            {children}
          </div>
        </Match>
        <Match when={component.component === "Todo"}>
          <button
            type="button"
            class="genui-todo"
            role="checkbox"
            aria-checked={resolve(prop("done"), scope) === true ? "true" : "false"}
            onClick={() => bindWrite("done", resolve(prop("done"), scope) !== true)}
          >
            <span class="genui-todo-box" aria-hidden="true">{resolve(prop("done"), scope) === true ? "✓" : ""}</span>
            <span class={{ "genui-todo-text": true, done: resolve(prop("done"), scope) === true }}>{text(prop("text"), scope)}</span>
            <Show when={text(prop("meta"), scope) !== ""}>{(meta) => <span class="genui-metric-label">{meta()}</span>}</Show>
          </button>
        </Match>
        <Match when={component.component === "TagList"}>
          <div class="genui-row">
            <For each={Array.isArray(resolve(prop("items"), scope)) ? (resolve(prop("items"), scope) as unknown[]) : []}>
              {(tag) => <span class="genui-badge">{display(tag)}</span>}
            </For>
          </div>
        </Match>
      </Switch>
    );
  }

  const root = (): WireComponent | undefined => surface()?.components.get("root");
  const blocker = (): string | null => {
    const current = feed();
    return current.state === "ok" ? registry.renderBlocker(current.surfaceId) : "尚未就绪";
  };

  return (
    <Switch
      fallback={
        <Show when={feed().state === "error"}>
          <div class="genui-surface sealed" data-surface={props.part().surfaceId}>
            <div class="genui-surface-head">
              <span class="genui-surface-title">生成式界面 · {props.part().surfaceId ?? "未命名"}</span>
              <span class="genui-surface-status">编译失败</span>
            </div>
            <p class="genui-surface-error" role="alert">{compileError() ?? ""}</p>
          </div>
        </Show>
      }
    >
      <Match when={feed().state === "ok" && blocker() == null && root() != null}>
        <div class="genui-view" data-surface={surface()?.surfaceId} data-streaming={props.part().sealed ? undefined : "true"}>
          {renderChildren(root()!, null)}
          <Show when={props.part().sealed !== true}>
            <span class="genui-streaming">生成中…</span>
          </Show>
          <Show when={actionError()}>
            <p class="genui-surface-error" role="alert">{actionError()}</p>
          </Show>
        </div>
      </Match>
      <Match when={feed().state === "ok" && blocker() != null}>
        {/* seal 后仍不完整(坏引用/环/超预算):具名暴露,不静默 */}
        <div class="genui-surface sealed" data-surface={props.part().surfaceId}>
          <div class="genui-surface-head">
            <span class="genui-surface-title">生成式界面 · {props.part().surfaceId ?? "未命名"}</span>
            <span class="genui-surface-status">结构不完整</span>
          </div>
          <Show when={props.part().sealed === true}>
            <p class="genui-surface-error" role="alert">{blocker()}</p>
          </Show>
        </div>
      </Match>
    </Switch>
  );
};

function rethrow(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export default SurfaceView2;
