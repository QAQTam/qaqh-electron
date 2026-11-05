/**
 * 首次引导的门：只读 `profiles.toml`，不新增后端标志。
 *
 * 「没有可用配置」= 没有默认存档 / 没有存档 / 默认存档指向不存在的条目 /
 * 存档没模型 / 服务商没端点。命中任何一条就展示全屏引导；用户在本次会话点过
 * 「稍后设置」后不再打扰，下次启动仍会检查。
 *
 * 刻意**不**校验 BYOK 密钥是否存在：本地 Ollama 之类端点本来就可以无密钥，
 * 而远端端点缺密钥与填错密钥一样，只有真发请求才知道——静态判定只会把合法
 * 配置判死。
 *
 * 写口（设置页、接入页、引导自身）成功后都会 `notifyConfigChanged`，App 订阅后
 * 重新检查 —— 所以配置一落地遮罩就自己消失，不靠 toast 或刷新页面。
 */
import { createSignal } from "solid-js";

import {
  refreshRegistry,
  registry,
  registryError,
  type Registry,
} from "../settings/registry";

const [checked, setChecked] = createSignal(false);
const [dismissed, setDismissed] = createSignal(false);
const [unavailable, setUnavailable] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

function needsSetup(value: Registry): boolean {
  return !value.providers.some((provider) => provider.baseUrl.trim() !== "" && provider.models.some((model) => model.definition.enabled));
}

/** 读一次名录并更新门状态。读取失败不弹引导（可能只是断线，而不是没配置）。 */
export async function refreshOnboarding(): Promise<void> {
  await refreshRegistry();
  const value = registry();
  if (value == null) {
    setUnavailable(false);
    setError(registryError());
    setChecked(true);
    return;
  }
  setUnavailable(needsSetup(value));
  setError(null);
  setChecked(true);
}

/** 「稍后设置」只作用于本次会话。 */
export function dismissOnboarding(): void {
  setDismissed(true);
}

export const onboardingVisible = (): boolean =>
  checked() && unavailable() && !dismissed();

export const onboardingError = error;

/** 引导自己的写成功时清掉一次性的错误提示（门会在刷新后自行关闭）。 */
export function clearOnboardingError(): void {
  setError(null);
}
