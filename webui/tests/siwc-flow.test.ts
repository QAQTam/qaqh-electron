import { describe, expect, it, vi } from "vitest";

import { runSignInFlow, type SiwcFlowState, type SignInDeps } from "../src/lib/siwc";

const START = {
  flowId: "flow-1",
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client",
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  expiresAtMs: 10_000,
  usageUrl: "https://chatgpt.com/settings/usage",
};

function deps(states: Array<SiwcFlowState | Error>, now = () => 0): {
  deps: SignInDeps;
  opened: string[];
  cancelled: string[];
} {
  const opened: string[] = [];
  const cancelled: string[] = [];
  let index = 0;
  const fake: SignInDeps = {
    start: (async () => START) as SignInDeps["start"],
    status: (async (_flowId: string) => {
      const next = states[Math.min(index, states.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    }) as SignInDeps["status"],
    cancel: (async (flowId: string) => {
      cancelled.push(flowId);
      return null;
    }) as SignInDeps["cancel"],
    openExternal: async (url: string) => {
      opened.push(url);
    },
    now,
    sleep: async () => undefined,
  };
  return { deps: fake, opened, cancelled };
}

describe("Sign in with ChatGPT 流程驱动", () => {
  it("开工后必须用系统浏览器打开授权 URL", async () => {
    const { deps: fake, opened } = deps([{ flowId: "flow-1", state: "completed", profileId: "p1" }]);
    const outcome = await runSignInFlow({ pollMs: 0 }, fake);
    expect(outcome).toEqual({ kind: "completed", profileId: "p1" });
    expect(opened).toEqual([START.authorizeUrl]);
  });

  it("轮询到终态才停（进行中 → 已完成）", async () => {
    const { deps: fake } = deps([
      { flowId: "flow-1", state: "pending", expiresAtMs: 10_000 },
      { flowId: "flow-1", state: "pending", expiresAtMs: 10_000 },
      { flowId: "flow-1", state: "completed", profileId: "p2" },
    ]);
    expect(await runSignInFlow({ pollMs: 0 }, fake)).toEqual({
      kind: "completed",
      profileId: "p2",
    });
  });

  it("失败态带出机器可读 code（用户拒绝授权不等于登录失效）", async () => {
    const { deps: fake } = deps([
      {
        flowId: "flow-1",
        state: "failed",
        error: { code: "sharing_not_enabled", message: "用户在浏览器中拒绝了授权" },
      },
    ]);
    expect(await runSignInFlow({ pollMs: 0 }, fake)).toEqual({
      kind: "failed",
      code: "sharing_not_enabled",
      message: "用户在浏览器中拒绝了授权",
    });
  });

  it("被新一次登录顶掉时报 superseded，而不是抛错", async () => {
    const { deps: fake } = deps([new Error("profile_not_found: 没有进行中的登录流程")]);
    expect(await runSignInFlow({ pollMs: 0 }, fake)).toEqual({ kind: "superseded" });
  });

  it("超时：取消流程并如实报「未完成」——不能把进行中的流程留在那儿挡住下一次登录", async () => {
    let clock = 0;
    const { deps: fake, cancelled } = deps(
      [{ flowId: "flow-1", state: "pending", expiresAtMs: 10_000 }],
      () => clock,
    );
    // 第一次判定用 0（未超时），随后把时钟推过 deadline + grace。
    const flow = runSignInFlow({ pollMs: 0 }, fake);
    clock = 10_000 + 15_000 + 1;
    const outcome = await flow;
    expect(outcome).toEqual({
      kind: "failed",
      code: "sign_in_cancelled",
      message: "登录超时未完成（浏览器里没有完成授权）",
    });
    expect(cancelled).toEqual(["flow-1"]);
  });

  it("非预期错误必须冒泡（不吞成「登录失败」）", async () => {
    const { deps: fake } = deps([new Error("ipc: host not reachable")]);
    await expect(runSignInFlow({ pollMs: 0 }, fake)).rejects.toThrow("host not reachable");
  });

  it("开工后回调 flowId（UI 的「取消登录」需要它）", async () => {
    const { deps: fake } = deps([{ flowId: "flow-1", state: "completed", profileId: "p1" }]);
    const seen: string[] = [];
    await runSignInFlow({ pollMs: 0, onStarted: (id) => seen.push(id) }, fake);
    expect(seen).toEqual(["flow-1"]);
  });

  it("选项映射：只有显式给出的字段才上行", async () => {
    const startSpy = vi.fn(async () => START);
    const { deps: fake } = deps([{ flowId: "flow-1", state: "completed", profileId: "p" }]);
    await runSignInFlow({ newProfile: true, pollMs: 0 }, { ...fake, start: startSpy as never });
    expect(startSpy).toHaveBeenCalledWith({ newProfile: true });
  });
});
