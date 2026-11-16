/**
 * 壳的构建标识,供设置页「关于」显示。
 *
 * 版本固定取 package.json(4.0.0),不再拼接 git commit / 日期。
 * 浏览器夹具没有壳进程,所以那里返回 `unavailable` 而不是编一个假版本号——这块 UI
 * 存在的意义就是「别把旧包当成新构建」,宁可显式缺。
 */
import { invoke } from "./host";
import { isDesktopRuntime } from "./transport";

export interface BuildInfo {
  /** 固定版本号(4.0.0)。 */
  display: string;
  version: string;
  commit: string;
  unavailable: boolean;
}

const UNAVAILABLE: BuildInfo = { display: "", version: "", commit: "", unavailable: true };

export async function loadBuildInfo(): Promise<BuildInfo> {
  if (!isDesktopRuntime()) return UNAVAILABLE;
  const info = await invoke<Omit<BuildInfo, "unavailable">>("app_version");
  return { ...info, unavailable: false };
}
