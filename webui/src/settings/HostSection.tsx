/**
 * 「桌面壳」面板:把 Electron 主进程独有的能力集中到一处。
 *
 * 这些状态不属于 daemon 配置,也不应该散落在各个会话标签里:
 *  - 壳/daemon 版本与协议;
 *  - 窗口/托盘关闭行为;
 *  - `conn://` 诊断(liveness、重连、宿主错误、不兼容);
 *  - 原生模型选择器与截图/原生材质能力;
 *  - 壳进程/界面进程组的内存摘要。
 */
import { createSignal, onSettled, Show, type Component } from "solid-js";
import { activeTab } from "../tabs/store";
import { desktopHost, type WindowState } from "../lib/desktop-host";
import { formatBytes } from "../lib/memwatch";
import {
  hostError,
  hostIncompatible,
  hostWindowState,
  lastLivenessAt,
  lastReconnect,
  formatLiveness,
  setHostWindowState,
} from "../lib/host-status";
import { loadHostMemory, loadProcessGroup, type ProcessGroup } from "../lib/hostmem";
import { daemonLanStatus, type DaemonLanStatus } from "../lib/pairing";
import { desktopHostSurface, transport } from "../lib/transport";
import { loadBuildInfo, type BuildInfo } from "../lib/version";
import {
  applyPowerMode,
  describeMode,
  modeFromToggles,
  restorePowerMode,
  type PowerBlockerMode,
} from "../lib/power-blocker";
import { toast } from "../ui/toast";
import { Section, Switch } from "./controls";

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const HostSection: Component<{ onOpenPairing?: () => void }> = (props) => {
  const [build, setBuild] = createSignal<BuildInfo | null>(null);
  const [daemonVersion, setDaemonVersion] = createSignal<string | null>(null);
  const [lan, setLan] = createSignal<DaemonLanStatus | null>(null);
  const [memory, setMemory] = createSignal<Awaited<ReturnType<typeof loadHostMemory>>>(null);
  const [group, setGroup] = createSignal<ProcessGroup | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  /** 休眠限制(阶段外新增,用户需求):双开关 ↔ 模式;偏好存 localStorage,启动重放。 */
  const [powerMode, setPowerMode] = createSignal<PowerBlockerMode>("off");
  const [powerActive, setPowerActive] = createSignal(false);
  const powerBridge = (): boolean => desktopHost()?.powerBlocker != null;

  const windowState = (): WindowState | null => hostWindowState();
  const trayReady = (): boolean => windowState()?.tray === true;
  const effectiveCloseToTray = (): boolean => windowState()?.closeToTray === true && trayReady();
  const daemonVersionLabel = (): string => {
    const base = daemonVersion() ?? lan()?.daemon_version;
    if (base == null || base === "") return "—";
    const hash = lan()?.build_id;
    return hash == null || hash === "" ? base : `${base}+${hash.slice(0, 8)}`;
  };
  const protocolVersion = (): string => {
    const value = lan()?.protocol_version ?? lan()?.app_protocol_version;
    return typeof value === "number" || typeof value === "string" ? String(value) : "—";
  };

  const refresh = async (): Promise<void> => {
    setBusy("refresh");
    const failures: string[] = [];
    const attempt = async <T,>(label: string, run: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
      try {
        apply(await run());
      } catch (cause) {
        failures.push(`${label}: ${messageOf(cause)}`);
      }
    };
    await Promise.all([
      attempt("壳版本", loadBuildInfo, setBuild),
      attempt("daemon 版本", () => transport.rpc<unknown>("daemon.version", {}), (value) => {
        setDaemonVersion(typeof value === "string" && value !== "" ? value : null);
      }),
      attempt("局域网状态", daemonLanStatus, setLan),
      attempt("壳内存", loadHostMemory, setMemory),
      attempt("界面进程组", loadProcessGroup, setGroup),
      attempt("窗口状态", async () => {
        const controls = desktopHost()?.windowControls;
        return controls == null ? null : controls.state();
      }, (value) => { if (value != null) setHostWindowState(value); }),
    ]);
    setNote(failures.length > 0 ? failures.join(" · ") : null);
    setBusy(null);
  };

  onSettled(() => {
    void refresh();
    // 启动重放:上次会话的休眠限制偏好重新应用到主进程;off 只查状态。
    void restorePowerMode().then((state) => {
      if (state != null) {
        setPowerMode(state.mode);
        setPowerActive(state.active);
      }
    }).catch(() => {});
  });

  const runAction = async (id: string, run: () => Promise<void>): Promise<void> => {
    if (busy() != null) return;
    setBusy(id);
    setNote(null);
    try {
      await run();
    } catch (cause) {
      setNote(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const retryStreams = (): Promise<void> =>
    runAction("retry", async () => {
      const host = desktopHostSurface(transport);
      if (host == null) throw new Error("当前不是 Electron 桌面壳");
      await host.streamsRetry(activeTab()?.seed);
      setNote("已请求宿主重新建立事件流。");
    });

  const stopStale = (): Promise<void> =>
    runAction("stale", async () => {
      const host = desktopHostSurface(transport);
      if (host == null) throw new Error("当前不是 Electron 桌面壳");
      const status = await host.stopStaleDaemon();
      if (status === "busy") {
        setNote("旧 daemon 正在跑任务，已保留现场；请先停止相关会话。");
        return;
      }
      if (status === "unsupported") {
        setNote("当前 daemon 不支持安全停机。");
        return;
      }
      setNote("旧实例已停止，正在重新连接 daemon…");
      await refresh();
    });

  const hideToTray = (): Promise<void> =>
    runAction("hide", async () => {
      const controls = desktopHost()?.windowControls;
      if (controls == null) throw new Error("当前壳没有窗口控制面");
      if (!trayReady()) throw new Error("托盘未启用；隐藏窗口后将无法从界面恢复");
      await controls.hide();
    });

  const setCloseToTray = async (value: boolean): Promise<void> => {
    const controls = desktopHost()?.windowControls;
    if (controls == null) return;
    if (value && !trayReady()) {
      toast("托盘未启用，不能启用关闭到托盘", "err");
      return;
    }
    try {
      setHostWindowState(await controls.setCloseToTray(value));
    } catch (cause) {
      toast(`更新关闭行为失败：${messageOf(cause)}`, "err");
    }
  };

  /** 休眠限制双开关 → 主进程 powerSaveBlocker;返回态为准(localStorage 只存偏好)。 */
  const setPowerToggles = async (keepAwake: boolean, keepBright: boolean): Promise<void> => {
    const bridge = desktopHost()?.powerBlocker;
    if (bridge == null) {
      toast("当前运行环境没有桌面壳，无法设置休眠限制", "err");
      return;
    }
    try {
      const state = await applyPowerMode(modeFromToggles(keepAwake, keepBright));
      if (state != null) {
        setPowerMode(state.mode);
        setPowerActive(state.active);
      }
    } catch (cause) {
      toast(`更新休眠限制失败：${messageOf(cause)}`, "err");
    }
  };

  return (
    <Section
      id="section-host"
      title="桌面壳"
      desc="Electron 主进程、窗口/托盘与宿主诊断。daemon 的连接配置仍由「模型与端点」管理。"
    >
      <div class="readonly-grid" style={{ "grid-column": "1 / -1" }}>
        <span>壳版本</span>
        <b>{build()?.display ?? (build()?.unavailable ? "浏览器环境（无壳）" : "读取中…")}</b>
        <span>commit</span>
        <b title={build()?.commit ?? ""}>{build()?.commit?.slice(0, 12) ?? "—"}</b>
        <span>后端版本</span>
        <b>{daemonVersionLabel()}</b>
        <span>后端协议</span>
        <b>{protocolVersion()}</b>
        <span>局域网</span>
        <b>{lan()?.active === true ? (lan()?.lan_endpoint ?? "已开启") : lan()?.running === true ? "未开启" : "daemon 未运行"}</b>
        <span>窗口</span>
        <b>
          {windowState()?.visible === true ? "显示" : "隐藏"}
          {" · "}
          {windowState()?.maximized === true ? "最大化" : "普通"}
          {windowState()?.fullscreen === true ? " · 全屏" : ""}
        </b>
        <span>托盘</span>
        <b>{windowState()?.tray === true ? "已启用" : "未启用"}</b>
        <span>关闭窗口</span>
        <b>{effectiveCloseToTray() ? "隐藏到托盘" : trayReady() ? "进入退出确认" : "进入退出确认（托盘不可用）"}</b>
        <span>宿主最后事件</span>
        <b>{formatLiveness(lastLivenessAt())}</b>
        <span>最近重连</span>
        <b>
          {lastReconnect() == null
            ? "无"
            : `第 ${lastReconnect()!.attempt} 次，${Math.max(1, Math.ceil(lastReconnect()!.delay_ms / 1000))} 秒后`}
        </b>
        <span>宿主错误</span>
        <b class={hostError() == null ? undefined : "is-error"}>{hostError() ?? "无"}</b>
        <span>不兼容实例</span>
        <b class={hostIncompatible() == null ? undefined : "is-error"}>
          {hostIncompatible() == null ? "无" : String(hostIncompatible()!.detail ?? "版本/协议不匹配")}
        </b>
        <span>Electron 主进程内存</span>
        <b>{formatBytes(memory()?.resident_bytes ?? null)}</b>
        <span>界面进程组</span>
        <b>{group() == null ? "未提供" : `${group()!.members.length} 个 · ${group()!.source}`}</b>
        <span>应用内截图</span>
        <b>未实现：使用系统截图后「添加附件」</b>
        <span>原生窗口材质</span>
        <b>不支持（set_window_theme 返回 false；使用 CSS 主题）</b>
        <span>休眠限制</span>
        <b>{powerBridge() ? describeMode(powerMode(), powerActive()) : "仅桌面壳提供"}</b>
      </div>

      <Switch
        label="关闭窗口时隐藏到托盘"
        hint="开启：关闭按钮只隐藏窗口，托盘可重新打开。关闭：关闭按钮进入退出确认，可选择停止 daemon / 停止活动任务。"
        checked={effectiveCloseToTray()}
        disabled={!trayReady()}
        onToggle={(value) => void setCloseToTray(value)}
      />

      <Switch
        label="阻止系统休眠"
        hint="运行期间阻止电脑进入休眠/挂起（Linux 经 D-Bus inhibit，Windows 经 SetThreadExecutionState）。屏幕仍可能按系统设置熄灭。"
        checked={powerMode() !== "off"}
        disabled={!powerBridge()}
        onToggle={(value) => void setPowerToggles(value, value && powerMode() === "keep-awake-bright")}
      />
      <Switch
        label="同时保持屏幕常亮"
        hint="在阻止休眠的基础上保持屏幕不熄灭——适合演示/监控场景；隐含开启「阻止系统休眠」。"
        checked={powerMode() === "keep-awake-bright"}
        disabled={!powerBridge() || powerMode() === "off"}
        onToggle={(value) => void setPowerToggles(value || powerMode() !== "off", value)}
      />

      <div class="lan-actions" style={{ "grid-column": "1 / -1" }}>
        <button type="button" class="ghost-mini" disabled={busy() != null} onClick={() => void refresh()}>
          刷新宿主状态
        </button>
        <button type="button" class="ghost-mini" disabled={busy() != null} onClick={() => void retryStreams()}>
          重新建立事件流
        </button>
        <button type="button" class="ghost-mini is-danger" disabled={busy() != null} onClick={() => void stopStale()}>
          停止旧 daemon 并重连
        </button>
        <button type="button" class="ghost-mini" disabled={busy() != null || !trayReady()} onClick={() => void hideToTray()}>
          隐藏到托盘
        </button>
        <Show when={props.onOpenPairing != null}>
          <button type="button" class="ghost-mini" disabled={busy() != null} onClick={props.onOpenPairing}>
            打开设备配对
          </button>
        </Show>
      </div>

      <Show when={note() != null}>
        <p class="field-hint" style={{ "grid-column": "1 / -1" }}>{note()}</p>
      </Show>
    </Section>
  );
};
