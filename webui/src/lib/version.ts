/**
 * 壳的构建标识(版本 + git commit),供设置页「关于」显示。
 *
 * 浏览器夹具没有壳进程,所以那里返回 `unavailable` 而不是编一个假版本号——这块 UI
 * 存在的意义就是「别把旧包当成新构建」,宁可显式缺。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./transport";

export interface BuildInfo {
  /** `2.0.0-beta.4-<短 sha>`,脏工作树再缀 `-dirty`。 */
  display: string;
  version: string;
  commit: string;
  unavailable: boolean;
}

const UNAVAILABLE: BuildInfo = { display: "", version: "", commit: "", unavailable: true };

export async function loadBuildInfo(): Promise<BuildInfo> {
  if (!isTauriRuntime()) return UNAVAILABLE;
  const info = await invoke<Omit<BuildInfo, "unavailable">>("app_version");
  return { ...info, unavailable: false };
}
