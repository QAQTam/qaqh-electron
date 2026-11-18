/**
 * 转录密度档（借 zcode 的分层纪律，但只做两档，不做"图标行"极端档——
 * 摘要行是本项目工具行的本体，砍掉就砍掉了 semanticLabel/paths 的全部设计）。
 *
 * comfortable：聚合阈值 3（默认）。
 * compact：聚合阈值 2 + 行距收紧（CSS 走 html[data-density]）。
 * 偏好走 `lib/prefs` 唯一通道（桌面 prefs.json，测试环境回落 localStorage）。
 */
import { createSignal } from "solid-js";
import { prefGet, prefSet } from "./prefs";

export type Density = "comfortable" | "compact";

const KEY = "qaqh.ui.density";

function read(): Density {
  return prefGet(KEY) === "compact" ? "compact" : "comfortable";
}

const [density, setDensity] = createSignal<Density>(read());
if (typeof document !== "undefined") document.documentElement.dataset.density = density();

export function toggleDensity(): Density {
  const next: Density = density() === "comfortable" ? "compact" : "comfortable";
  setDensity(next);
  prefSet(KEY, next);
  if (typeof document !== "undefined") document.documentElement.dataset.density = next;
  return next;
}

export const currentDensity = density;

/** 聚合条最少连续同类步数：compact 收得更紧。 */
export const aggMinRun = (): number => (density() === "compact" ? 2 : 3);
