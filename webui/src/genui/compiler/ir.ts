/**
 * QAQH UI IR 0.1(spec-generative-ui-runtime §8,原型子集):
 * 类型区分联合、封闭 props(目录外属性一律拒绝)、纯表达式与受控动作。
 * 原型只覆盖 spec §7 内联里最小时钟配方所需的子集:
 * Card/Stack/Row/Title/Text/Metric/Badge/Button/Divider + local set/reset。
 */

export const IR_VERSION = "0.1";

export type StateType = "string" | "number" | "integer" | "boolean" | "list";
export type StateValue = string | number | boolean | string[];

/** 纯表达式:字面量、状态读取、循环变量、二元算术/拼接/比较、逻辑运算。
 *  不做 JS 隐式转换(spec §8.3);add 在字符串参与时降级为拼接。 */
export type Expr =
  | { op: "lit"; value: StateValue }
  | { op: "state"; key: string }
  | { op: "item"; as: string }
  | { op: "add" | "sub" | "mul" | "div" | "eq" | "neq" | "gt" | "lt" | "and" | "or"; left: Expr; right: Expr }
  | { op: "not"; value: Expr };

/** local 动作:只在用户事件事务中求值。followUp 把选定字段拼成聊天输入,
 * 按现有会话输入语义排队(spec §7.6:不上传完整私有状态,不用 as_system);
 * copy/openLink/append/remove 是低风险外围动作,只触碰 Surface local 状态域。 */
export type Action =
  | { kind: "set"; key: string; value: Expr }
  | { kind: "reset" }
  | { kind: "followUp"; prompt: string; fields: Array<{ label: string; key: string }> }
  | { kind: "copy"; value: Expr }
  | { kind: "openLink"; url: string }
  | { kind: "append"; key: string; value: Expr }
  | { kind: "remove"; key: string; value: Expr };

export type PropValue =
  | { kind: "lit"; value: StateValue }
  | { kind: "expr"; expr: Expr }
  | { kind: "action"; action: Action }
  | { kind: "list"; items: string[] }
  | { kind: "binding"; key: string }
  | { kind: "repeat"; source: string; as: string };

export type IRNode = { id: string; type: string; props: Record<string, PropValue>; /** 解析时的源码行号,只用于错误定位,不进 wire IR。 */ line?: number; /** for/repeat:本节点(含子树)按 list 态逐项渲染模板。 */ repeat?: { source: string; as: string } };

export type SurfaceIR = {
  irVersion: string;
  surfaceId: string;
  title?: string;
  fallback?: string;
  rootId?: string;
  states: Record<string, { type: StateType; initial: StateValue }>;
  /** 插入顺序;nodes 是 id → 节点映射。 */
  order: string[];
  nodes: Record<string, IRNode>;
  /** 编译期软告警(不阻断渲染):目前只有「孤儿节点」。空/缺省 = 无告警。 */
  warnings?: string[];
};

/** 带行号的具名错误:渲染层直接展示,不静默吞。 */
export class GenUiError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line != null ? `${message}(第 ${line} 行)` : message);
    this.name = "GenUiError";
  }
}

/** 受信组件目录(spec §5.1/§8.1):封闭 props,未知组件/属性一律拒绝。
 *  `show`(条件渲染)与 `children` 一样是所有节点可用的通用属性。
 *
 *  `string`/`number`/`boolean` 是**标量槽位**:字面量与纯表达式都收(协议对模型的
 *  描述是「属性值是字符串字面量或 {表达式}」,spec §8.3 也允许表达式);`expr`
 *  槽位反过来同样收字面量。两向放宽只影响取值形状,不放松目录封闭性——表达式仍
 *  走 checkExpr,只读 Surface local 状态域。 */
export type PropKind = "string" | "number" | "boolean" | "expr" | "action" | "list" | "binding";
const withCommon = (props: Record<string, PropKind>): Record<string, PropKind> => ({ ...props, show: "expr" });
export const CATALOG: Record<string, Record<string, PropKind>> = {
  Card: withCommon({ title: "string", children: "list" }),
  Stack: withCommon({ children: "list" }),
  Row: withCommon({ children: "list" }),
  Title: withCommon({ text: "expr" }),
  Text: withCommon({ text: "expr" }),
  Metric: withCommon({ label: "string", value: "expr" }),
  Badge: withCommon({ text: "expr" }),
  Button: withCommon({ label: "string", onPress: "action", disabled: "expr" }),
  Divider: withCommon({}),
  TextInput: withCommon({ label: "string", value: "binding", placeholder: "string", required: "expr", pattern: "string", maxLength: "number" }),
  Checkbox: withCommon({ label: "string", checked: "binding" }),
  /** todo v2:纯 chat 内容,点击只翻 Surface local 状态,不产生 toolcall。 */
  TodoList: withCommon({ title: "string", children: "list" }),
  Todo: withCommon({ text: "expr", done: "binding", meta: "expr" }),
  /** 只读展示绑定 list 态(append/remove 在别处改它)。 */
  TagList: withCommon({ items: "binding" }),
};

/** binding 属性要求的状态类型。 */
export const BINDING_TYPES: Record<string, StateType> = {
  "TextInput.value": "string",
  "Checkbox.checked": "boolean",
  "Todo.done": "boolean",
  "TagList.items": "list",
};

export const MAX_TREE_DEPTH = 16;
export const MAX_NODES = 512;

/**
 * 无 root 时的平铺集合:只返回「森林顶层」节点——没有被任何 children 引用的
 * 节点。直接按 order 平铺会把已随父节点渲染过的子树再画一遍(实测:模型省略
 * root 选项时整棵 Surface 双重渲染)。order 保序,顶层节点保持声明顺序。
 */
export function forestRoots(ir: SurfaceIR): string[] {
  const nested = new Set<string>();
  for (const id of ir.order) {
    const children = ir.nodes[id]!.props.children;
    if (children?.kind === "list") for (const child of children.items) nested.add(child);
  }
  return ir.order.filter((id) => !nested.has(id));
}

export function normalizeBindings(ir: SurfaceIR, catalog: Record<string, Record<string, PropKind>> = CATALOG): void {
  for (const id of ir.order) {
    const node = ir.nodes[id]!;
    const contract = catalog[node.type];
    if (contract == null) continue;
    for (const [name, value] of Object.entries(node.props)) {
      if (contract[name] === "binding" && value.kind === "expr" && value.expr.op === "state") {
        node.props[name] = { kind: "binding", key: value.expr.key };
      }
    }
  }
}

/**
 * 编译期软告警(不阻断渲染)。目前只有一类:**孤儿节点**。
 *
 * 有 root 时渲染器只从根往下走(无 root 才按森林顶层平铺),所以「既不是 root、
 * 也没有被任何 children 引用」的节点永远不会出现在屏幕上。实测形态是模型把
 * 循环行(repeat)声明出来了却忘了挂进根容器的 children——编译全过、界面静默
 * 少一块,比整树报错更难发现。这里只报警不报错:漏挂的节点可能是模型有意的
 * 中间态(例如后续 record 才把它挂上去),阻断渲染的代价更大。
 */
export function surfaceWarnings(ir: SurfaceIR): string[] {
  // 无 root(或 root 未到齐)时渲染器平铺森林顶层,不存在孤儿。
  if (ir.rootId == null || ir.nodes[ir.rootId] == null) return [];
  // 「未被任何 children 引用」= 森林顶层。去掉真正的 root 后剩下的就是永远
  // 渲染不到的子树根(它们的孩子由这些根带着走,不必逐个再报)。
  const referenced = new Set<string>();
  for (const id of ir.order) {
    const children = ir.nodes[id]!.props.children;
    if (children?.kind === "list") for (const child of children.items) referenced.add(child);
  }
  const orphans = ir.order.filter((id) => id !== ir.rootId && !referenced.has(id));
  if (orphans.length === 0) return [];
  const head = orphans.slice(0, 8).join("、");
  const tail = orphans.length > 8 ? ` 等 ${orphans.length} 个` : "";
  return [`节点 ${head}${tail} 未被任何 children 引用,不会渲染;补进容器的 children 或删掉声明`];
}

/** 编译期校验:目录封闭性、引用完整性、拓扑(环/深度)。 */
export function validateSurface(ir: SurfaceIR, catalog: Record<string, Record<string, PropKind>> = CATALOG, options: { partial?: boolean } = {}): void {
  const partial = options.partial === true;
  if (!ir.surfaceId) throw new GenUiError("surface 缺少 id");
  if (ir.nodes === null || typeof ir.nodes !== "object") throw new GenUiError("IR 节点缺失");
  const nodeIds = new Set(ir.order);
  if (ir.order.length > MAX_NODES) throw new GenUiError(`节点数超过预算(${MAX_NODES})`);

  for (const id of ir.order) {
    const node = ir.nodes[id]!;
    const contract = catalog[node.type];
    if (contract == null) throw new GenUiError(`未知组件类型:${node.type}`, node.line);
    for (const [name, value] of Object.entries(node.props)) {
      const kind = contract[name];
      if (kind == null) throw new GenUiError(`${node.type} 不支持属性 ${name}`, node.line);
      const fail = (): never => { throw new GenUiError(`属性 ${name} 需要 ${kind}`, node.line); };
      if (kind === "expr") {
        if (value.kind === "expr") checkExpr(value.expr, ir);
        else if (value.kind !== "lit") fail();
      } else if (kind === "string" || kind === "number" || kind === "boolean") {
        // 标量槽位:字面量与纯表达式都收(两种载体的「字面量」形状不同,语义相同)。
        // 裸字面量按类型校验——TSX 的 {1} 与 jsonl 的 1 都落到这里,拒绝也一致。
        if (value.kind === "expr") {
          checkExpr(value.expr, ir);
          if (value.expr.op === "lit" && typeof value.expr.value !== kind) fail();
        } else if (value.kind === "lit") {
          if (typeof value.value !== kind) fail();
        } else fail();
      } else if (kind === "action") {
        const hasOwn = (key: string): boolean => Object.hasOwn(ir.states, key);
        if (value.kind !== "action") fail();
        else if (value.action.kind === "set" && !hasOwn(value.action.key)) {
          throw new GenUiError(`动作引用未知状态 ${value.action.key}`, node.line);
        } else if (value.action.kind === "followUp") {
          for (const field of value.action.fields) {
            if (!hasOwn(field.key)) throw new GenUiError(`followUp 字段 ${field.label} 引用未知状态 ${field.key}`, node.line);
          }
        } else if ((value.action.kind === "append" || value.action.kind === "remove")) {
          const state = ir.states[value.action.key];
          if (state == null) throw new GenUiError(`动作引用未知状态 ${value.action.key}`, node.line);
          if (state.type !== "list") throw new GenUiError(`append/remove 需要 list 型状态 ${value.action.key}`, node.line);
        }
      } else if (kind === "list") {
        if (value.kind !== "list") fail();
        else if (partial) {
          // 流式部分编译:children 前向引用可能未到齐,先剪掉等下一帧补齐。
          value.items = value.items.filter((child) => nodeIds.has(child));
        } else {
          for (const child of value.items) {
            if (!nodeIds.has(child)) throw new GenUiError(`children 引用未知节点 ${child}`, node.line);
          }
        }
      } else if (kind === "binding") {
        if (value.kind !== "binding") {
          throw new GenUiError(`属性 ${name} 需要 binding(用 ui.bind("key") 或直接写 {状态名})`, node.line);
        } else {
          const state = ir.states[value.key];
          if (state == null) throw new GenUiError(`绑定引用未知状态 ${value.key}`, node.line);
          const expected = BINDING_TYPES[`${node.type}.${name}`];
          if (expected != null && state.type !== expected) {
            throw new GenUiError(`绑定 ${value.key} 需要 ${expected} 型状态`, node.line);
          }
        }
      }
    }
  }

  if (ir.rootId != null && (nodeIds.has(ir.rootId) || !partial)) {
    if (!nodeIds.has(ir.rootId)) throw new GenUiError(`root 引用未知节点 ${ir.rootId}`);
  } else if (partial) {
    ir.rootId = undefined; // 流式:root 指向的节点未到齐时先平铺,等补齐再按 root 渲染
  }

  // for/repeat:source 必须是 list 态;循环变量不得与状态同名。
  const hasState = (key: string): boolean => Object.hasOwn(ir.states, key);
  for (const id of ir.order) {
    const repeat = ir.nodes[id]!.repeat;
    if (repeat == null) continue;
    const state = ir.states[repeat.source];
    if (partial && (state == null || state.type !== "list")) continue; // 流式:数据源未到齐,先跳过
    if (state == null) throw new GenUiError(`repeat 引用未知状态 ${repeat.source}`, ir.nodes[id]!.line);
    if (state.type !== "list") throw new GenUiError(`repeat 需要 list 型状态 ${repeat.source}`, ir.nodes[id]!.line);
    if (hasState(repeat.as)) throw new GenUiError(`循环变量 ${repeat.as} 与状态同名`, ir.nodes[id]!.line);
  }

  // 环与深度:对全部节点做 DFS(纯环节点没有外部引用者,不能只从根出发)。
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new GenUiError(`children 形成环:${id}`, ir.nodes[id]?.line);
    if (depth > MAX_TREE_DEPTH) throw new GenUiError(`节点树深度超过 ${MAX_TREE_DEPTH}`, ir.nodes[id]?.line);
    visiting.add(id);
    const children = ir.nodes[id]!.props.children;
    if (children?.kind === "list") for (const child of children.items) visit(child, depth + 1);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ir.order) visit(id, 1);
}

function checkExpr(expr: Expr, ir: SurfaceIR): void {
  switch (expr.op) {
    case "lit": return;
    case "state":
      if (!Object.hasOwn(ir.states, expr.key)) throw new GenUiError(`表达式引用未知状态 ${expr.key}`);
      return;
    case "item": return; // 循环变量:作用域在渲染期检查
    case "not":
      checkExpr(expr.value, ir);
      return;
    default:
      checkExpr(expr.left, ir);
      checkExpr(expr.right, ir);
  }
}
