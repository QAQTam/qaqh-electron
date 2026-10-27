/**
 * 设备配对 section:先开「局域网模式」(壳把 daemon 重启成 `server --bind` 实例),
 * 再签发一次性配对令牌(120s)→ 渲染二维码 → 手机扫 `lan_endpoint` 并按 TLS
 * 指纹 pinning 直连;下方管理已配对设备(吊销会强制断开其 SSE)。
 *
 * 安全语义:二维码只在用户显式点击「生成」时签发——桌面确认 = 发 token。
 * admin token 与 HTTP 都留在 Rust 壳,webview 只见端点/指纹/设备视图与 payload。
 */
import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import IconQrCode from "~icons/lucide/qr-code";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconRadioTower from "~icons/lucide/radio-tower";
import { toast } from "../ui/toast";
import { isTauriRuntime, tauriHost, transport } from "../lib/transport";
import {
  daemonLanDisable,
  daemonLanEnable,
  daemonLanStatus,
  deviceRevoke,
  devicesList,
  isDaemonBusyError,
  lanAddressIssue,
  pairingCreate,
  type DaemonLanStatus,
  type DeviceEntry,
  type PairingScope,
} from "../lib/pairing";
import { Field, Section, TextInput } from "./controls";

const SCOPES: Array<{ id: PairingScope; label: string; desc: string }> = [
  { id: "view", label: "view", desc: "只读:看会话与输出" },
  { id: "interact", label: "interact", desc: "可交互:发送消息、响应授权" },
  { id: "admin", label: "admin", desc: "管理员:含设备管理(慎选)" },
];

/** 与壳侧 `lan::DEFAULT_LAN_PORT` 同调:固定端口是手机侧可预测地址的前提。 */
const DEFAULT_LAN_PORT = 64413;

const relativeTime = (ms: number): string => {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
};

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 指纹只展示前 8 位十六进制,完整值进 title 便于核对。 */
const shortFingerprint = (fp: string | null): string | null => {
  if (fp == null || fp === "") return null;
  const hex = fp.startsWith("sha256:") ? fp.slice(7) : fp;
  return `sha256:${hex.slice(0, 8)}…`;
};

export const PairingSection: Component = () => {
  const available = isTauriRuntime();
  const [scope, setScope] = createSignal<PairingScope>("interact");
  const [deviceName, setDeviceName] = createSignal("");
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [qrBaseUrl, setQrBaseUrl] = createSignal<string | null>(null);
  const [expiresAt, setExpiresAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [devices, setDevices] = createSignal<DeviceEntry[] | null>(null);
  const [devicesLoading, setDevicesLoading] = createSignal(false);
  const [confirmRevoke, setConfirmRevoke] = createSignal<string | null>(null);

  const [lan, setLan] = createSignal<DaemonLanStatus | null>(null);
  const [lanBusy, setLanBusy] = createSignal(false);
  const [lanNote, setLanNote] = createSignal<string | null>(null);
  const [lanError, setLanError] = createSignal<string | null>(null);
  const [lanConfirm, setLanConfirm] = createSignal<"enable" | "disable" | "force" | null>(null);
  /** Busy 之后「强制」要重试的是哪一条动作(开启/关闭),不能一律当成开启。 */
  const [forceAction, setForceAction] = createSignal<"enable" | "disable">("enable");
  const [bindIp, setBindIp] = createSignal("");
  const [portDraft, setPortDraft] = createSignal(String(DEFAULT_LAN_PORT));

  const lanActive = (): boolean => lan()?.active === true;

  // 倒计时只在有活码时走:250ms 一跳只为进度条平滑,秒数文本按秒变。
  createEffect(
    () => [qrDataUrl() != null, expiresAt()],
    ([live]) => {
      if (!live) return;
      const timer = window.setInterval(() => setNow(Date.now()), 250);
      onCleanup(() => window.clearInterval(timer));
    },
  );

  const loadDevices = async (): Promise<void> => {
    setDevicesLoading(true);
    try {
      setDevices((await devicesList()).devices);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDevicesLoading(false);
    }
  };

  const loadLan = async (): Promise<void> => {
    try {
      setLan(await daemonLanStatus());
    } catch (cause) {
      setLanError(messageOf(cause));
    }
  };

  // 进设置就各拉一次(available 恒定 → effect 只跑一次)。
  createEffect(
    () => available,
    () => {
      if (!available) return;
      void loadDevices();
      void loadLan();
    },
  );

  const expired = (): boolean => expiresAt() > 0 && now() >= expiresAt();
  const remainingSec = (): number => Math.max(0, Math.ceil((expiresAt() - now()) / 1000));
  const lanIssue = (): string | null => lanAddressIssue(lan()?.lan_endpoint ?? null);

  /** 二维码与局域网面是一体的:换 daemon(重启)后旧码的 base_url 就作废了。 */
  const dropQr = (): void => {
    setQrDataUrl(null);
    setQrBaseUrl(null);
    setExpiresAt(0);
  };

  // daemon 刚换过实例:宿主连接在壳侧已重建,这里把活动标签的流重新挂上去,
  // 无活动标签(no_active_seed)时静默即可。
  const reattachStreams = (): void => {
    const host = tauriHost(transport);
    if (host == null) return;
    void host.streamsRetry().catch(() => {});
  };

  const runLanRestart = async (action: "enable" | "disable", force: boolean): Promise<void> => {
    setLanBusy(true);
    setLanError(null);
    setLanConfirm(null);
    setLanNote(
      force
        ? "正在强制重启 daemon(在跑的 Turn 会被中断)…"
        : action === "enable"
          ? "正在以局域网模式重启 daemon,冷启动加证书生成约需数秒…"
          : "正在切回回环模式并重启 daemon…",
    );
    try {
      const port = Number.parseInt(portDraft(), 10);
      const status =
        action === "enable"
          ? await daemonLanEnable({ bindIp: bindIp().trim(), port: Number.isFinite(port) ? port : undefined, force })
          : await daemonLanDisable(force);
      setLan(status);
      dropQr();
      reattachStreams();
      toast(action === "enable" ? "局域网模式已开启" : "已关闭局域网模式", "ok");
      void loadDevices();
    } catch (cause) {
      if (isDaemonBusyError(cause)) {
        setForceAction(action);
        setLanConfirm("force");
      } else {
        setLanError(messageOf(cause));
      }
      // 停机请求可能已部分生效:状态刷新一次,别让面板停在旧值上。
      void loadLan();
    } finally {
      setLanNote(null);
      setLanBusy(false);
    }
  };

  const generate = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      const [{ default: QRCode }, ticket] = await Promise.all([
        import("qrcode"),
        pairingCreate(scope(), deviceName().trim() || "移动设备"),
      ]);
      const dataUrl = await QRCode.toDataURL(ticket.qr_payload, { margin: 1, width: 220 });
      setQrDataUrl(dataUrl);
      setQrBaseUrl(ticket.base_url);
      setExpiresAt(Date.now() + ticket.expires_in_ms);
      setNow(Date.now());
    } catch (cause) {
      dropQr();
      setError(messageOf(cause));
      void loadLan();
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (deviceId: string): Promise<void> => {
    try {
      await deviceRevoke(deviceId);
      setConfirmRevoke(null);
      toast("设备已吊销", "ok");
      void loadDevices();
    } catch (cause) {
      toast(messageOf(cause), "err");
    }
  };

  const fingerprint = (): string | null => shortFingerprint(lan()?.tls_fingerprint ?? null);

  return (
    <Section
      id="section-pairing"
      title="设备配对(移动端)"
      desc="先开启局域网模式让手机能连到本机,再生成一次性二维码扫码绑定。令牌 120 秒有效且只能用一次。"
    >      <Show
        when={available}
        fallback={<p class="field-hint" style={{ "grid-column": "1 / -1" }}>浏览器 dev 环境不可用:请在桌面壳内使用。</p>}
      >
        <div class="lan-block" style={{ "grid-column": "1 / -1" }}>
          <div class="lan-head">
            <span class="lan-title">
              <IconRadioTower />
              局域网模式
            </span>
            <Show
              when={!lanBusy()}
              fallback={<span class="lan-badge pending">重启中…</span>}
            >
              <span class={`lan-badge ${lanActive() ? "on" : "off"}`}>
                {lanActive() ? "已开启" : lan()?.running === true ? "未开启" : "daemon 未运行"}
              </span>
            </Show>
            <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => void loadLan()}>
              <IconRefreshCw class={{ spin: !lanBusy() && lan() == null }} />
              刷新
            </button>
          </div>

          <Show when={lanActive()}>
            <dl class="lan-grid">
              <dt>手机连接的地址</dt>
              <dd><b>{lan()!.lan_endpoint}</b></dd>
              <dt>证书指纹</dt>
              <dd><b title={lan()!.tls_fingerprint ?? ""}>{fingerprint() ?? "未提供"}</b></dd>
            </dl>
            <Show when={lanIssue() != null}>
              <p class="field-hint is-warn">{lanIssue()}</p>
            </Show>
            <Show when={lanIssue() == null}>
              <p class="field-hint">手机需与本机在同一局域网内。切换回环模式或改绑定地址都要重启 daemon,期间会话会中断。</p>
            </Show>
            <div class="lan-actions">
              <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => setLanConfirm("disable")}>
                关闭局域网模式
              </button>
            </div>
          </Show>

          <Show when={!lanActive()}>
            <p class="field-hint">
              daemon 现在只听回环地址,手机扫不到。开启后壳会以 <b>server --bind</b> 重启 daemon(启用自签 TLS),
              期间会话会短暂中断。
            </p>
            <Show when={lanConfirm() !== "enable" && lanConfirm() !== "force"}>
              <div class="lan-actions">
                <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => setLanConfirm("enable")}>
                  开启局域网模式
                </button>
              </div>
            </Show>
          </Show>

          <Show when={lanConfirm() === "enable" || lanConfirm() === "force" || lanConfirm() === "disable"}>
            <div class="lan-confirm">
              <Show when={lanConfirm() === "enable"}>
                <div class="lan-form">
                  <Field label="绑定地址" hint="留空 = 自动选出口网卡(0.0.0.0)。多网卡或开着代理建议手填,如 192.168.1.23;改地址会重签证书,设备需重扫。">
                    <TextInput value={bindIp()} onInput={setBindIp} placeholder="留空自动" />
                  </Field>
                  <Field label="端口" hint="固定端口让手机侧地址可预测;被占用时换个再试。" compact>
                    <TextInput value={portDraft()} onInput={setPortDraft} placeholder={String(DEFAULT_LAN_PORT)} />
                  </Field>
                  <div class="lan-actions">
                    <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => void runLanRestart("enable", false)}>
                      确认开启并重启 daemon
                    </button>
                    <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => setLanConfirm(null)}>
                      取消
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={lanConfirm() === "force"}>
                <p class="lan-confirm-copy is-warn">
                  daemon 正在跑 Turn,默认不硬停。确认强制重启会中断当前会话与审批。
                </p>
                <div class="lan-actions">
                  <button type="button" class="ghost-mini is-danger button-danger" disabled={lanBusy()} onClick={() => void runLanRestart(forceAction(), true)}>
                    {forceAction() === "disable" ? "强制切回回环模式" : "强制开启局域网模式"}
                  </button>
                  <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => setLanConfirm(null)}>
                    取消
                  </button>
                </div>
              </Show>
              <Show when={lanConfirm() === "disable"}>
                <p class="lan-confirm-copy">
                  关闭会以回环模式重启 daemon,局域网面随即消失,手机连不上。重新开启若换了绑定地址或端口,
                  自签证书会重签、已配对设备需要重新扫码。
                </p>
                <div class="lan-actions">
                  <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => void runLanRestart("disable", false)}>
                    确认关闭并重启
                  </button>
                  <button type="button" class="ghost-mini" disabled={lanBusy()} onClick={() => setLanConfirm(null)}>
                    取消
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={lanNote() != null}>
            <p class="field-hint">{lanNote()}</p>
          </Show>
          <Show when={lanError() != null}>
            <p class="field-hint is-error">{lanError()}</p>
          </Show>
        </div>

        <Field label="授予档位" wide>
          <div class="scope-list">
            <For each={SCOPES}>
              {(item) => (
                <label class={`scope${scope() === item.id ? " active" : ""}${item.id === "admin" ? " dangerous" : ""}`}>
                  <input
                    type="radio"
                    name="pairing-scope"
                    checked={scope() === item.id}
                    onInput={() => setScope(item.id)}
                  />
                  <span class="scope-name">{item.label}</span>
                  <span class="scope-desc">{item.desc}</span>
                </label>
              )}
            </For>
          </div>
        </Field>
        <Field label="设备名" hint="给手机起个名字,便于在设备列表里辨认。">
          <TextInput value={deviceName()} onInput={setDeviceName} placeholder="我的手机" />
        </Field>
        <div class="pairing-actions">
          <button
            type="button"
            class="ghost-mini"
            disabled={creating() || lanBusy() || !lanActive()}
            onClick={() => void generate()}
          >
            <Show when={qrDataUrl() != null} fallback={<IconQrCode />}>
              <IconRefreshCw />
            </Show>
            {creating() ? "生成中…" : qrDataUrl() == null ? "生成配对二维码" : expired() ? "已过期,重新生成" : "重新生成"}
          </button>
          <Show when={qrDataUrl() != null && !expired()}>
            <span class="pairing-count">{remainingSec()}s 后过期</span>
          </Show>
          <Show when={!lanActive()}>
            <span class="pairing-count">需先开启局域网模式</span>
          </Show>
        </div>
        <Show when={error() != null}>
          <p class="field-hint is-error" style={{ "grid-column": "1 / -1" }}>{error()}</p>
        </Show>
        <Show when={qrDataUrl() != null}>
          <div class="pairing-qr" style={{ "grid-column": "1 / -1" }}>
            <img src={qrDataUrl()!} alt="配对二维码" width={220} height={220} />
            <div class="pairing-qr-note">
              <Show
                when={!expired()}
                fallback={<span class="pairing-expired">二维码已过期,请重新生成。</span>}
              >
                <span>
                  用移动端扫码绑定。令牌一次性,{remainingSec()}s 后过期;手机按指纹 pinning 直连
                  <b>{qrBaseUrl() ?? lan()!.lan_endpoint}</b>。
                </span>
              </Show>
            </div>
          </div>
        </Show>

        <div class="devices-block" style={{ "grid-column": "1 / -1" }}>
          <div class="devices-head">
            <span>已配对设备</span>
            <button type="button" class="ghost-mini" disabled={devicesLoading()} onClick={() => void loadDevices()}>
              <IconRefreshCw class={{ spin: devicesLoading() }} />
              刷新
            </button>
          </div>
          <Show
            when={devices() != null && devices()!.length > 0}
            fallback={<p class="field-hint">{devicesLoading() ? "加载中…" : "暂无已配对设备。"}</p>}
          >
            <table class="readonly-table devices-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>平台</th>
                  <th>档位</th>
                  <th>最近活跃</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <For each={devices()}>
                  {(device) => (
                    <tr>
                      <td>{device.name}</td>
                      <td>{device.platform}</td>
                      <td><span class={`scope-badge ${device.scope}`}>{device.scope}</span></td>
                      <td>{relativeTime(device.last_seen_ms)}</td>
                      <td class="devices-actions">
                        <Show
                          when={confirmRevoke() === device.device_id}
                          fallback={
                            <button type="button" class="ghost-mini is-danger button-danger" onClick={() => setConfirmRevoke(device.device_id)}>
                              吊销
                            </button>
                          }
                        >
                          <span class="devices-confirm">
                            确认吊销?
                            <button type="button" class="ghost-mini is-danger button-danger" onClick={() => void revoke(device.device_id)}>
                              确认
                            </button>
                            <button type="button" class="ghost-mini" onClick={() => setConfirmRevoke(null)}>
                              取消
                            </button>
                          </span>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </Show>
    </Section>
  );
};
