/**
 * v0.1 SurfaceIR → A2UI v1.0 消息序列的编译后端。
 *
 * 这是「TSX 围栏保留为 authoring 语法糖」的落点:现有 parser(555 行)原样产出
 * SurfaceIR,本模块把它翻译成 agent_to_renderer 消息,renderer v2 只认消息。
 * 设计要点(docs/genui-v02-a2ui-migration.md §1):
 *  - 状态域扁平 key → dataModel 路径 `/s/<key>`(命名空间保留给层级模型);
 *  - v0.1 表达式 → `qaqh:arith/logic.*` 函数调用(无表达式语言进 wire);
 *  - 本地动作 → `qaqh.action.*` 命名事件,renderer 内拦截,不进 agent 通道;
 *  - repeat → 组件 metadata.extensions["qaqh.dev/repeat"](A2UI 扩展槽是
 *    合法 wire),渲染层按 dataModel 列表展开模板;
 *  - root 保障:A2UI 规范根 id 必须是 "root"——v0.1 的 rootId(或森林)包一层
 *    Stack 包装根,预算余量充足(512 节点上限,包装只 +1)。
 */

import type { Action, Expr, PropValue, SurfaceIR } from "../compiler";
import { forestRoots } from "../compiler/ir";
import type { AgentToRendererMessage, DynamicValue, JsonValue, WireComponent } from "./types";

export const V2_CATALOG_ID = "qaqh.dev:standard-v2";
/** metadata.extensions 里携带 repeat 模板信息的扩展键(vendor 命名空间)。 */
/** metadata.extensions 里携带 repeat 模板信息的扩展键(vendor 命名空间)。 */
export const REPEAT_EXTENSION = "qaqh.dev/repeat";

/** seal(整帧):createSurface 一次性带全组件(含包装根)与初始 dataModel。 */
export function translateCreate(ir: SurfaceIR): AgentToRendererMessage {
  return {
    version: "v1.0",
    createSurface: {
      surfaceId: ir.surfaceId,
      catalogId: V2_CATALOG_ID,
      components: translateComponents(ir),
      dataModel: initialDataModel(ir),
    },
  };
}

/** 流式(每帧):updateComponents 全量 + updateDataModel 整体替换 /s/。 */
export function translateUpdate(ir: SurfaceIR): AgentToRendererMessage[] {
  return [
    {
      version: "v1.0",
      updateComponents: { surfaceId: ir.surfaceId, components: translateComponents(ir) },
    },
    { version: "v1.0", updateDataModel: { surfaceId: ir.surfaceId, path: "/s", value: initialStates(ir) } },
  ];
}

function initialStates(ir: SurfaceIR): { [key: string]: JsonValue } {
  const states: { [key: string]: JsonValue } = {};
  for (const [key, state] of Object.entries(ir.states)) states[key] = state.initial;
  return states;
}

function initialDataModel(ir: SurfaceIR): { [key: string]: JsonValue } {
  return { s: initialStates(ir) };
}

/** v0.1 状态引用 → dataModel 绝对路径。 */
function statePath(key: string): string {
  return `/s/${key}`;
}

function lowerExpr(expr: Expr): DynamicValue {
  switch (expr.op) {
    case "lit":
      return expr.value;
    case "state":
      return { "@path": statePath(expr.key) };
    case "item":
      // 模板项本身:v0.1 的 list 态是 string[],项即字符串 → 相对空路径。
      return { "@path": "" };
    case "not":
      return { "@call": "qaqh:logic.not", args: { value: lowerExpr(expr.value) } };
    case "add":
      return call2("qaqh:arith.add", expr.left, expr.right);
    case "sub":
      return call2("qaqh:arith.sub", expr.left, expr.right);
    case "mul":
      return call2("qaqh:arith.mul", expr.left, expr.right);
    case "div":
      return call2("qaqh:arith.div", expr.left, expr.right);
    case "eq":
      return call2("qaqh:logic.eq", expr.left, expr.right);
    case "neq":
      return call2("qaqh:logic.neq", expr.left, expr.right);
    case "gt":
      return call2("qaqh:logic.gt", expr.left, expr.right);
    case "lt":
      return call2("qaqh:logic.lt", expr.left, expr.right);
    case "and":
      return call2("qaqh:logic.and", expr.left, expr.right);
    case "or":
      return call2("qaqh:logic.or", expr.left, expr.right);
  }
}

function call2(name: string, left: Expr, right: Expr): DynamicValue {
  return { "@call": name, args: { left: lowerExpr(left), right: lowerExpr(right) } };
}

/**
 * 动作降级:全部变成命名事件,renderer 本地拦截(`qaqh.action.` 前缀),
 * 语义与 v0.1 Action 一致——followUp 仍走会话输入队列,不产生 toolcall。
 */
function lowerAction(action: Action): { event: { name: string; context: Record<string, DynamicValue> } } {
  switch (action.kind) {
    case "set":
      return { event: { name: "qaqh.action.set", context: { key: action.key, value: lowerExpr(action.value) } } };
    case "reset":
      return { event: { name: "qaqh.action.reset", context: {} } };
    case "append":
      return { event: { name: "qaqh.action.append", context: { key: action.key, value: lowerExpr(action.value) } } };
    case "remove":
      return { event: { name: "qaqh.action.remove", context: { key: action.key, value: lowerExpr(action.value) } } };
    case "copy":
      return { event: { name: "qaqh.action.copy", context: { value: lowerExpr(action.value) } } };
    case "openLink":
      return { event: { name: "qaqh.action.openLink", context: { url: action.url } } };
    case "followUp":
      return {
        event: {
          name: "qaqh.action.followUp",
          context: {
            prompt: action.prompt,
            fields: action.fields.map((field) => ({ label: field.label, key: field.key })),
          },
        },
      };
  }
}

function toWireComponent(ir: SurfaceIR, id: string): WireComponent {
  const node = ir.nodes[id]!;
  const wire: WireComponent = { id, component: node.type };
  for (const [name, prop] of Object.entries(node.props)) {
    if (name === "children") continue; // 容器关系走 child/children 信封,不走属性表
    wire[name] = lowerProp(prop);
  }
  const children = childListOf(node.props.children);
  if (children != null) wire.children = children;
  if (node.repeat != null) {
    wire.metadata = {
      extensions: { [REPEAT_EXTENSION]: { path: statePath(node.repeat.source), as: node.repeat.as } },
    };
  }
  return wire;
}

function lowerProp(prop: PropValue): DynamicValue | { event: { name: string; context: Record<string, DynamicValue> } } {
  switch (prop.kind) {
    case "lit":
      return prop.value;
    case "expr":
      return lowerExpr(prop.expr);
    case "binding":
      return { "@path": statePath(prop.key) };
    case "action":
      return lowerAction(prop.action);
    case "list":
      // 非 children 的 list 属性(v0.1 目录里不存在)按字面量数组降级。
      return prop.items;
    case "repeat":
      return { "@path": statePath(prop.source) };
  }
}

function childListOf(prop: PropValue | undefined): string[] | undefined {
  if (prop?.kind !== "list") return undefined;
  return prop.items;
}

/** 组装规范根:A2UI 要求 id="root" 的组件存在。 */
export function rootComponentId(ir: SurfaceIR): string {
  return ir.rootId ?? forestRoots(ir)[0] ?? "";
}

/** 包装根(Stack):包住 v0.1 的 rootId 或森林顶层,保证 wire 恒有 "root"。 */
export function translateComponents(ir: SurfaceIR): WireComponent[] {
  const components = ir.order.map((id) => toWireComponent(ir, id));
  const innerRoot = rootComponentId(ir);
  components.push({ id: "root", component: "Stack", children: innerRoot === "" ? [] : [innerRoot] });
  return components;
}
