/**
 * 纯表达式求值(spec §8.3,原型子集):
 *  - 数字运算带类型与安全整数检查,不做 JS 隐式转换;
 *  - add 在任一操作数为字符串时降级为拼接(布尔/数组经 display 收敛);
 *  - 比较 eq/neq 严格相等、gt/lt 仅数字;and/or 短路、not 取反,统一产出布尔;
 *  - item 是 for/repeat 的循环变量,只在与渲染作用域同名时可见。
 * 除零/类型不匹配抛具名错误,由渲染层局部展示。
 */
import { GenUiError, type Expr, type StateValue } from "../compiler/ir";

export type ItemScope = { as: string; value: StateValue };

const truthy = (value: StateValue): boolean => value !== false && value !== 0 && value !== "";

const display = (value: StateValue): string => (typeof value === "boolean" ? (value ? "是" : "否") : Array.isArray(value) ? value.join("、") : String(value));

export function evaluate(expr: Expr, states: Record<string, StateValue>, item?: ItemScope): StateValue {
  switch (expr.op) {
    case "lit":
      return expr.value;
    case "state": {
      const value = states[expr.key];
      if (value === undefined) throw new GenUiError(`状态 ${expr.key} 不存在`);
      return value;
    }
    case "item": {
      if (item != null && item.as === expr.as) return item.value;
      throw new GenUiError(`循环变量 ${expr.as} 不在当前作用域`);
    }
    case "not":
      return !truthy(evaluate(expr.value, states, item));
    case "and": {
      if (!truthy(evaluate(expr.left, states, item))) return false;
      return truthy(evaluate(expr.right, states, item));
    }
    case "or": {
      if (truthy(evaluate(expr.left, states, item))) return true;
      return truthy(evaluate(expr.right, states, item));
    }
    case "eq":
      return evaluate(expr.left, states, item) === evaluate(expr.right, states, item);
    case "neq":
      return evaluate(expr.left, states, item) !== evaluate(expr.right, states, item);
    case "gt":
    case "lt": {
      const left = evaluate(expr.left, states, item);
      const right = evaluate(expr.right, states, item);
      if (typeof left !== "number" || typeof right !== "number") throw new GenUiError("大小比较只接受数字");
      return expr.op === "gt" ? left > right : left < right;
    }
    default: {
      const left = evaluate(expr.left, states, item);
      const right = evaluate(expr.right, states, item);
      if (expr.op === "add" && (typeof left === "string" || typeof right === "string")) {
        return display(left) + display(right);
      }
      if (typeof left !== "number" || typeof right !== "number") {
        throw new GenUiError("算术表达式只接受数字");
      }
      const result = expr.op === "add" ? left + right
        : expr.op === "sub" ? left - right
        : expr.op === "mul" ? left * right
        : right === 0 ? (() => { throw new GenUiError("除零"); })() : left / right;
      if (!Number.isFinite(result)) {
        throw new GenUiError("数值超出安全范围");
      }
      // 整数运算必须保持安全整数;浮点只要求有限。
      if (Number.isSafeInteger(left) && Number.isSafeInteger(right) && !Number.isSafeInteger(result)) {
        throw new GenUiError("整数运算溢出");
      }
      return result;
    }
  }
}
