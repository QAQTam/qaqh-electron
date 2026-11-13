/**
 * 「关于」:桌面壳自身的构建标识(版本 + git commit),外加开发者模式入口。
 *
 * 这块 UI 的存在理由:NSIS 包名钉死在版本号上,版本又长期不 bump,于是「装了还是
 * 旧 UI」在文件名层面完全无从判断。壳内报一次 `<version>-<commit>`,一眼可验。
 *
 * 入口形态:连点版本串 5 次(相邻 ≤600ms)开调试控制台。刻意不做持久化也不写进
 * 文案——它是排查用的后门,不是功能;真打开过一次后,版本串就退化成「再点一下
 * 就开」的快捷键,连点进度也就此作废(见 `lib/devmode.ts`)。
 */
import { For, Show, createSignal, onSettled, type Component } from "solid-js";
import { Section } from "./controls";
import { loadBuildInfo, type BuildInfo } from "../lib/version";
import { transport } from "../lib/transport";
import { daemonLanStatus } from "../lib/pairing";
import { toast } from "../ui/toast";
import { devConsoleOpen, devMode, openDevConsole, pushUnlockClick } from "../lib/devmode";
import { desktopHost, type UpdateStatus } from "../lib/desktop-host";
import { Switch } from "../ui/Switch";
import { DevConsole } from "./dev/DevConsole";

/** 冷启动自动检查更新的 localStorage 键;缺省=开("off" 才关)。与 App 自动检查共用。 */
const AUTO_CHECK_KEY = "qaqh.settings.autoCheckUpdates";

export const AboutSection: Component = () => {
  const [build, setBuild] = createSignal<BuildInfo | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [daemonVersion, setDaemonVersion] = createSignal<string | null>(null);
  const [daemonBuildId, setDaemonBuildId] = createSignal<string | null>(null);
  const [daemonProtocol, setDaemonProtocol] = createSignal<string | null>(null);
  /** 连点时间戳;解锁或超窗即清空,不残留半程进度。 */
  const [stamps, setStamps] = createSignal<number[]>([]);
  /** Chrome DevTools 开关态(来自主进程回执;toggle 失败时不翻转)。 */
  const [devtoolsOpen, setDevtoolsOpen] = createSignal(false);
  /** 本地热更新状态(仅桌面壳;浏览器 dev 环境整块隐藏)。 */
  const [update, setUpdate] = createSignal<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = createSignal(false);
  const [autoCheck, setAutoCheck] = createSignal(
    typeof localStorage === "undefined" || localStorage.getItem(AUTO_CHECK_KEY) !== "off",
  );

  const toggleDevtools = (): void => {
    const bridge = desktopHost()?.devtools;
    if (bridge == null) {
      toast("当前运行环境没有桌面壳,无法打开 DevTools", "err");
      return;
    }
    void bridge.toggle().then(setDevtoolsOpen).catch((error: unknown) => {
      toast(`切换 DevTools 失败：${String(error instanceof Error ? error.message : error)}`, "err");
    });
  };

  // 只读一次:构建标识不随配置变,没有刷新语义。
  loadBuildInfo().then(setBuild, () => { setFailed(true); });
  onSettled(() => {
    // daemon.version is a JSON string (build-injected version), not an object.
    void transport.query("daemon.version", {}).then((value) => {
      setDaemonVersion(typeof value === "string" && value.trim() !== "" ? value : null);
    }).catch(() => {});
    // Discovery carries the control protocol version; it is optional when the
    // daemon has not published a discovery document yet.
    void daemonLanStatus().then((status) => {
      const discovered = status.daemon_version;
      if (discovered != null && discovered !== "") {
        setDaemonVersion((current) => current ?? discovered);
      }
      setDaemonBuildId(status.build_id ?? null);
      setDaemonProtocol(status.protocol_version == null ? null : String(status.protocol_version));
    }).catch(() => {});
    // 打开设置页即扫一次本地 update-source(只读 plan,不改任何文件)。
    refreshUpdate();
  });

  function refreshUpdate(): void {
    const bridge = desktopHost()?.updates;
    if (bridge == null) return;
    setUpdateBusy(true);
    bridge.check().then((status) => {
      setUpdate(status);
      setUpdateBusy(false);
    }).catch((error: unknown) => {
      setUpdateBusy(false);
      toast(`检查更新失败：${String(error instanceof Error ? error.message : error)}`, "err");
    });
  }

  function stageUpdate(): void {
    const bridge = desktopHost()?.updates;
    if (bridge == null) return;
    setUpdateBusy(true);
    bridge.stage().then((status) => {
      setUpdate(status);
      setUpdateBusy(false);
      if (status.staged) toast("更新已暂存，重启应用后生效", "ok");
      else if (status.error) toast(`暂存失败：${status.error}`, "err");
    }).catch((error: unknown) => {
      setUpdateBusy(false);
      toast(`暂存失败：${String(error instanceof Error ? error.message : error)}`, "err");
    });
  }

  function applyUpdate(): void {
    const bridge = desktopHost()?.updates;
    if (bridge == null) return;
    const plan = update()?.plan;
    // backend/full 计划会重启 daemon,掐断运行中的会话——与退出确认共用同一份
    // session.activity 数据源做静默期门控(忙时推迟,由用户空闲后手动重试)。
    // 查询失败按忙处理:误放行的代价(半程回合被掐)高于晚点再更。
    const touchesBackend = plan?.artifacts.includes("backend") === true
      || plan?.artifacts.includes("full") === true;
    if (!touchesBackend) {
      // 成功路径:主进程拉起 handoff 后自行退出,这里不会收到 resolve。
      bridge.apply().catch((error: unknown) => {
        toast(`应用更新失败：${String(error instanceof Error ? error.message : error)}`, "err");
      });
      return;
    }
    setUpdateBusy(true);
    void transport.query("session.activity", {}).then((activities) => {
      const busyCount = (activities as Array<{ state?: string }>).filter((item) =>
        item.state === "running" || item.state === "waiting_user" || item.state === "cancelling",
      ).length;
      if (busyCount > 0) {
        setUpdateBusy(false);
        toast(`有 ${busyCount} 个进行中的会话，backend 更新已推迟；空闲后再点「重启并应用」`, "info");
        return;
      }
      bridge.apply().catch((error: unknown) => {
        setUpdateBusy(false);
        toast(`应用更新失败：${String(error instanceof Error ? error.message : error)}`, "err");
      });
    }).catch(() => {
      setUpdateBusy(false);
      toast("无法确认会话状态，backend 更新已推迟；请稍后重试", "err");
    });
  }

  const updateStateText = (): string => {
    const status = update();
    if (status == null) return updateBusy() ? "检查中…" : "未检查";
    if (status.error != null) return `检查失败：${status.error}`;
    if (status.staged) return "已暂存，等待重启应用";
    const plan = status.plan;
    if (plan == null) return status.available ? "更新源为空" : `不可用：${status.reason ?? ""}`;
    if (plan.upToDate) return `已是最新（${plan.releaseId}）`;
    return `有可用更新：${plan.releaseId}（${plan.mode}）`;
  };

  const version = (): string => {
    if (failed()) return "壳未提供 app_version";
    const info = build();
    if (info == null) return "读取中…";
    return info.unavailable ? "浏览器 dev 环境:无壳" : info.display;
  };

  const commit = (): string => {
    const info = build();
    return info == null || info.unavailable ? "—" : info.commit;
  };

  const daemonDisplay = (): string => {
    const base = daemonVersion();
    if (base == null) return "未连接";
    const hash = daemonBuildId();
    return hash == null || hash === "" ? base : `${base}+${hash.slice(0, 8)}`;
  };

  const tapVersion = (): void => {
    if (devMode()) {
      openDevConsole();
      return;
    }
    const streak = pushUnlockClick(stamps(), Date.now());
    setStamps(streak.unlocked ? [] : streak.stamps);
    if (streak.unlocked) {
      openDevConsole();
      toast("开发者模式已开启：UI 操作与录屏工具面已暴露给 MCP(不落盘,重启即失效)", "info");
    }
  };

  return (
    <Section
      id="section-about"
      title="关于"
      desc="前端 Electron 壳与后端 daemon 的构建身份;批次指纹与协议层级分层核对。"
    >
      <div class="readonly-grid">
        <span>前端批次</span>
        <b
          class="about-version"
          onClick={tapVersion}
          title="发布批次指纹(版本号+打包仓 commit+dirty)。不是源码逐文件校验,只回答「这批产物是哪次打包切出的」。连点 5 次开调试控制台。"
        >
          {version()}
          <Show when={stamps().length > 0}>
            <span class="dev-pips" aria-hidden="true">
              {/* 时间戳可能同毫秒重复,所以按位置复用而不是按值键控:每次点击只多出一格。 */}
              <For each={stamps()} keyed={false}>{() => <i class="dev-pip" />}</For>
            </span>
          </Show>
        </b>
        <span>前端 commit</span>
        <b title={commit()}>{commit() === "—" ? "—" : commit().slice(0, 12)}</b>
        {/* 身份分层(2026-11-12 定口径,原「后端版本/后端协议」命名自欺):
            - 「后端批次」= QAQH_BUILD_ID,由打包入口(qaqh-electron justfile)以**前端仓
              HEAD** 注入,前后端同指纹=原子配对,供 updater planner 比对——它**不是**后端
              源码 commit(后端源码 hash 待 daemon discovery 补 source_commit,走 LTS 修改);
            - 「协议层级」= CONTROL_PROTOCOL_VERSION,Android API level 语义,与 git 解耦;
              后续统一身份到此,批次串退居开发者模式。 */}
        <span>后端批次</span>
        <b title="发布批次指纹:版本号+打包仓 commit 前 8 位。由前端仓 HEAD 注入(electron 是唯一打包入口),表达前后端原子配对;不是后端源码的 commit。">
          {daemonDisplay()}
        </b>
        <span>协议层级</span>
        <b title="控制协议 level(API level 语义,随破坏性协议变更递增,与构建批次无关)">
          {daemonProtocol() ?? "—"}
        </b>
      </div>
      <Show when={desktopHost()?.updates != null}>
        <div class="about-updates">
          <div class="readonly-grid">
            <span>本地更新源</span>
            <b class="about-update-source" title={update()?.sourceDir ?? ""}>{update()?.sourceDir ?? "—"}</b>
            <span>更新状态</span>
            <b>{updateStateText()}</b>
          </div>
          <div class="about-devbar">
            <button type="button" class="ghost-mini" disabled={updateBusy()} onClick={refreshUpdate}>
              检查更新
            </button>
            <Show when={update()?.plan != null && !(update()?.plan?.upToDate ?? true) && !update()?.staged}>
              <button type="button" class="ghost-mini" disabled={updateBusy()} onClick={() => stageUpdate()}>
                下载并暂存
              </button>
            </Show>
            <Show when={update()?.staged}>
              <button type="button" class="primary-mini" onClick={() => applyUpdate()}>
                重启并应用
              </button>
            </Show>
            <span class="settings-muted">frontend 更新只换 app.asar,daemon 会话不中断;backend/full 更新会重启 daemon,运行中会话会被推迟保护。</span>
            <Switch
              checked={autoCheck()}
              onToggle={(value) => {
                setAutoCheck(value);
                try { localStorage.setItem(AUTO_CHECK_KEY, value ? "on" : "off"); } catch { /* 隐私模式等:开关本次会话内仍生效 */ }
              }}
              label="启动时自动检查更新"
              hint="冷启动 5 秒后静默检查本地更新源;发现新版本提示,失败不出声"
            />
          </div>
        </div>
      </Show>
      <Show when={devMode()}>
        <div class="about-devbar">
          <button type="button" class="primary-mini" onClick={openDevConsole}>打开调试控制台</button>
          {/* DevTools 是壳层 webContents 的调试器:只在桌面运行时给出(浏览器 dev 环境本就有 F12)。 */}
          <Show when={desktopHost()?.devtools != null}>
            <button type="button" class="primary-mini" onClick={toggleDevtools}>
              {devtoolsOpen() ? "隐藏 DevTools" : "打开 DevTools"}
            </button>
          </Show>
          <span class="settings-muted">开发者模式开着:内存面板会每秒采一次样,关掉面板即停。</span>
        </div>
      </Show>
      <Show when={devConsoleOpen()}>
        <DevConsole />
      </Show>
    </Section>
  );
};
