import { afterEach, expect, test, vi } from "vitest";
import { notifyConfigChanged, onConfigChanged } from "../src/lib/config-events";
import { SessionStore } from "../src/session/store";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("广播逐个通知；单个监听方抛错不影响其余，退订后不再收到", () => {
  const calls: string[] = [];
  const offA = onConfigChanged(() => calls.push("a"));
  const offB = onConfigChanged(() => {
    throw new Error("boom");
  });
  const offC = onConfigChanged(() => calls.push("c"));

  notifyConfigChanged();
  expect(calls).toEqual(["a", "c"]);

  offA();
  offB();
  offC();
  notifyConfigChanged();
  expect(calls).toEqual(["a", "c"]);
});

/**
 * 回归锁：设置页保存「上下文窗口」后，输入区的百分比必须**立刻**按新分母算。
 *
 * 修复前 `refreshConfigView` 只挂在 attach 与 turn 边界上，配置广播根本不存在，
 * 于是用户改完窗口长度、界面提示「已热载生效」，百分比却仍按旧值算到下一轮结束。
 */
test("SessionStore 订阅配置广播：构造即订阅，dispose 退订", () => {
  const store = new SessionStore("test-config-broadcast");
  const refresh = vi.fn(async () => {});
  // 只验「广播打到了这条通路」：无宿主时 `config.load` 必然失败，真发 RPC 什么也验不到。
  (store as unknown as { refreshConfigView(): Promise<void> }).refreshConfigView = refresh;

  notifyConfigChanged();
  expect(refresh).toHaveBeenCalledTimes(1);

  store.dispose();
  notifyConfigChanged();
  expect(refresh, "退订后不该再有广播打扰已关闭的标签").toHaveBeenCalledTimes(1);
});
