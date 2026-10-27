/** SIWC（Sign in with ChatGPT）前端模块。
 *
 * - `brand.ts`：文案/深链/合规判定/资产探测（**唯一真源**）
 * - `state.ts`：账户与用量的视图模型（纯函数，可单测）
 * - `components/`：Solid 表现层（语义在 state.ts，本层只呈现）
 *
 * 刻意**不包含** OAuth/凭据逻辑：那在本机 daemon 的 `qaqh-siwc`（Rust）里，
 * 前端只消费 `siwc.*` 服务面方法，永不接触 token。
 */
export * from "./brand";
export * from "./state";
export { SiwcSignInButton } from "./components/SignInButton";
export { SiwcConnectionCard } from "./components/ConnectionCard";
export { SiwcPlanBadge } from "./components/PlanBadge";
export { SiwcUsageLimitNotice } from "./components/UsageLimitNotice";
export { SiwcFirstRunNotice } from "./components/FirstRunNotice";
