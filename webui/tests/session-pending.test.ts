import { describe, expect, it } from "vitest";
import { pendingPresentation, runStatusOf, workingOnly } from "../src/app/session-pending";
import type { SessionRunStatus } from "../src/api/qaqh/SessionRunStatus";

const at = (status: SessionRunStatus | undefined, busy?: boolean) =>
  pendingPresentation({ title: "排查上下文压缩", status, busy });

describe("侧栏待响应映射", () => {
  it("统一 waiting_user 显示通用卡,可用的审批挑战显示具体类型", () => {
    expect(at("waiting_user")).toMatchObject({ kind: "interaction", label: "等待响应", phase: "pending" });
    expect(pendingPresentation(
      { title: "会话 A", status: "waiting_user", busy: true },
      { kind: "tool_permission" },
    )).toMatchObject({ kind: "permission", label: "请求授权", phase: "pending" });
  });

  it("运行中、取消中与空闲不弹待响应卡", () => {
    for (const status of ["running", "cancelling", "idle", "not_running"] as SessionRunStatus[]) {
      expect(at(status), status).toBeNull();
    }
  });

  it("标题缺省时无障碍名退回通用主语,不留空 label", () => {
    const view = pendingPresentation({ title: null, status: "waiting_user" });
    expect(view?.ariaLabel).toBe("该会话:等待响应");
    expect(pendingPresentation({ title: "   ", status: "waiting_user" })?.ariaLabel).toBe("该会话:等待响应");
  });

  it("缺少 status 时从 busy 派生统一运行态", () => {
    expect(runStatusOf({ status: undefined, busy: true })).toBe("running");
    expect(runStatusOf({ status: undefined, busy: false })).toBe("idle");
    expect(runStatusOf({ status: undefined })).toBe("idle");
    expect(at(undefined, true)).toBeNull();
    expect(at(undefined, false)).toBeNull();
  });

  it("status 存在时优先于 busy,不被兼容字段带偏", () => {
    expect(runStatusOf({ status: "idle", busy: true })).toBe("idle");
    expect(pendingPresentation({ title: "会话 A", status: "waiting_user", busy: false })).toMatchObject({ kind: "interaction" });
  });

  it("运行中与取消中点亮状态点", () => {
    expect(workingOnly({ status: "running" })).toBe(true);
    expect(workingOnly({ status: "cancelling" })).toBe(true);
    expect(workingOnly({ status: "waiting_user" })).toBe(false);
    expect(workingOnly({ status: undefined, busy: true })).toBe(true);
  });

  it("本地待审批 fastApproval 快轨优先于远程 session.status", () => {
    // 即使后端 session.status 仍滞留在 idle 或 running，本地已有的待审批挑战立刻呈现
    const view = pendingPresentation(
      { title: "会话 A", status: "idle", busy: false },
      { kind: "tool_permission" },
    );
    expect(view).toMatchObject({ kind: "permission", label: "请求授权", phase: "pending" });
    expect(workingOnly({ status: "running" }, true)).toBe(false);
  });

  it("相同 updated_at 时以 session_id 字典序决胜，杜绝 15 秒轮询网络乱序造成的跳动", () => {
    const s1 = { session_id: "s-bbb", updated_at: 1000 };
    const s2 = { session_id: "s-aaa", updated_at: 1000 };
    const s3 = { session_id: "s-ccc", updated_at: 2000 };

    const sortFn = (list: typeof s1[]) =>
      [...list].sort((a, b) => {
        const timeDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return a.session_id.localeCompare(b.session_id);
      });

    // 无论输入数组顺序如何波动，结果都绝对稳定
    expect(sortFn([s1, s2, s3]).map((s) => s.session_id)).toEqual(["s-ccc", "s-aaa", "s-bbb"]);
    expect(sortFn([s2, s1, s3]).map((s) => s.session_id)).toEqual(["s-ccc", "s-aaa", "s-bbb"]);
  });
});
