/**
 * DeepSeek 账号登录的**流程驱动**（纯逻辑，依赖全部注入）。
 *
 * 为什么单独一个模块而不是塞进 `lib/dsaccount.ts`：轮询最容易出的问题是
 * **静默挂死**（等一个永远不会来的终态），而那段逻辑在 UI 里没法测。这里不 import
 * 任何壳 API（tauri/transport 都不碰），所以单测可以直接跑真驱动。
 */

/** 开工返回（与 daemon `dsaccount.sign_in.start` 的响应一致）。 */
export interface DsSignInStart {
  attemptId: string;
  /** 必须由宿主用**系统浏览器**打开，不得内嵌 webview。 */
  authorizeUrl: string;
  redirectUri: string;
  expiresIn: number;
}

/** 轮询到的流程投影（服务面 camelCase）。 */
export interface DsFlowSnapshot {
  attemptId: string | null;
  state: "idle" | "authorizing" | "exchanging" | "signed-in" | "failed" | "cancelled";
  error: string | null;
}

export type DsSignInOutcome =
  | { kind: "completed" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "superseded" };

/** 可注入的依赖：登录流程的全部外部动作。 */
export interface DsSignInDeps {
  start: (options: { locale?: string; port?: number }) => Promise<DsSignInStart>;
  status: () => Promise<DsFlowSnapshot>;
  cancel: (attemptId: string) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** 授权窗口失去响应后的宽限（daemon 侧的 TTL 来自平台的 `expires_in`）。 */
const GRACE_MS = 15_000;

/**
 * 完整登录流程：开工 → 开系统浏览器 → 轮询到终态。
 *
 * 与 SIWC 那条的两处**必须不同**：
 *  - 状态查询不带参数（本机同时只有一次尝试），所以靠 `attemptId` 比对认出
 *    「被新一次登录顶掉了」——这正是 `superseded`；
 *  - 终态多了 `cancelled`（用户在浏览器里拒绝授权，或本地取消）。
 */
export async function runDeepSeekSignIn(
  options: {
    locale?: string;
    port?: number;
    /** 轮询间隔；测试里传 0。 */
    pollMs?: number;
    /** 开工后立刻回调 attemptId——UI 的「取消登录」需要它。 */
    onStarted?: (attemptId: string) => void;
  },
  deps: DsSignInDeps,
): Promise<DsSignInOutcome> {
  const { pollMs = 1_000, onStarted, ...startOptions } = options;
  const start = await deps.start(startOptions);
  onStarted?.(start.attemptId);
  await deps.openExternal(start.authorizeUrl);

  const deadline = deps.now() + start.expiresIn * 1_000 + GRACE_MS;
  for (;;) {
    const state = await deps.status();
    if (state.attemptId != null && state.attemptId !== start.attemptId) {
      // 新的尝试已经开始：这一次的结论与我们无关。
      return { kind: "superseded" };
    }
    if (state.state === "signed-in") return { kind: "completed" };
    if (state.state === "failed" || state.state === "cancelled") {
      return { kind: "failed", code: state.state, message: state.error ?? "登录未完成" };
    }
    if (deps.now() > deadline) {
      // 超时也走「取消」：留一个进行中的尝试会把下一次登录顶掉。
      await deps.cancel(start.attemptId).catch(() => undefined);
      return {
        kind: "failed",
        code: "expired",
        message: "登录超时未完成（浏览器里没有完成授权）",
      };
    }
    await deps.sleep(pollMs);
  }
}
