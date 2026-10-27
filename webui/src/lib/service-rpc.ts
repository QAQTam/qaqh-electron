/**
 * 服务面 RPC 的**唯一**壳命令入口。
 *
 * 前端能调哪些 daemon 方法由**两层**决定，两处都要加才通：
 *  1. daemon 的方法表（`qaqh-runtime/src/ringing/service_methods.rs`，含 scope 档）；
 *  2. 桌面壳的白名单（`src-tauri/src/commands.rs::SERVICE_METHODS`）——它的存在是为了
 *     让「前端能调哪些 daemon 方法」可审计，而不是靠约定。
 *
 * 抽到这里的原因：`siwc.ts` 与 `dsaccount.ts` 各自写一份 `invoke` 包装，迟早会出现
 * 「一个改了错误文案、另一个没改」这类漂移。
 */
import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "./transport/backend";

/** 发一条服务面请求。`feature` 只用于浏览器预览下的错误文案。 */
export function serviceRpc<T>(
  feature: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error(`${feature} 需要桌面壳：浏览器预览下不可用`);
  }
  return invoke<T>("service_rpc", { method, params });
}

/** 用**系统浏览器**打开 URL（壳侧只放行 http/https）。 */
export { openExternalUrl } from "./transport";
