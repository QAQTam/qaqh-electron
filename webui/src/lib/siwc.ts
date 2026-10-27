/**
 * Sign in with ChatGPT（套餐用量）的壳命令封装。
 *
 * 与 `pairing.ts` 同一分工：**HTTP 与 admin token 都留在 Rust 侧**，
 * 前端只拿状态投影（结构上不含 token）与一个需要交给系统浏览器打开的授权 URL。
 *
 * 八个方法的清单是 daemon 服务面（`qaqh_siwc::methods::ALL`）的镜像；
 * 壳侧另有一份白名单（`src-tauri/src/commands.rs::SERVICE_METHODS`），
 * 两处都要加才通——白名单的存在是为了让「前端能调哪些 daemon 方法」可审计。
 */
import { invoke } from "@tauri-apps/api/core";

import type { SiwcSessionStatus } from "../siwc/brand";
import { isTauriRuntime } from "./transport/backend";

export interface SiwcModelEntry {
  slug: string;
  /** UI 显示用；请求里用 `slug`。 */
  displayName: string;
}

export interface SiwcSignInStart {
  flowId: string;
  /** 必须由宿主用**系统浏览器**打开（`openExternal`），不得内嵌 webview。 */
  authorizeUrl: string;
  redirectUri: string;
  expiresAtMs: number;
  usageUrl: string;
}

/** `siwc.sign_in.status` 的终态/进行态。 */
export type SiwcFlowState =
  | { flowId: string; state: "pending"; expiresAtMs: number }
  | { flowId: string; state: "completed"; profileId: string }
  | {
      flowId: string;
      state: "failed";
      error: {
        code: string;
        message: string;
        retryable?: boolean;
        requiresReauth?: boolean;
      };
    };

export interface SiwcSignOutResult {
  profileId: string;
  /** `false` = 远端撤销未确认（本地已清），提示用户可在 ChatGPT 设置里断开。 */
  revoked: boolean;
  hadRefreshToken: boolean;
  usageUrl: string;
}

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Sign in with ChatGPT 需要桌面壳：浏览器预览下不可用");
  }
  return invoke<T>("service_rpc", { method, params });
}

export const siwcStatus = (): Promise<SiwcSessionStatus> => rpc("siwc.status");

export const siwcProfiles = (): Promise<{
  active: string | null;
  profiles: SiwcSessionStatus[];
  pending: SiwcSessionStatus[];
}> => rpc("siwc.profiles");

export const siwcModels = (profileId?: string): Promise<SiwcModelEntry[]> =>
  rpc("siwc.models", profileId == null ? {} : { profile_id: profileId });

export const siwcSignInStart = (options: {
  profileId?: string;
  newProfile?: boolean;
  label?: string;
  reconsent?: boolean;
} = {}): Promise<SiwcSignInStart> =>
  rpc("siwc.sign_in.start", {
    ...(options.profileId == null ? {} : { profile_id: options.profileId }),
    ...(options.newProfile === true ? { new_profile: true } : {}),
    ...(options.label == null ? {} : { label: options.label }),
    ...(options.reconsent === true ? { reconsent: true } : {}),
  });

export const siwcSignInStatus = (flowId: string): Promise<SiwcFlowState> =>
  rpc("siwc.sign_in.status", { flow_id: flowId });

export const siwcSignInCancel = (flowId: string): Promise<null> =>
  rpc("siwc.sign_in.cancel", { flow_id: flowId });

export const siwcSelectProfile = (profileId: string): Promise<SiwcSessionStatus> =>
  rpc("siwc.profile.select", { profile_id: profileId });

export const siwcSignOut = (profileId?: string): Promise<SiwcSignOutResult> =>
  rpc("siwc.sign_out", profileId == null ? {} : { profile_id: profileId });

/** 用**系统浏览器**打开授权 URL（壳侧只放行 http/https）。 */
export const openExternal = (url: string): Promise<void> =>
  invoke<void>("open_external", { url });

export type SignInOutcome =
  | { kind: "completed"; profileId: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "superseded" };

/** 可注入的依赖：登录流程的全部外部动作（便于脱浏览器单测）。 */
export interface SignInDeps {
  start: typeof siwcSignInStart;
  status: typeof siwcSignInStatus;
  cancel: typeof siwcSignInCancel;
  openExternal: typeof openExternal;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: SignInDeps = {
  start: siwcSignInStart,
  status: siwcSignInStatus,
  cancel: siwcSignInCancel,
  openExternal,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 授权窗口失去响应后的宽限（daemon 侧自己的 TTL 是 10 分钟）。 */
const GRACE_MS = 15_000;

/**
 * 完整登录流程：开工 → 开系统浏览器 → 轮询到终态。
 *
 * 为什么把这段做成可注入依赖的纯驱动：轮询最容易出的是**静默挂死**
 * （等一个永远不会来的终态），而那段逻辑在 UI 里没法测。
 */
export async function runSignInFlow(
  options: {
    profileId?: string;
    newProfile?: boolean;
    label?: string;
    reconsent?: boolean;
    /** 轮询间隔；测试里传 0。 */
    pollMs?: number;
    /** 开工后立刻回调 flowId——UI 的「取消登录」需要它。 */
    onStarted?: (flowId: string) => void;
  } = {},
  deps: SignInDeps = defaultDeps,
): Promise<SignInOutcome> {
  const { pollMs = 1_000, onStarted, ...startOptions } = options;
  const start = await deps.start(startOptions);
  onStarted?.(start.flowId);
  await deps.openExternal(start.authorizeUrl);

  const deadline = start.expiresAtMs + GRACE_MS;
  for (;;) {
    let state: SiwcFlowState;
    try {
      state = await deps.status(start.flowId);
    } catch (cause) {
      // 没有任何进行中的流程 = 被新一次登录顶掉了（daemon 返回 profile_not_found）。
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("profile_not_found")) return { kind: "superseded" };
      throw cause;
    }
    if (state.state === "completed") {
      return { kind: "completed", profileId: state.profileId };
    }
    if (state.state === "failed") {
      return {
        kind: "failed",
        code: state.error.code,
        message: state.error.message,
      };
    }
    if (deps.now() > deadline) {
      // 超时也走「取消」：留一个进行中的流程会把下一次登录挡在 connection_busy 上。
      await deps.cancel(start.flowId).catch(() => undefined);
      return {
        kind: "failed",
        code: "sign_in_cancelled",
        message: "登录超时未完成（浏览器里没有完成授权）",
      };
    }
    await deps.sleep(pollMs);
  }
}
