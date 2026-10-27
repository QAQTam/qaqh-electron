/**
 * Todo 状态归一化(daemon typed 投影与模型产出可能用同义词,展示层统一)。
 * WorkspacePanel 与 todo v2 卡片(tools/TodoCard)共用同一套状态语义,
 * 不允许两处各写一份 switch 造成视觉漂移。
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export function normalizeStatus(raw: unknown): TodoStatus {
  switch (raw) {
    case "in_progress":
    case "in-progress":
    case "running":
      return "in_progress";
    case "completed":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

export function todoStatusLabel(status: TodoStatus): string {
  switch (status) {
    case "in_progress": return "进行中";
    case "completed": return "已完成";
    case "cancelled": return "已取消";
    default: return "待处理";
  }
}
