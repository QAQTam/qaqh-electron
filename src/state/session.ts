// Projection→Solid 桥（spec §6.3）。
// SDK Projection 是协议层权威（唯一写入口）；视图层用 Solid store 镜像（reconcile 同步），
// 组件只读 store——纯 Solid 订阅体系，避免外部存储桥接的订阅时序问题。
import { createStore, reconcile } from "solid-js";
import { Projection, type SessionView } from "qaqh-js-sdk";
import type { TabActivity } from "./tabs";

// 协议层单例（client.ts 唯一写入口）
export const projection = new Projection();

// 视图层镜像：每次 projection touch 后 reconcile（revision 作版本哨兵）
const [store, setStore] = createStore<{ rev: number; sessions: Record<string, SessionView> }>({
  rev: 0,
  sessions: {},
});

function syncFromProjection(): void {
  const snap = projection.getSnapshot();
  const next: Record<string, SessionView> = {};
  for (const [seed, view] of snap.sessions) next[seed] = view;
  setStore((s) => {
    s.rev = snap.revision;
    s.sessions = reconcile(next, "seed")(s.sessions);
  });
}

projection.subscribe(syncFromProjection);

/** 组件内取 session（纯 Solid store 订阅）。 */
export function useSession(seedAccessor: () => string | null) {
  return createMemo0(() => {
    store.rev; // 订阅版本
    const seed = seedAccessor();
    return seed ? store.sessions[seed] ?? null : null;
  });
}

// 局部 import 别名（保持文件顶部 import 集中）
import { createMemo as createMemo0 } from "solid-js";

export function bumpRev(): void {
  syncFromProjection();
}

/** per-session activity 视图（tab 状态机数据源）。 */
export function activityOf(session: SessionView | null): TabActivity {
  if (!session) return null;
  return (session.activity as TabActivity) ?? null;
}

/** pendingCount = 审批 + ask（SessionView.pendingPermissions + interactions）。 */
export function pendingCountOf(session: SessionView | null): number {
  if (!session) return 0;
  return session.pendingPermissions.length;
}
