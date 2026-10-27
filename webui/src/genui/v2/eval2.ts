/**
 * DynamicValue 求值器:A2UI wire 的属性值 → 运行期 JSON 值。
 *
 * 三元:字面量 | {"@path"}(JSON Pointer,绝对路径进 dataModel,相对路径指
 * 模板项本身) | {"@call"}(catalog 白名单函数)。qaqh 内置函数族:
 *  - qaqh:arith.add/sub/mul/div(v0.1 表达式的降级落点;add 保持字符串拼接语义)
 *  - qaqh:logic.eq/neq/gt/lt/and/or/not
 *  - @index(模板项下标,系统函数;offset 可调)
 * v0.1 的纯表达式解释器(eval.ts)语义在这里 1:1 保留,只是载体从表达式 AST
 * 变成 catalog 函数调用。
 */

import { pointerGet } from "./dataModel";
import { A2uiError, type DynamicValue, type FunctionCall, type JsonValue } from "./types";

/** 模板项作用域:@index 与相对 @path 的解析上下文。 */
export interface TemplateScope {
  index: number;
  /** 当前项的值(v0.1 的 list 态是 string[],项即字符串;v0.2 放开为任意 JSON)。 */
  value: JsonValue;
}

export type FunctionRegistry = ReadonlyMap<string, (args: Record<string, JsonValue | undefined>, scope: TemplateScope | null) => JsonValue>;

/** 内置函数族:名字对齐 v0.1 eval.ts 的语义(含 add 拼接降级、严格数字运算)。 */
export const BUILTIN_FUNCTIONS: FunctionRegistry = new Map([
  ["qaqh:arith.add", (args) => {
    const { left, right } = args;
    if (typeof left === "string" || typeof right === "string") return display(left) + display(right);
    return arith(left, right, "+");
  }],
  ["qaqh:arith.sub", (args) => arith(args.left, args.right, "-")],
  ["qaqh:arith.mul", (args) => arith(args.left, args.right, "*")],
  ["qaqh:arith.div", (args) => arith(args.left, args.right, "/")],
  ["qaqh:logic.eq", (args) => args.left === args.right],
  ["qaqh:logic.neq", (args) => args.left !== args.right],
  ["qaqh:logic.gt", (args) => strictNumber(args.left, "gt") > strictNumber(args.right, "gt")],
  ["qaqh:logic.lt", (args) => strictNumber(args.left, "lt") < strictNumber(args.right, "lt")],
  ["qaqh:logic.and", (args) => truthy(args.left) && truthy(args.right)],
  ["qaqh:logic.or", (args) => truthy(args.left) || truthy(args.right)],
  ["qaqh:logic.not", (args) => !truthy(args.value)],
]);

/** 求值入口。抛 A2uiError 的场景:未知函数/函数缺 @call/@path 非法/未知路径。 */
export function resolveDynamic(
  value: DynamicValue | undefined,
  model: { [key: string]: JsonValue },
  scope: TemplateScope | null,
  functions: FunctionRegistry = BUILTIN_FUNCTIONS,
): JsonValue {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => resolveDynamic(item as DynamicValue, model, scope, functions));
  if (typeof value !== "object") return value;
  if ("@path" in value) {
    const pointer = (value as { "@path": string })["@path"];
    // 相对路径(不以 / 开头)指模板项本身;"" 即项的整值。
    if (!pointer.startsWith("/")) {
      if (scope == null) throw new A2uiError(`相对路径 ${pointer} 只能在模板项作用域内使用`);
      return relativeGet(scope.value, pointer);
    }
    return pointerGet(model, pointer) ?? null;
  }
  if ("@call" in value) return callFunction(value as FunctionCall, model, scope, functions);
  // 普通对象字面量:逐值递归(A2UI 允许 context 里的对象携带动态值)。
  const resolved: { [key: string]: JsonValue } = {};
  for (const [key, member] of Object.entries(value)) {
    resolved[key] = resolveDynamic(member as DynamicValue, model, scope, functions);
  }
  return resolved;
}

function callFunction(call: FunctionCall, model: { [key: string]: JsonValue }, scope: TemplateScope | null, functions: FunctionRegistry): JsonValue {
  const name = call["@call"];
  if (name === "@index") {
    if (scope == null) throw new A2uiError("@index 只能在模板项作用域内使用");
    const offset = call.args?.offset;
    const base = typeof offset === "number" ? offset : 0;
    return scope.index + base;
  }
  const implementation = functions.get(name);
  if (implementation == null) throw new A2uiError(`未知函数 ${name}(catalog 未注册)`);
  const args: Record<string, JsonValue> = {};
  for (const [key, arg] of Object.entries(call.args ?? {})) {
    args[key] = resolveDynamic(arg as DynamicValue, model, scope, functions);
  }
  return implementation(args, scope);
}

/** 相对 JSON Pointer:首段在项(字符串/数组/对象)上取;空串 = 项本身。 */
function relativeGet(item: JsonValue, pointer: string): JsonValue {
  if (pointer === "") return item;
  const segments = pointer.replace(/^\//, "").split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: JsonValue = item;
  for (const segment of segments) {
    if (current != null && typeof current === "object" && !Array.isArray(current) && Object.hasOwn(current, segment)) {
      current = (current as { [key: string]: JsonValue })[segment]!;
    } else {
      throw new A2uiError(`模板项上解析相对路径失败:${pointer}`);
    }
  }
  return current;
}

function truthy(value: JsonValue | undefined): boolean {
  return value !== false && value !== 0 && value !== "" && value != null;
}

function display(value: JsonValue | undefined): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map(display).join("、");
  return value == null ? "" : String(value);
}

function strictNumber(value: JsonValue | undefined, op: string): number {
  if (typeof value !== "number") throw new A2uiError(`qaqh:logic.${op} 只接受数字`);
  return value;
}

function arith(left: JsonValue | undefined, right: JsonValue | undefined, op: string): JsonValue {
  if (typeof left !== "number" || typeof right !== "number") throw new A2uiError(`qaqh:arith.${op} 只接受数字`);
  const result = op === "+" ? left + right : op === "-" ? left - right : op === "*" ? left * right : left / right;
  if (!Number.isFinite(result)) throw new A2uiError(`qaqh:arith.${op} 结果非有限数`);
  return result;
}
