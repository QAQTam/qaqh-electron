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
import { For, Show, createSignal, type Component } from "solid-js";
import { Section } from "./controls";
import { loadBuildInfo, type BuildInfo } from "../lib/version";
import { toast } from "../ui/toast";
import { devConsoleOpen, devMode, openDevConsole, pushUnlockClick } from "../lib/devmode";
import { DevConsole } from "./dev/DevConsole";

export const AboutSection: Component = () => {
  const [build, setBuild] = createSignal<BuildInfo | null>(null);
  const [failed, setFailed] = createSignal(false);
  /** 连点时间戳;解锁或超窗即清空,不残留半程进度。 */
  const [stamps, setStamps] = createSignal<number[]>([]);

  // 只读一次:构建标识不随配置变,没有刷新语义。
  loadBuildInfo().then(setBuild, () => { setFailed(true); });

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

  const tapVersion = (): void => {
    if (devMode()) {
      openDevConsole();
      return;
    }
    const streak = pushUnlockClick(stamps(), Date.now());
    setStamps(streak.unlocked ? [] : streak.stamps);
    if (streak.unlocked) {
      openDevConsole();
      toast("开发者模式已开启(不落盘,重启即失效)", "info");
    }
  };

  return (
    <Section
      id="section-about"
      title="关于"
      desc="桌面壳自身的构建标识;daemon 是独立 sidecar,版本随包一起出。"
    >
      <div class="readonly-grid">
        <span>版本</span>
        <b
          class="about-version"
          onClick={tapVersion}
        >
          {version()}
          <Show when={stamps().length > 0}>
            <span class="dev-pips" aria-hidden="true">
              {/* 时间戳可能同毫秒重复,所以按位置复用而不是按值键控:每次点击只多出一格。 */}
              <For each={stamps()} keyed={false}>{() => <i class="dev-pip" />}</For>
            </span>
          </Show>
        </b>
        <span>commit</span>
        <b>{commit()}</b>
      </div>
      <Show when={devMode()}>
        <div class="about-devbar">
          <button type="button" class="primary-mini" onClick={openDevConsole}>打开调试控制台</button>
          <span class="settings-muted">开发者模式开着:内存面板会每秒采一次样,关掉面板即停。</span>
        </div>
      </Show>
      <Show when={devConsoleOpen()}>
        <DevConsole />
      </Show>
    </Section>
  );
};
