/**
 * 封箱 toast 的 renderer 侧收口(notify://handoff)。
 *
 * ADR-016 后主进程 notifier 只当**纯展示**:hero 动画 + [立即继续][取消自动]
 * 两颗按钮,各发一条 `{action:"continue"|"cancel", key}`。两个动作都是纯前端
 * 标记——fork/投文档/开回合的决策权在内核(ADR-016 切片 1),renderer 拿到
 * HandoffSealed 才有 B;[立即继续] 落成 eager 标记,[取消自动] 落成「不拽我」
 * 标记(内核照常 fork,前端只是不自动跳转,见 turn/TurnView 的 HandoffCard)。
 *
 * 单例而非广播总线:同一时刻只有最新一张 armed 交接卡消费这两个标记;
 * 后挂载的卡直接顶掉前一张的注册。
 *
 * 注册表必须是**普通变量**:本仓 Solid 在 root 外写信号不会同步可读,而监听器
 * 回调恰恰跑在 Solid 之外。
 */
import { desktopHost } from "../lib/desktop-host";

export interface HandoffRemoteHandlers {
  /** 交接事实去重键 `from_session_id|turn_id`:与主进程 toast 同一身份,对不上的消息忽略。 */
  key: string;
  /** toast 上按了[立即继续]:eager 标记,HandoffSealed 一到立即切 B。 */
  onContinue: () => void;
  /** toast 上按了[取消自动]:「不拽我」,内核照常 fork,前端不自动跳转。 */
  onCancel: () => void;
}

let active: HandoffRemoteHandlers | null = null;

export function registerHandoffRemote(handlers: HandoffRemoteHandlers): void {
  active = handlers;
}

/** 只注销自己那一条:后挂载的卡顶掉旧注册后,旧卡的 cleanup 不得把新卡连坐摘掉。 */
export function unregisterHandoffRemote(key: string): void {
  if (active?.key === key) active = null;
}

// 模块级一次性接线(非 Electron 环境为 no-op,与 plugins/loader 的 startPluginHost 同款判空)。
desktopHost()?.listen("notify://handoff", (payload) => {
  const message = payload as { action?: unknown; key?: unknown } | null;
  const handlers = active;
  if (handlers == null || typeof message?.key !== "string" || message.key !== handlers.key) return;
  if (message.action === "continue") handlers.onContinue();
  else if (message.action === "cancel") handlers.onCancel();
});
