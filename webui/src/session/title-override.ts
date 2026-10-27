/**
 * 方案A:后端尚未生成标题时的本地会话重命名覆盖(纯函数)。
 *
 * 优先级语义(用户拍板):后端标题恒优先 —— 用户重命名只在后端尚未
 * 生成标题(`title_changed` 尚未到达)前有效。后端持久化是方案B
 * (Rust `session.rename`),见 docs/session-rename-persistence-plan.md。
 */
export function overlayLocalTitles<T extends { session_id: unknown; title?: string | null }>(
  list: Array<T>,
  localTitles: Record<string, string>,
): { merged: Array<T>; staleSeeds: string[] } {
  const staleSeeds: string[] = [];
  const merged = list.map((item) => {
    const seed = String(item.session_id);
    const backend = typeof item.title === "string" ? item.title.trim() : "";
    if (backend) {
      // 后端已有标题:本地覆盖退场(记为陈旧,由调用方清理)。
      if (localTitles[seed]) staleSeeds.push(seed);
      return item;
    }
    const override = localTitles[seed];
    return override ? { ...item, title: override } : item;
  });
  return { merged, staleSeeds };
}
