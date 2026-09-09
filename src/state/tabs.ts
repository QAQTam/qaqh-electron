// TabsStore：seed-keyed 标签容器（spec §6.2）。铁律：任何链路传 seed 本身，
// 禁止 order[index] 反查；新建会话消费 session.created 事件置 active。
import { createStore } from "solid-js";

export type TabActivity =
  | "starting"
  | "idle"
  | "working"
  | "waiting_user"
  | "disconnected"
  | null;

export interface TabItem {
  seed: string;
  title: string;
  subtitle: string;
  activity: TabActivity;
  /** pendingPermissions + pending ask 数。 */
  pendingCount: number;
  /** 近 2s 内有 text_delta（时间窗判定）。 */
  streaming: boolean;
  /** 已对本 lease attach。 */
  attached: boolean;
  /** 已完成 bootstrap+timeline 全量装载。 */
  hydrated: boolean;
  archived: boolean;
  /** 会话元数据（session.list / meta_changed 维护）。 */
  meta: {
    cwd: string;
    model: string;
    mode: "plan" | "code";
    contextUsed: number;
    contextLimit: number;
  };
}

interface TabsState {
  order: string[];
  bySeed: Record<string, TabItem>;
  activeSeed: string | null;
}

const [state, setState] = createStore<TabsState>({
  order: [],
  bySeed: {},
  activeSeed: null,
});

let streamingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function newTab(seed: string, init?: Partial<TabItem>): TabItem {
  return {
    seed,
    title: init?.title ?? "未命名会话",
    subtitle: init?.subtitle ?? "",
    activity: init?.activity ?? "starting",
    pendingCount: init?.pendingCount ?? 0,
    streaming: init?.streaming ?? false,
    attached: init?.attached ?? false,
    hydrated: init?.hydrated ?? false,
    archived: init?.archived ?? false,
    meta:
      init?.meta ?? { cwd: "", model: "", mode: "code", contextUsed: 0, contextLimit: 0 },
  };
}

/** 从 basename 提取 subtitle。 */
function baseName(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

export const tabsStore = {
  state,

  order: () => state.order,
  activeSeed: () => state.activeSeed,
  tab: (seed: string) => state.bySeed[seed],

  /** 未知 seed → 建懒 tab（未激活不装载）。事件分发器调用。 */
  ensureTracked(seed: string): void {
    setState((s) => {
      if (s.bySeed[seed]) return;
      s.bySeed[seed] = newTab(seed);
      s.order.push(seed);
    });
  },

  /** session.list 全量灌入（保留已 hydrate 标签的运行态）。 */
  ingestList(
    items: Array<{
      seed: string;
      title?: string | null;
      cwd?: string | null;
      model?: string;
      mode?: number;
      archived?: boolean;
      last_summary?: string;
    }>,
  ): void {
    setState((s) => {
      for (const it of items) {
        const existing = s.bySeed[it.seed];
        const mode: "plan" | "code" = it.mode === 1 ? "plan" : "code";
        if (existing) {
          if (it.title) existing.title = it.title;
          else if (it.last_summary) existing.title = it.last_summary;
          existing.meta.cwd = it.cwd ?? existing.meta.cwd;
          existing.subtitle = baseName(it.cwd ?? existing.meta.cwd);
          if (it.model) existing.meta.model = it.model;
          existing.meta.mode = mode;
          existing.archived = it.archived ?? false;
        } else {
          const tab = newTab(it.seed, {
            title: it.title || it.last_summary || "未命名会话",
            subtitle: baseName(it.cwd ?? ""),
            archived: it.archived ?? false,
            meta: {
              cwd: it.cwd ?? "",
              model: it.model ?? "",
              mode,
              contextUsed: 0,
              contextLimit: 0,
            },
          });
          if (!tab.archived) tab.activity = "idle";
          s.bySeed[it.seed] = tab;
          s.order.push(it.seed);
        }
      }
      // list 里没有的 seed 不删除（可能是刚 create 还没落盘的 pending 会话）
    });
  },

  setActive(seed: string): void {
    setState((s) => {
      if (!s.bySeed[seed]) return;
      s.activeSeed = seed;
    });
  },

  /** 新建会话：session.created 事件到达 → 插入并置 active。 */
  adoptCreated(seed: string): void {
    setState((s) => {
      if (!s.bySeed[seed]) {
        s.bySeed[seed] = newTab(seed, { activity: "starting" });
        s.order.push(seed);
      }
      s.activeSeed = seed;
    });
  },

  patch(seed: string, patch: Partial<TabItem>): void {
    setState((s) => {
      const t = s.bySeed[seed];
      if (t) Object.assign(t, patch);
    });
  },

  patchMeta(seed: string, meta: Partial<TabItem["meta"]>): void {
    setState((s) => {
      const t = s.bySeed[seed];
      if (!t) return;
      Object.assign(t.meta, meta);
      if (meta.cwd !== undefined) t.subtitle = baseName(meta.cwd);
    });
  },

  setTitle(seed: string, title: string): void {
    if (!title) return;
    setState((s) => {
      const t = s.bySeed[seed];
      if (t) t.title = title;
    });
  },

  /** text_delta 时间窗：2s 无新 delta 即熄灭青点。 */
  markStreaming(seed: string): void {
    const t = streamingTimers.get(seed);
    if (t) clearTimeout(t);
    setState((s) => {
      const tab = s.bySeed[seed];
      if (tab && !tab.streaming) tab.streaming = true;
    });
    const timer = setTimeout(() => {
      streamingTimers.delete(seed);
      setState((s) => {
        const tab = s.bySeed[seed];
        if (tab) tab.streaming = false;
      });
    }, 2000);
    streamingTimers.set(seed, timer);
  },

  remove(seed: string): void {
    setState((s) => {
      delete s.bySeed[seed];
      const i = s.order.indexOf(seed);
      if (i >= 0) s.order.splice(i, 1);
      if (s.activeSeed === seed) {
        // 选中相邻 tab（优先右侧），禁止 selected=-1 降级
        s.activeSeed = s.order[Math.min(i, s.order.length - 1)] ?? null;
      }
    });
  },

  /** Ctrl+Tab 轮转。 */
  cycle(): void {
    const n = state.order.length;
    if (n < 2 || !state.activeSeed) return;
    const i = state.order.indexOf(state.activeSeed);
    tabsStore.setActive(state.order[(i + 1) % n]!);
  },

  /** 从 projection 汇总 activity/pendingCount（dispatchBatch 后调用）。 */
  refreshActivityFrom(view: {
    activity?: TabActivity;
    pendingCount?: number;
  } | null, seed: string): void {
    if (!view) return;
    setState((s) => {
      const t = s.bySeed[seed];
      if (!t) return;
      if (view.activity !== undefined) t.activity = view.activity;
      if (view.pendingCount !== undefined) t.pendingCount = view.pendingCount;
    });
  },

  activeTab(): TabItem | null {
    return state.activeSeed ? state.bySeed[state.activeSeed] ?? null : null;
  },
};
