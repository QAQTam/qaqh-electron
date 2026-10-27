/** 编译入口:源码 → 校验过的 SurfaceIR。任何一步失败抛 GenUiError(带行号)。 */
export { parseSurface } from "./parse";
export { parseSurfaceJsonl } from "./jsonl";
export { validateSurface, surfaceWarnings, GenUiError, IR_VERSION, CATALOG, BINDING_TYPES } from "./ir";
export type { SurfaceIR, IRNode, Expr, Action, PropValue, StateValue, StateType } from "./ir";

import { parseSurface } from "./parse";
import { parseSurfaceJsonl } from "./jsonl";
import { CATALOG, normalizeBindings, surfaceWarnings, validateSurface, type SurfaceIR } from "./ir";

export function compileSurface(
  source: string,
  format: "tsx" | "jsonl" = "tsx",
  options: { final?: boolean } = {},
): SurfaceIR {
  const final = options.final !== false;
  // 流式部分编译(final=false):允许缺 ui.end/surface.close,children 前向引用
  // 剪枝——未闭合围栏先渲染已到齐的行,闭合后整帧转正(seal 语义不变)。
  const ir = format === "jsonl" ? parseSurfaceJsonl(source, { final }) : parseSurface(source, { final });
  normalizeBindings(ir);
  validateSurface(ir, CATALOG, { partial: !final });
  // 软告警只在 seal(整帧转正)后算:流式途中节点还没挂上容器属于正常中间态。
  const warnings = final ? surfaceWarnings(ir) : [];
  if (warnings.length > 0) ir.warnings = warnings;
  return ir;
}
