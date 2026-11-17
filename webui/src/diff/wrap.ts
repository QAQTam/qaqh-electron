/**
 * Diff 自动换行偏好(审查抽屉与内联 diff 共用同一份,DiffFileView 是唯一渲染点)。
 *
 * 默认开:审查抽屉是阅读面不是编辑器,横向滚动打断逐行核对;换行后行号/符号列
 * 不动,长行(压缩产物、超长字符串字面量)在内容列内折行,继续沿着 gutter 扫读。
 * 持久化走壳层偏好("qaqh.diff.wrap","0"=关),与 RAIL_MANUAL_KEY 同一通道。
 */
import { createSignal } from "solid-js";
import { prefGet, prefSet } from "../lib/prefs";

const KEY = "qaqh.diff.wrap";

export const [diffWrap, setDiffWrap] = createSignal<boolean>(prefGet(KEY) !== "0");

export const toggleDiffWrap = (): void => {
  setDiffWrap((value) => {
    prefSet(KEY, value ? "0" : "1");
    return !value;
  });
};
