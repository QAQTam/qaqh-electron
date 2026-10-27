import { describe, expect, it } from "vitest";
import { pendingPresentation, runStatusOf, workingOnly } from "../src/app/session-pending";
import type { SessionRunStatus } from "../src/api/qaqh/SessionRunStatus";

const at = (status: SessionRunStatus | undefined, busy?: boolean) =>
  pendingPresentation({ title: "排查上下文压缩", status, busy });

describe("侧栏待响应映射", () => {
  it("三态待人响应,各自文案与语义色", () => {
    expect(at("waiting_permission")).toMatchObject({ kind: "permission", label: "请求授权", phase: "pending" });
    expect(at("waiting_ask")).toMatchObject({ kind: "ask", label: "请求回答", phase: "pending" });
    expect(at("waiting_plan")).toMatchObject({ kind: "plan", label: "计划评审", phase: "pending" });
  });

  it("在跑与空闲不弹卡:待响应是「球在用户这边」,不是「还挂着事」", () => {
    // 与宿主 `session_is_busy` 的差别就在这里——那边 `working` 也算挂着事。
    for (const status of ["working", "idle", "not_running", "canceled", "error"] as SessionRunStatus[]) {
      expect(at(status), status).toBeNull();
    }
  });

  it("canceled / error 是上一回合终态驻留,不得渲染成待办", () => {
    expect(at("canceled")?.kind).toBeUndefined();
    expect(at("error")?.kind).toBeUndefined();
  });

  it("标题缺省时无障碍名退回通用主语,不留空 label", () => {
    const view = pendingPresentation({ title: null, status: "waiting_ask" });
    expect(view?.ariaLabel).toBe("该会话:请求回答");
    expect(pendingPresentation({ title: "   ", status: "waiting_ask" })?.ariaLabel).toBe("该会话:请求回答");
  });

  it("旧 daemon 只有 running/busy 时降级:true 当在跑,false/缺省当空闲", () => {
    expect(runStatusOf({ status: undefined, busy: true })).toBe("working");
    expect(runStatusOf({ status: undefined, busy: false })).toBe("idle");
    expect(runStatusOf({ status: undefined })).toBe("idle");
    // 降级路径下不可能得出「等人」——这正是要补 status 投影的理由。
    expect(at(undefined, true)).toBeNull();
    expect(at(undefined, false)).toBeNull();
  });

  it("status 存在时优先于 busy,不被兼容字段带偏", () => {
    expect(runStatusOf({ status: "idle", busy: true })).toBe("idle");
    expect(at("waiting_permission", false)).toMatchObject({ kind: "permission" });
  });

  it("working 仍是唯一点亮旧状态点的状态", () => {
    expect(workingOnly({ status: "working" })).toBe(true);
    expect(workingOnly({ status: "waiting_ask" })).toBe(false);
    expect(workingOnly({ status: undefined, busy: true })).toBe(true);
  });

  it("本地待审批 fastApproval 快轨优先于远程 session.status", () => {
    // 即使后端 session.status 仍滞留在 idle 或 working，本地已有的待审批挑战立刻呈现
    const view = pendingPresentation(
      { title: "会话 A", status: "idle", busy: false },
      { kind: "tool_permission" },
    );
    expect(view).toMatchObject({ kind: "permission", label: "请求授权", phase: "pending" });
    expect(workingOnly({ status: "working" }, true)).toBe(false);
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