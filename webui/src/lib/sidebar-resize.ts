/**
 * 侧栏拖拽调宽(用户侧需求):纯逻辑,组件只做事件接线。
 *
 * 交互契约:
 *  - 拖拽中:组件直写 `#app` 的 `--sidebar-width`(rAF 合帧,不进 signal),
 *    `html.sidebar-resizing` 关掉轨道过渡——过渡会拖住光标,是卡顿感的来源;
 *  - 松手:宽度 < SIDEBAR_COLLAPSE_BELOW 视为「收回」(等效汉堡),收拢动画由
 *    #app 既有 220ms grid 轨道过渡播出(磁吸感);否则持久化并按新宽度常驻。
 *
 * 注意 SIDEBAR_COLLAPSE_BELOW > SIDEBAR_WIDTH_MIN 是刻意的:拖到最窄再松手
 * 一定收回,不会停在 200px 的「半开」状态。
 */

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 440;
/** 松手低于此宽度 → 收回侧栏(汉堡态,48px)。 */
export const SIDEBAR_COLLAPSE_BELOW = 224;
/** 键盘微调步长(←/→)。 */
export const SIDEBAR_WIDTH_STEP = 16;

export const clampSidebarWidth = (px: number): number =>
  Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));

/** 拖拽起点 → 新宽度。向右拖 = 变宽。 */
export const dragSidebarWidth = (startX: number, startWidth: number, x: number): number =>
  clampSidebarWidth(startWidth + (x - startX));

/** 松手决策:true = 收回侧栏。 */
export const shouldCollapseSidebar = (px: number): boolean => px < SIDEBAR_COLLAPSE_BELOW;

/** localStorage 读回:非法/越界一律回默认(null = 不写内联变量,吃 token 288px)。 */
export const restoreSidebarWidth = (raw: string | null): number | null => {
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const clamped = clampSidebarWidth(value);
  // 夹持后与原值偏差过大视为脏数据(例如手改 localStorage 成负数),不恢复。
  return Math.abs(clamped - value) < 1 ? clamped : null;
};
