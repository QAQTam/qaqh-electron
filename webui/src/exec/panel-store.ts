/**
 * 后台执行抽屉瞬态状态机(仿 diff/review-store 的抽屉纪律)。
 *
 * 数据不复制:抽屉打开时实时读活动会话 store 的 execSessions 记录,这里只持有
 * 「开/关 + 当前选中」两个瞬态位;关闭即物理卸载整棵子树,没有任何常驻缓存。
 */
import { createSignal, untrack } from "solid-js";

export interface ExecPanelState {
  isOpen: boolean;
  activeExecId: string | null;
}

class ExecPanelStoreController {
  private readonly state = createSignal<ExecPanelState>({ isOpen: false, activeExecId: null });

  public get snapshot(): () => ExecPanelState {
    return this.state[0];
  }

  /** 打开抽屉;execId 提供时直接聚焦该会话。 */
  public open(execId?: string | null): void {
    this.state[1]({ isOpen: true, activeExecId: execId ?? null });
  }

  /** 已开且聚焦同一会话时切换成关,否则打开/聚焦——顶栏图标与行内徽章共用一个入口语义。 */
  public toggle(execId?: string | null): void {
    const current = untrack(this.snapshot);
    if (current.isOpen && (execId == null || current.activeExecId === execId)) {
      this.close();
    } else {
      this.open(execId);
    }
  }

  public close(): void {
    this.state[1]({ isOpen: false, activeExecId: null });
  }

  public select(execId: string): void {
    if (!untrack(this.snapshot).isOpen) return;
    this.state[1]({ isOpen: true, activeExecId: execId });
  }
}

export const execPanelStore = new ExecPanelStoreController();
