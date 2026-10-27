/**
 * DeepSeek 账号的**视图推导与金额格式化**（纯函数，脱浏览器可测）。
 *
 * 后端投影形状（`qaqh-runtime/src/service.rs` 的 `dsaccount.*` 分支；**camelCase**
 * 是转发层归一后的服务面约定；`account` 里的字段来自 crate 的 `to_public_json`，
 * 保持 snake_case）：
 * ```
 * { signedIn, account: {user_id,label,provider,currency,inference_origin,saved_at_ms,has_credential} | null,
 *   storageError: string | null, inferenceOrigin, usageUrl, topUpUrl,
 *   flow: { attemptId, state, authorizeUrl, expiresAtMs, error } }
 * ```
 * 结构上**不含凭据**（后端在类型层就不下发，见 `qaqh_dsaccount::StoredAccount::to_public_json`）。
 *
 * 两条纪律：
 *  - 「本地凭据损坏」（`storage_error`）不是「未登录」：前者要提示重新登录，
 *    后者显示一个干净的空态就行——混淆会让用户以为自己的账号掉了。
 *  - 金额解析不出来时**不假装是 0**：原样显示。
 */

/** 登录尝试的状态（与 `qaqh_dsaccount::FlowState::wire` 同源）。 */
export type DsFlowState =
  | "idle"
  | "authorizing"
  | "exchanging"
  | "signed-in"
  | "failed"
  | "cancelled";

export interface DsFlowProjection {
  attemptId: string | null;
  state: DsFlowState;
  authorizeUrl: string | null;
  expiresAtMs: number;
  error: string | null;
}

export interface DsAccountProfile {
  user_id: string;
  label: string;
  provider: string | null;
  currency: string | null;
  inference_origin: string;
  saved_at_ms: number;
  has_credential: boolean;
}

export interface DsAccountStatus {
  signedIn: boolean;
  account: DsAccountProfile | null;
  storageError: string | null;
  inferenceOrigin: string;
  /** 用量明细深链（后端给，前端不拼）。 */
  usageUrl: string;
  /** 充值深链。 */
  topUpUrl: string;
  flow: DsFlowProjection;
  /** 远端撤销的结局（daemon 内存态；daemon 重启即回到 `idle`）。 */
  revoke?: DsRevoke;
}

/**
 * 断开连接时那次**向上声明注销**的结果。
 *
 * 本地断开是即时的、也是权威的；远端那次 POST 只是告诉平台"这个应用的授权不要了"。
 * 它可能失败，而失败时官网仍会列着这个应用——所以这条状态必须能透到界面。
 */
export interface DsRevoke {
  state: "idle" | "running" | "done" | "failed";
  /** 已经发出的尝试次数。 */
  attempts: number;
  /** 最近一次失败的可展示文案。 */
  message: string | null;
}

/**
 * `dsaccount.verify` 的结果：凭据**现在**还有效吗。
 *
 * 这是唯一能回答那个问题的动作——本地有密文不等于凭据有效（平台侧撤销之后，
 * 本地仍然是"已登录"的样子，直到验证或下一次真实请求失败）。
 */
export interface DsVerifyResult {
  valid: boolean;
  /** 失败原因（端点不可用、凭据失效都会填）。 */
  reason: string | null;
  /** 是否因为判为失效而**已经清掉本地凭据**（后端做的决定）。 */
  cleared: boolean;
}

export type DsAccountViewKind =
  | "loading"
  | "signed-out"
  | "connecting"
  | "signed-in"
  | "damaged";

export interface DsAccountView {
  kind: DsAccountViewKind;
  title: string;
  subtitle: string;
  /** 可展示的失败原因（登录失败、上一次尝试失败、凭据损坏）。 */
  error: string | null;
  canSignIn: boolean;
  canCancel: boolean;
  canSignOut: boolean;
  /** 已登录时给 UI 的展示名（昵称优先，退回账号 ID 前缀）。 */
  displayName: string | null;
}

/** 进行中（UI 显示等待态并允许取消）。 */
export function dsFlowRunning(state: DsFlowState): boolean {
  return state === "authorizing" || state === "exchanging";
}

/**
 * 「远端撤销」这一列的字：**只在最终没成功时**说话。
 *
 * 成功无话可说；进行中也不该刷屏（用户刚点了断开，界面先说"已断开"才对）。只有
 * "重试到头还是没成功"必须说清——因为那时官网上仍会看到本应用的授权，而界面
 * 不能显得比事实更干净。
 */
export function dsRevokeNotice(revoke: DsRevoke | null | undefined): string | null {
  if (revoke == null || revoke.state !== "failed") return null;
  const tried = revoke.attempts > 0 ? `（已重试 ${revoke.attempts} 次）` : "";
  const reason =
    revoke.message == null || revoke.message === "" ? "" : `：${revoke.message}`;
  return `远端授权撤销未完成${tried}${reason}——官网上可能仍显示本应用的授权。`;
}

/**
 * 「验证」结果怎么说话：**有效时不出字**（用户刚点完，界面不必复述成功），
 * 只有失效、或"端点不可用但没清凭据"才说话——后者必须点明**没有清**，
 * 否则用户会白去重新登录一次。
 */
export function dsVerifyNotice(result: DsVerifyResult | null | undefined): string | null {
  if (result == null || result.valid) return null;
  const reason = result.reason == null || result.reason === "" ? "" : `：${result.reason}`;
  return result.cleared
    ? `凭据已失效，本机凭据已清除，请重新登录${reason}`
    : `凭据验证失败（**未**清除本地凭据：可能只是端点/网络问题）${reason}`;
}

/**
 * 卡片**正面**那一行账号态：不用翻面就知道登录没。
 *
 * 「已登录」的判据是**本地有凭据**——它不等于凭据有效（见 [`dsVerifyNotice`]）：
 * 平台侧撤销之后本地仍会是这个状态，直到验证或下一次真实请求失败。
 */
export function dsFrontAccountState(status: DsAccountStatus | null): string {
  if (status == null) return "账号：读取中…";
  if (status.signedIn) return `账号：已登录（${dsAccountView(status).displayName ?? "已连接"}）`;
  return "账号：未登录";
}

/**
 * 状态 → 视图。分支顺序即优先级：
 * 进行中 > 已登录（带上一次失败提示）> 凭据损坏 > 未登录。
 *
 * 「已登录」优先于「上一次尝试失败」：一次失败的**新**登录不该让已经能用的
 * 账号看起来坏了——失败只作为一行提示带出来。
 */
export function dsAccountView(status: DsAccountStatus | null): DsAccountView {
  if (status == null) {
    return {
      kind: "loading",
      title: "DeepSeek 账号",
      subtitle: "正在读取账号状态…",
      error: null,
      canSignIn: false,
      canCancel: false,
      canSignOut: false,
      displayName: null,
    };
  }

  const flow = status.flow;
  if (dsFlowRunning(flow.state)) {
    return {
      kind: "connecting",
      title: "等待浏览器授权",
      subtitle: "请在系统浏览器里完成 DeepSeek 账号授权，这个页面会自动更新。",
      error: flow.error,
      canSignIn: false,
      canCancel: true,
      canSignOut: false,
      displayName: null,
    };
  }

  if (status.signedIn) {
    const account = status.account;
    return {
      kind: "signed-in",
      title: displayName(account),
      subtitle: "用本机 DeepSeek 账号余额完成推理，无需配置 API key。",
      error: flow.state === "failed" || flow.state === "cancelled" ? flow.error : null,
      canSignIn: false,
      canCancel: false,
      canSignOut: true,
      displayName: displayName(account),
    };
  }

  if (status.storageError != null && status.storageError.trim() !== "") {
    return {
      kind: "damaged",
      title: "本地凭据已损坏",
      subtitle: "需要重新登录 DeepSeek 账号（本地凭据文件读不出来，自动恢复不了）。",
      error: status.storageError,
      canSignIn: true,
      canCancel: false,
      canSignOut: true,
      displayName: null,
    };
  }

  const failed = flow.state === "failed" || flow.state === "cancelled";
  return {
    kind: "signed-out",
    title: "DeepSeek 账号",
    subtitle: "用你的 DeepSeek 账号余额完成推理：在系统浏览器里授权一次即可。",
    error: failed ? flow.error : null,
    canSignIn: true,
    canCancel: false,
    canSignOut: false,
    displayName: null,
  };
}

function displayName(account: DsAccountProfile | null): string {
  if (account == null) return "DeepSeek 账号";
  const label = account.label.trim();
  if (label !== "") return label;
  const id = account.user_id.trim();
  return id === "" ? "DeepSeek 账号" : `DeepSeek 账号 ${id.slice(0, 8)}`;
}

/**
 * 金额展示。
 *
 * 平台用 big.js 语法（`0E-16`、`12.3400000000000000`、`1e+3`），所以：
 *  - 能解析 → 两位小数（展示口径，**不是**记账口径）；
 *  - 解析不出 → **原样返回**（宁可显示一个看不懂的串，也不编一个 0 出来）。
 */
export function formatAmount(raw: string | null | undefined): string {
  if (raw == null || raw.trim() === "") return "—";
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  return value.toFixed(2);
}

/** 该金额是否为正（用于「能不能用」这类提示；解析不出时返回 `null` 而不是 false）。 */
export function isPositive(raw: string | null | undefined): boolean | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value > 0;
}
