/**
 * 「桌面壳」面板：分组左文右控布局（窗口与电源 / 运行状态 / 可折叠高级诊断）。
 */
import { createSignal, onSettled, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconRefreshCw from "~icons/lucide/refresh-cw";
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
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SettingGroup, SettingRow } from "../ui/SettingGroup";
import { toast } from "../ui/toast";
import { Switch } from "./controls";

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface PetStatusView {
  running: boolean;
  pid: number | null;
  exePath: string | null;
  exeExists: boolean;
  port: number;
  daemonConnected: boolean;
  pose: string | null;
  activityLabel: string | null;
  balanceDisplay: string | null;
}

export const HostSection: Component<{ onOpenPairing?: () => void }> = (props) => {
  const [build, setBuild] = createSignal<BuildInfo | null>(null);
  const [daemonVersion, setDaemonVersion] = createSignal<string | null>(null);
  const [lan, setLan] = createSignal<DaemonLanStatus | null>(null);
  const [memory, setMemory] = createSignal<Awaited<ReturnType<typeof loadHostMemory>>>(null);
  const [group, setGroup] = createSignal<ProcessGroup | null>(null);
  const [pet, setPet] = createSignal<PetStatusView | null>(null);
  const [petBusy, setPetBusy] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [powerMode, setPowerMode] = createSignal<PowerBlockerMode>("off");
  const [powerActive, setPowerActive] = createSignal(false);
  const [showDiagnostics, setShowDiagnostics] = createSignal(false);
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
      attempt("daemon 版本", () => transport.query("daemon.version", {}), (value) => {
        setDaemonVersion(typeof value === "string" && value !== "" ? value : null);
      }),
      attempt("局域网状态", daemonLanStatus, setLan),
      attempt("壳内存", loadHostMemory, setMemory),
      attempt("界面进程组", loadProcessGroup, setGroup),
      attempt("窗口状态", async () => {
        const controls = desktopHost()?.windowControls;
        return controls == null ? null : controls.state();
      }, (value) => { if (value != null) setHostWindowState(value); }),
      attempt("桌面宠物", async () => {
        const host = desktopHost();
        return host == null ? null : host.invoke<PetStatusView>("pet_status");
      }, setPet),
    ]);
    setNote(failures.length > 0 ? failures.join(" · ") : null);
    setBusy(null);
  };

  onSettled(() => {
    void refresh();
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

  const togglePet = async (enable: boolean): Promise<void> => {
    const host = desktopHost();
    if (host == null || petBusy()) return;
    setPetBusy(true);
    try {
      const next = await host.invoke<PetStatusView>(enable ? "pet_start" : "pet_stop");
      setPet(next);
      toast(next.running ? "桌面宠物已启动（双击桌宠可随时返回主窗）" : "桌面宠物已关闭", "ok");
    } catch (cause) {
      toast(`${enable ? "启动" : "关闭"}桌面宠物失败：${messageOf(cause)}`, "err");
      try { setPet(await host.invoke<PetStatusView>("pet_status")); } catch {}
    } finally {
      setPetBusy(false);
    }
  };

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
    <div id="section-host" style={{ display: "flex", "flex-direction": "column", gap: "24px" }}>
      <SettingGroup title="窗口与电源" desc="控制桌面窗口关闭行为与长任务期间的休眠策略。">
        <div class="ui-setting-row">
          <Switch
            label="关闭窗口时隐藏到托盘"
            hint="开启后点关闭仅隐藏到系统托盘；关闭则进入退出确认。"
            checked={effectiveCloseToTray()}
            disabled={!trayReady()}
            onToggle={(value) => void setCloseToTray(value)}
          />
        </div>
        <div class="ui-setting-row">
          <Switch
            label="阻止系统休眠"
            hint="任务运行期间防止电脑自动休眠，屏幕仍可按系统设置熄灭。"
            checked={powerMode() !== "off"}
            disabled={!powerBridge()}
            onToggle={(value) => void setPowerToggles(value, value && powerMode() === "keep-awake-bright")}
          />
        </div>
        <div class="ui-setting-row">
          <Switch
            label="同时保持屏幕常亮"
            hint="适合演示或监控场景，开启后将自动启用「阻止系统休眠」。"
            checked={powerMode() === "keep-awake-bright"}
            disabled={!powerBridge() || powerMode() === "off"}
            onToggle={(value) => void setPowerToggles(value || powerMode() !== "off", value)}
          />
        </div>
      </SettingGroup>

      <SettingGroup
        title="桌面宠物"
        desc="独立原生 Rust 桌宠（星灵 Astra）：直连 daemon 显示思考/回答/待审批与余额，主窗关闭后仍可常驻，双击即可唤回本窗口。"
      >
        <div class="ui-setting-row">
          <Switch
            label="启动桌面宠物"
            hint={
              pet() == null
                ? "仅 Electron 桌面壳支持"
                : pet()!.running
                  ? `运行中 · ${pet()!.daemonConnected ? (pet()!.activityLabel ?? "已连 daemon") : "等待 daemon"}${pet()!.balanceDisplay ? ` · ${pet()!.balanceDisplay}` : ""}`
                  : pet()!.exeExists
                    ? "已就绪，开启后将在桌面右下角悬浮显示"
                    : `未找到可执行文件：${pet()!.exePath ?? "qaqh-pet.exe"}`
            }
            checked={pet()?.running === true}
            disabled={desktopHost() == null || petBusy() || (pet()?.running !== true && pet()?.exeExists === false)}
            onToggle={(value) => void togglePet(value)}
          />
        </div>
        <Show when={pet() != null}>
          <SettingRow
            label="当前状态"
            desc={pet()!.exePath ?? "未配置路径"}
          >
            <Badge tone={pet()!.running ? (pet()!.daemonConnected ? "ok" : "warn") : "neutral"}>
              {pet()!.running ? (pet()!.daemonConnected ? (pet()!.activityLabel ?? "已连接") : "离线待连") : "未运行"}
            </Badge>
            <Button
              size="sm"
              variant="secondary"
              disabled={petBusy()}
              onClick={() => void togglePet(!(pet()?.running === true))}
            >
              {pet()?.running ? "关闭桌宠" : "打开桌宠"}
            </Button>
          </SettingRow>
        </Show>
      </SettingGroup>

      <SettingGroup
        title="运行状态"
        aside={
          <Button size="sm" variant="ghost" disabled={busy() != null} onClick={() => void refresh()}>
            <IconRefreshCw class={{ "icon-spin": busy() === "refresh" }} />
            刷新
          </Button>
        }
      >
        <SettingRow label="壳版本与后端批次" desc={`协议层级 v${protocolVersion()}`}>
          <span class="ui-setting-row-value is-mono">
            {build()?.display ?? (build()?.unavailable ? "浏览器" : "…")} · {daemonVersionLabel()}
          </span>
        </SettingRow>
        <SettingRow label="局域网服务" desc={lan()?.active ? (lan()?.lan_endpoint ?? undefined) : "默认仅监听本机回环"}>
          <Badge tone={lan()?.active ? "ok" : "neutral"}>
            {lan()?.active === true ? "已开启" : lan()?.running === true ? "未开启" : "未运行"}
          </Badge>
          <Show when={props.onOpenPairing != null}>
            <Button size="sm" variant="secondary" disabled={busy() != null} onClick={props.onOpenPairing}>
              设备配对
            </Button>
          </Show>
        </SettingRow>
        <SettingRow label="主进程内存占用">
          <span class="ui-setting-row-value is-mono">{formatBytes(memory()?.resident_bytes ?? null)}</span>
        </SettingRow>
        <SettingRow label="宿主维护">
          <Button size="sm" variant="secondary" disabled={busy() != null} onClick={() => void retryStreams()}>
            重建事件流
          </Button>
          <Button size="sm" variant="secondary" disabled={busy() != null || !trayReady()} onClick={() => void hideToTray()}>
            隐藏到托盘
          </Button>
          <Button size="sm" variant="danger" disabled={busy() != null} onClick={() => void stopStale()}>
            停止旧 daemon
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="高级诊断"
        aside={
          <Button size="sm" variant="ghost" onClick={() => setShowDiagnostics((v) => !v)}>
            <span>{showDiagnostics() ? "收起详情" : "展开详情"}</span>
            <IconChevronDown style={{ transform: showDiagnostics() ? "rotate(180deg)" : "none", transition: "transform 140ms" }} />
          </Button>
        }
      >
        <Show
          when={showDiagnostics()}
          fallback={
            <SettingRow label="连接健康度" desc={`最后事件：${formatLiveness(lastLivenessAt())}`}>
              <Badge tone={hostError() == null && hostIncompatible() == null ? "ok" : "err"}>
                {hostError() == null && hostIncompatible() == null ? "正常" : "存在异常"}
              </Badge>
            </SettingRow>
          }
        >
          <SettingRow label="构建 Commit">
            <span class="ui-setting-row-value is-mono" title={build()?.commit ?? ""}>{build()?.commit?.slice(0, 12) ?? "—"}</span>
          </SettingRow>
          <SettingRow label="窗口与托盘">
            <span class="ui-setting-row-value">
              {windowState()?.visible === true ? "显示" : "隐藏"} · {windowState()?.maximized === true ? "最大化" : "普通"}
              {windowState()?.tray === true ? " · 托盘已启用" : " · 托盘未启用"}
            </span>
          </SettingRow>
          <SettingRow label="宿主最后事件">
            <span class="ui-setting-row-value">{formatLiveness(lastLivenessAt())}</span>
          </SettingRow>
          <SettingRow label="最近重连">
            <span class="ui-setting-row-value">
              {lastReconnect() == null
                ? "无"
                : `第 ${lastReconnect()!.attempt} 次，${Math.max(1, Math.ceil(lastReconnect()!.delay_ms / 1000))} 秒后`}
            </span>
          </SettingRow>
          <SettingRow label="宿主错误 / 兼容性">
            <span class="ui-setting-row-value">
              {hostError() ?? "无"} / {hostIncompatible() == null ? "正常" : String(hostIncompatible()!.detail ?? "不兼容")}
            </span>
          </SettingRow>
          <SettingRow label="界面进程组">
            <span class="ui-setting-row-value is-mono">
              {group() == null ? "未提供" : `${group()!.members.length} 个 · ${group()!.source}`}
            </span>
          </SettingRow>
          <SettingRow label="休眠限制状态">
            <span class="ui-setting-row-value">{powerBridge() ? describeMode(powerMode(), powerActive()) : "仅桌面壳提供"}</span>
          </SettingRow>
        </Show>
      </SettingGroup>

      <Show when={note() != null}>
        <p class="field-hint">{note()}</p>
      </Show>
    </div>
  );
};
