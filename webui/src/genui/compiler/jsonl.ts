/**
 * jsonl wire 解析(spec §7 的 jsonl 载体,原型子集):
 * 每行一个 JSON record,降低到与 tsx DSL 相同的 SurfaceIR,校验共用 validateSurface。
 * record 集合:surface.open / state / derive / node / surface.close;表达式与属性值用
 * 显式 kinded wire 对象,不接受任何 JS 语法——不可信文本只走 JSON.parse。
 * derive 在 wire 层同样按声明顺序内联(与 tsx 解析器一致,天然无环)。
 */
import {
  GenUiError, MAX_NODES,
  type Action, type Expr, type IRNode, type PropValue, type StateValue, type SurfaceIR,
} from "./ir";

type Record0 = Record<string, unknown>;
type WireCtx = { derives: Record<string, Expr> };

const BINARY_OPS = ["add", "sub", "mul", "div", "eq", "neq", "gt", "lt", "and", "or"] as const;
const ACTION_KINDS = ["set", "reset", "followUp", "copy", "openLink", "append", "remove"] as const;

function wireExpr(value: unknown, line: number, ctx: WireCtx): Expr {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { op: "lit", value };
  }
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record0;
    if ("lit" in record) {
      const lit = record.lit;
      if (typeof lit !== "string" && typeof lit !== "number" && typeof lit !== "boolean") {
        throw new GenUiError(`无法解析表达式:${JSON.stringify(value)}`, line);
      }
      return { op: "lit", value: lit };
    }
    if (typeof record.state === "string") {
      // 派生态按声明顺序内联;wire 上不出现 derive 引用。
      if (Object.hasOwn(ctx.derives, record.state)) return ctx.derives[record.state]!;
      return { op: "state", key: record.state };
    }
    if (typeof record.item === "string") return { op: "item", as: record.item };
    if ("not" in record) return { op: "not", value: wireExpr(record.not, line, ctx) };
    if (typeof record.op === "string" && (BINARY_OPS as readonly string[]).includes(record.op)) {
      return {
        op: record.op as (typeof BINARY_OPS)[number],
        left: wireExpr(record.left, line, ctx),
        right: wireExpr(record.right, line, ctx),
      };
    }
  }
  throw new GenUiError(`无法解析表达式:${JSON.stringify(value)}`, line);
}

function wireAction(value: unknown, line: number, ctx: WireCtx): Action {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record0;
    if (record.reset === true) return { kind: "reset" };
    if (typeof record.set === "string") return { kind: "set", key: record.set, value: wireExpr(record.value, line, ctx) };
    if (typeof record.copy !== "undefined" || typeof record.openLink === "string") {
      if ("copy" in record) return { kind: "copy", value: wireExpr(record.copy, line, ctx) };
      const url = record.openLink;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new GenUiError(`openLink 只允许 http(s) 链接:${String(url)}`, line);
      return { kind: "openLink", url };
    }
    if ((typeof record.append === "string" || typeof record.remove === "string")) {
      const key = (record.append ?? record.remove) as string;
      if (key === "") throw new GenUiError("append/remove 需要状态 key", line);
      return { kind: typeof record.append === "string" ? "append" : "remove", key, value: wireExpr(record.value, line, ctx) };
    }
    if (typeof record.followUp === "string") {
      const fieldsRaw = record.fields;
      if (fieldsRaw !== undefined && !Array.isArray(fieldsRaw)) throw new GenUiError("followUp fields 必须是数组", line);
      const fields = (fieldsRaw ?? []).map((item) => {
        if (item == null || typeof item !== "object" || Array.isArray(item)) throw new GenUiError("followUp 字段必须是对象", line);
        const { label, key } = item as Record0;
        if (typeof label !== "string" || typeof key !== "string" || key === "") throw new GenUiError("followUp 字段需要 label/key", line);
        return { label, key };
      });
      return { kind: "followUp", prompt: record.followUp, fields };
    }
  }
  throw new GenUiError(`无法解析动作:${JSON.stringify(value)}`, line);
}

function wireProp(value: unknown, line: number, ctx: WireCtx): PropValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "lit", value };
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string")) throw new GenUiError("children 数组必须是字符串 id", line);
    return { kind: "list", items: value as string[] };
  }
  if (value != null && typeof value === "object") {
    const record = value as Record0;
    if ("expr" in record) return { kind: "expr", expr: wireExpr(record.expr, line, ctx) };
    if ("bind" in record) {
      if (typeof record.bind !== "string" || record.bind === "") throw new GenUiError("绑定需要状态 key", line);
      return { kind: "binding", key: record.bind };
    }
    if (typeof record.source === "string" && typeof record.as === "string") {
      if (record.source === "" || record.as === "") throw new GenUiError("repeat 需要 source/as", line);
      return { kind: "repeat", source: record.source, as: record.as };
    }
    if ((ACTION_KINDS as readonly string[]).some((kind) => kind in record)) {
      return { kind: "action", action: wireAction(value, line, ctx) };
    }
    // 裸表达式 wire({state} / {lit} / {item} / {not} / {op:二元}) 直接作为 prop 值。
    if ("state" in record || "lit" in record || "item" in record || "not" in record
      || (typeof record.op === "string" && (BINARY_OPS as readonly string[]).includes(record.op))) {
      return { kind: "expr", expr: wireExpr(value, line, ctx) };
    }
  }
  throw new GenUiError(`无法解析属性值:${JSON.stringify(value)}`, line);
}

export function parseSurfaceJsonl(source: string, options: { final?: boolean } = {}): SurfaceIR {
  const states: SurfaceIR["states"] = {};
  const order: string[] = [];
  const nodes: Record<string, IRNode> = {};
  const ctx: WireCtx = { derives: {} };
  let surfaceId: string | null = null;
  let title: string | undefined;
  let fallback: string | undefined;
  let rootId: string | undefined;
  let closed = false;

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    const lineNo = index + 1;
    let record: Record0;
    try {
      record = JSON.parse(line) as Record0;
    } catch {
      // 流式容尾(final=false):最后一行只到达了半截 JSON,等下一帧补齐,
      // 不拖累已到齐的 record;final 语义不变——半截行照样具名报错。
      const isLastLine = index === lines.length - 1;
      if (options.final === false && isLastLine) break;
      throw new GenUiError(`jsonl 行不是合法 JSON:${line.slice(0, 40)}`, lineNo);
    }
    if (typeof record.op !== "string") throw new GenUiError("jsonl record 缺少 op", lineNo);
    if (closed) throw new GenUiError("surface.close 之后不允许再有 record", lineNo);
    switch (record.op) {
      case "surface.open": {
        if (surfaceId != null) throw new GenUiError("重复的 surface.open", lineNo);
        if (typeof record.surface !== "string" || record.surface === "") throw new GenUiError("surface.open 缺少 surface id", lineNo);
        surfaceId = record.surface;
        if (typeof record.root === "string") rootId = record.root;
        if (typeof record.title === "string") title = record.title;
        if (typeof record.fallback === "string") fallback = record.fallback;
        break;
      }
      case "state": {
        if (surfaceId == null) throw new GenUiError("state 必须在 surface.open 之后", lineNo);
        const key = record.key;
        const type = record.type;
        if (typeof key !== "string" || key === "") throw new GenUiError("state 缺少 key", lineNo);
        if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "list") {
          throw new GenUiError(`不支持的状态类型 ${String(type)}`, lineNo);
        }
        if (Object.hasOwn(states, key)) throw new GenUiError(`重复的状态声明 ${key}`, lineNo);
        const initial = record.initial;
        if (type === "list" ? (!Array.isArray(initial) || !initial.every((item) => typeof item === "string"))
          : type === "string" ? typeof initial !== "string"
          : type === "boolean" ? typeof initial !== "boolean"
          : typeof initial !== "number" || !Number.isFinite(initial)) {
          throw new GenUiError(`状态 ${key} 初始值与类型不符`, lineNo);
        }
        if (type === "integer" && !(typeof initial === "number" && Number.isSafeInteger(initial) && (initial as number) >= 0)) {
          throw new GenUiError("integer 初始值必须是安全整数", lineNo);
        }
        states[key] = { type, initial: initial as StateValue };
        break;
      }
      case "derive": {
        if (surfaceId == null) throw new GenUiError("derive 必须在 surface.open 之后", lineNo);
        const key = record.key;
        if (typeof key !== "string" || key === "") throw new GenUiError("derive 缺少 key", lineNo);
        if (Object.hasOwn(ctx.derives, key) || Object.hasOwn(states, key)) throw new GenUiError(`重复的声明 ${key}`, lineNo);
        ctx.derives[key] = wireExpr(record.expr, lineNo, ctx);
        break;
      }
      case "node": {
        if (surfaceId == null) throw new GenUiError("node 必须在 surface.open 之后", lineNo);
        const id = record.id;
        const component = record.component;
        const props = record.props;
        if (typeof id !== "string" || id === "") throw new GenUiError("node 缺少 id", lineNo);
        if (typeof component !== "string") throw new GenUiError("node 缺少 component", lineNo);
        if (props != null && (typeof props !== "object" || Array.isArray(props))) throw new GenUiError("node props 必须是对象", lineNo);
        if (nodes[id] != null || order.includes(id)) throw new GenUiError(`重复的节点 id ${id}`, lineNo);
        const decoded: Record<string, PropValue> = {};
        let repeat: { source: string; as: string } | undefined;
        for (const [name, value] of Object.entries((props ?? {}) as Record0)) {
          const decodedValue = wireProp(value, lineNo, ctx);
          if (name === "repeat" && decodedValue.kind === "repeat") {
            repeat = { source: decodedValue.source, as: decodedValue.as };
            continue;
          }
          decoded[name] = decodedValue;
        }
        nodes[id] = { id, type: component, props: decoded, line: lineNo, repeat };
        order.push(id);
        break;
      }
      case "surface.close": {
        if (surfaceId == null) throw new GenUiError("surface.close 必须在 surface.open 之后", lineNo);
        closed = true;
        break;
      }
      default:
        throw new GenUiError(`未知的 jsonl op:${record.op}`, lineNo);
    }
  }

  if (surfaceId == null) throw new GenUiError("jsonl 缺少 surface.open");
  // final=false(流式部分编译):允许缺 surface.close,先渲染已到齐的 record。
  if (!closed && options.final !== false) throw new GenUiError("jsonl 缺少 surface.close");
  if (order.length > MAX_NODES) throw new GenUiError(`节点数超过预算(${MAX_NODES})`);
  return { irVersion: "0.1", surfaceId, title, fallback, rootId, states, order, nodes };
}
