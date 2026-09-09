// 连接状态 store（spec §6.1 / §7）。全局模块级单例（Solid2：模块级信号即全局）。
import { createSignal } from "solid-js";

export type ConnPhase =
  | "booting" // 拉取连接配置 / daemon 确保中
  | "connecting" // open 协商中
  | "ready"
  | "reconnecting"
  | "daemonDead"
  | "daemonMissing"
  | "failed";

export interface ConnInfoView {
  endpoint: string;
  serverEpoch: string;
  leaseTtlMs: number;
  /** open/renew 时刻，用于推算 lease 剩余。 */
  leasedAt: number;
  adopted: boolean;
}

const [phase, setPhase] = createSignal<ConnPhase>("booting");
const [info, setInfo] = createSignal<ConnInfoView | null>(null);
const [failDetail, setFailDetail] = createSignal<string>("");
/** 失败重试计数（≥3 常红 + 手动重试）。 */
const [failCount, setFailCount] = createSignal(0);
/** "会话已恢复" 提示（epoch 重建后短暂显示）。 */
const [recoveredNote, setRecoveredNote] = createSignal(false);

export const connectionStore = {
  phase,
  info,
  failDetail,
  failCount,
  recoveredNote,
  setPhase,
  setInfo: (v: ConnInfoView) => {
    setInfo(v);
    setPhase("ready");
    setFailCount(0);
  },
  setFail: (detail: string) => {
    setFailDetail(detail);
    setFailCount((c) => c + 1);
    setPhase((p) => (p === "ready" ? "reconnecting" : "failed"));
  },
  setDaemonDead: () => setPhase("daemonDead"),
  setDaemonMissing: () => setPhase("daemonMissing"),
  markRecovered: () => {
    setRecoveredNote(true);
    setTimeout(() => setRecoveredNote(false), 4000);
  },
  reset: () => {
    setPhase("connecting");
    setFailDetail("");
  },
};
