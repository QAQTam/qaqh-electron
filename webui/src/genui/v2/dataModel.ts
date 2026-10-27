/**
 * RFC 6901 JSON Pointer：A2UI dataModel 的寻址方式(spec updateDataModel.path、
 * DataBinding["@path"])。实现 get/set/remove 三件套;set 自动创建中间容器。
 *
 * 转义:指针段里的 `~` → `~0`、`/` → `~1`(RFC 6901 §4)。
 */

import { A2uiError, type JsonValue } from "./types";

/** 解析指针为段数组。空串 = 整个文档;非空必须以 `/` 开头。 */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new A2uiError(`非法 JSON Pointer(必须以 / 开头):${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** 按指针取值;路径不存在返回 undefined(绑定解析层决定如何降级)。 */
export function pointerGet(model: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue = model;
  for (const segment of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index]!;
    } else if (current != null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as { [key: string]: JsonValue })[segment]!;
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 按指针写入;中间容器自动创建(对象键或数组下标)。数组下标只允许 ==
 * 当前长度(追加)——A2UI 的 updateDataModel 是状态同步语义,不做稀疏数组。
 */
export function pointerSet(model: { [key: string]: JsonValue }, pointer: string, value: JsonValue): void {
  const segments = parsePointer(pointer);
  if (segments.length === 0) {
    throw new A2uiError("指针为空时请直接替换整个 dataModel,不走 pointerSet");
  }
  let current: JsonValue = model;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    current = descend(current, segment, segments[i + 1]!);
  }
  const leaf = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    const index = Number(leaf);
    if (!Number.isInteger(index) || index < 0 || index > current.length) {
      throw new A2uiError(`数组下标越界:${pointer}`);
    }
    if (index === current.length) current.push(value);
    else current[index] = value;
    return;
  }
  (current as { [key: string]: JsonValue })[leaf] = value;
}

/** 按指针删除(协议:value: null 的语义)。路径不存在是 no-op(幂等)。 */
export function pointerRemove(model: { [key: string]: JsonValue }, pointer: string): void {
  const segments = parsePointer(pointer);
  if (segments.length === 0) {
    throw new A2uiError("不能删除整个 dataModel(deleteSurface 负责它)");
  }
  let current: JsonValue = model;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = pointerPeek(current, segments[i]!);
    if (next == null) return; // 上游就不存在:无处可删,幂等返回
    current = next;
  }
  const leaf = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    const index = Number(leaf);
    if (Number.isInteger(index) && index >= 0 && index < current.length) current.splice(index, 1);
    return;
  }
  if (current != null && typeof current === "object" && Object.hasOwn(current, leaf)) {
    delete (current as { [key: string]: JsonValue })[leaf];
  }
}

function pointerPeek(current: JsonValue, segment: string): JsonValue | undefined {
  if (Array.isArray(current)) {
    const index = Number(segment);
    return Number.isInteger(index) && index >= 0 && index < current.length ? current[index] : undefined;
  }
  if (current != null && typeof current === "object" && Object.hasOwn(current, segment)) {
    return (current as { [key: string]: JsonValue })[segment];
  }
  return undefined;
}

/** 沿途自动建容器:下一段像数组下标就建数组,否则建对象。 */
function descend(current: JsonValue, segment: string, nextSegment: string): JsonValue {
  const existing = pointerPeek(current, segment);
  if (existing != null && typeof existing === "object") return existing;
  const created: JsonValue = /^\d+$/.test(nextSegment) ? [] : {};
  if (Array.isArray(current)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || index > current.length) {
      throw new A2uiError(`数组下标越界:/${segment}`);
    }
    if (index === current.length) current.push(created);
    else current[index] = created;
  } else {
    (current as { [key: string]: JsonValue })[segment] = created;
  }
  return created;
}
