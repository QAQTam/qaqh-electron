/**
 * 「配置已落盘」的前端单向广播（daemon 不会推 config-changed）。
 *
 * 现实：`config.save` 的返回值恒为 null（`settings/store.ts` 顶部），写模型是 Merge
 * Patch，改完只有**发起写的那个组件**知道。可同一份数值在前端还有别的镜像：
 *
 *  - 输入区的模型/强度芯片（`composer/model-config`）；
 *  - 上下文百分比的**分母**（`session/store` 的 `contextLength`，取自
 *    `config.load().contextLength`）。
 *
 * 各镜像各写一套轮询太贵，所以收口成：**写口成功后广播一次，镜像自己重读**。
 * 之前缺这层广播的直接后果：设置页把「上下文窗口」从 1M 改成 200K 并提示「已热载
 * 生效」，输入区的百分比却还按 1M 算，直到**下一轮结束**才更新（`refreshConfigView`
 * 只挂在 attach 与 turn 边界上）——用户看到的百分比分母于是"不是自己刚设的值"。
 *
 * 纪律：
 *  1. 只有真的写成功了才广播（失败还广播 = 让所有镜像白读一次）；
 *  2. 监听方必须自己吞掉读失败，留旧值（HUD 是可选装饰，不该拖垮会话）；
 *  3. 监听方自己负责退订（`SessionStore.dispose` 里做）。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅「配置已变」。返回退订函数。 */
export function onConfigChanged(listener: Listener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** 广播「配置已变」。逐个调用，单个监听方抛错不影响其它监听方。 */
export function notifyConfigChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 镜像读失败由它自己兜（见文件头纪律 2）。
    }
  }
}
