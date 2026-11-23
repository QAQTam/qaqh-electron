/**
 * 设备配对 section：分组左文右控布局（局域网模式 / 配对新设备 / 已配对设备）。
 */
import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js";
import IconQrCode from "~icons/lucide/qr-code";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SegmentedControl, type SegmentedOption } from "../ui/SegmentedControl";
import { SettingGroup, SettingRow } from "../ui/SettingGroup";
import { toast } from "../ui/toast";
import { isDesktopRuntime, desktopHostSurface, transport } from "../lib/transport";
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
import { Field, TextInput } from "./controls";

const SCOPE_OPTIONS: readonly SegmentedOption<PairingScope>[] = [
  { value: "view", label: "只读", title: "只读：查看会话与输出" },
  { value: "interact", label: "可交互", title: "可交互：发送消息、响应授权" },
  { value: "admin", label: "管理员", title: "管理员：含设备管理（慎选）" },
];

const SCOPE_DESC: Record<PairingScope, string> = {
  view: "仅可查看会话记录与实时输出",
  interact: "可发送消息并响应审批授权（推荐）",
  admin: "拥有完整控制与设备管理权限，请谨慎授予",
};

const DEFAULT_LAN_PORT = 64413;

const relativeTime = (ms: number): string => {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
};

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const shortFingerprint = (fp: string | null): string | null => {
  if (fp == null || fp === "") return null;
  const hex = fp.startsWith("sha256:") ? fp.slice(7) : fp;
  return `sha256:${hex.slice(0, 8)}…`;
};

export const PairingSection: Component = () => {
  const available = isDesktopRuntime();
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
  const [forceAction, setForceAction] = createSignal<"enable" | "disable">("enable");
  const [bindIp, setBindIp] = createSignal("");
  const [portDraft, setPortDraft] = createSignal(String(DEFAULT_LAN_PORT));

  const lanActive = (): boolean => lan()?.active === true;

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

  const dropQr = (): void => {
    setQrDataUrl(null);
    setQrBaseUrl(null);
    setExpiresAt(0);
  };

  const reattachStreams = (): void => {
    const host = desktopHostSurface(transport);
    if (host == null) return;
    void host.streamsRetry().catch(() => {});
  };

  const runLanRestart = async (action: "enable" | "disable", force: boolean): Promise<void> => {
    setLanBusy(true);
    setLanError(null);
    setLanConfirm(null);
    setLanNote(
      force
        ? "正在强制重启 daemon（进行中的任务会被中断）…"
        : action === "enable"
          ? "正在开启局域网模式并重启 daemon…"
          : "正在切回本机回环模式…",
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
    <div id="section-pairing" style={{ display: "flex", "flex-direction": "column", gap: "24px" }}>
      <Show
        when={available}
        fallback={
          <SettingGroup title="设备配对">
            <SettingRow label="当前环境不可用" desc="请在 Electron 桌面端内使用局域网配对功能。">
              <Badge>仅桌面端</Badge>
            </SettingRow>
          </SettingGroup>
        }
      >
        <SettingGroup
          title="局域网模式"
          desc="开启后以自签 TLS 监听局域网，便于手机扫码直连；切换期间会话会短暂中断。"
          aside={
            <Button size="sm" variant="ghost" disabled={lanBusy()} onClick={() => void loadLan()}>
              <IconRefreshCw class={{ "icon-spin": !lanBusy() && lan() == null }} />
              刷新
            </Button>
          }
        >
          <SettingRow
            label="局域网访问"
            desc={lanActive() ? "手机需与本机处于同一局域网内" : "当前仅监听本机回环地址，手机无法连接"}
          >
            <Show when={!lanBusy()} fallback={<Badge tone="warn">重启中…</Badge>}>
              <Badge tone={lanActive() ? "ok" : "warn"}>
                {lanActive() ? "已开启" : lan()?.running === true ? "未开启" : "未运行"}
              </Badge>
            </Show>
            <Show
              when={lanActive()}
              fallback={
                <Show when={lanConfirm() !== "enable" && lanConfirm() !== "force"}>
                  <Button size="sm" variant="primary" disabled={lanBusy()} onClick={() => setLanConfirm("enable")}>
                    开启局域网模式
                  </Button>
                </Show>
              }
            >
              <Button size="sm" variant="secondary" disabled={lanBusy()} onClick={() => setLanConfirm("disable")}>
                关闭
              </Button>
            </Show>
          </SettingRow>

          <Show when={lanActive()}>
            <SettingRow label="手机连接地址" desc={lanIssue() ?? undefined}>
              <span class="ui-setting-row-value is-mono">{lan()!.lan_endpoint}</span>
            </SettingRow>
            <SettingRow label="TLS 证书指纹">
              <span class="ui-setting-row-value is-mono" title={lan()!.tls_fingerprint ?? ""}>
                {fingerprint() ?? "未提供"}
              </span>
            </SettingRow>
          </Show>

          <Show when={lanConfirm() === "enable" || lanConfirm() === "force" || lanConfirm() === "disable"}>
            <div style={{ padding: "14px 16px", background: "var(--surface-hover)", display: "flex", "flex-direction": "column", gap: "12px" }}>
              <Show when={lanConfirm() === "enable"}>
                <div class="lan-form">
                  <Field label="绑定地址" hint="留空自动选择网卡；多网卡或代理环境建议手填局域网 IP。">
                    <TextInput value={bindIp()} onInput={setBindIp} placeholder="留空自动" />
                  </Field>
                  <Field label="端口" hint="默认 64413，被占用时可修改。" compact>
                    <TextInput value={portDraft()} onInput={setPortDraft} placeholder={String(DEFAULT_LAN_PORT)} />
                  </Field>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button size="sm" variant="primary" disabled={lanBusy()} onClick={() => void runLanRestart("enable", false)}>
                    确认开启并重启
                  </Button>
                  <Button size="sm" variant="ghost" disabled={lanBusy()} onClick={() => setLanConfirm(null)}>
                    取消
                  </Button>
                </div>
              </Show>

              <Show when={lanConfirm() === "force"}>
                <p class="field-hint is-warn" style={{ margin: 0 }}>
                  daemon 正在执行任务，强制重启会中断当前会话与审批。
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button size="sm" variant="danger" disabled={lanBusy()} onClick={() => void runLanRestart(forceAction(), true)}>
                    {forceAction() === "disable" ? "强制切回回环" : "强制开启局域网"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={lanBusy()} onClick={() => setLanConfirm(null)}>
                    取消
                  </Button>
                </div>
              </Show>

              <Show when={lanConfirm() === "disable"}>
                <p class="field-hint" style={{ margin: 0 }}>
                  关闭后将以回环模式重启 daemon，移动端将断开连接。
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button size="sm" variant="danger" disabled={lanBusy()} onClick={() => void runLanRestart("disable", false)}>
                    确认关闭
                  </Button>
                  <Button size="sm" variant="ghost" disabled={lanBusy()} onClick={() => setLanConfirm(null)}>
                    取消
                  </Button>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={lanNote() != null || lanError() != null}>
            <div style={{ padding: "10px 16px" }}>
              <Show when={lanNote() != null}><p class="field-hint" style={{ margin: 0 }}>{lanNote()}</p></Show>
              <Show when={lanError() != null}><p class="field-hint is-error" style={{ margin: 0 }}>{lanError()}</p></Show>
            </div>
          </Show>
        </SettingGroup>

        <SettingGroup title="配对新设备" desc="生成一次性配对二维码（120 秒有效），使用移动端扫码完成绑定。">
          <SettingRow label="授予权限档位" desc={SCOPE_DESC[scope()]}>
            <SegmentedControl
              aria-label="授予权限档位"
              options={SCOPE_OPTIONS}
              value={scope()}
              onChange={setScope}
            />
          </SettingRow>
          <SettingRow label="设备名称" desc="用于在已配对列表中区分不同移动设备">
            <div style={{ width: "200px" }}>
              <TextInput value={deviceName()} onInput={setDeviceName} placeholder="我的手机" />
            </div>
          </SettingRow>
          <SettingRow
            label="一次性配对二维码"
            desc={!lanActive() ? "请先在上方开启局域网模式" : qrDataUrl() != null && !expired() ? `剩余有效时间 ${remainingSec()} 秒` : "点击右侧按钮签发一次性令牌"}
          >
            <Button
              size="sm"
              variant="primary"
              disabled={creating() || lanBusy() || !lanActive()}
              onClick={() => void generate()}
            >
              <Show when={qrDataUrl() != null} fallback={<IconQrCode />}>
                <IconRefreshCw />
              </Show>
              {creating() ? "生成中…" : qrDataUrl() == null ? "生成二维码" : expired() ? "重新生成" : "刷新二维码"}
            </Button>
          </SettingRow>

          <Show when={error() != null}>
            <div style={{ padding: "10px 16px" }}>
              <p class="field-hint is-error" style={{ margin: 0 }}>{error()}</p>
            </div>
          </Show>

          <Show when={qrDataUrl() != null}>
            <div class="pairing-qr" style={{ margin: "12px 16px 16px" }}>
              <img src={qrDataUrl()!} alt="配对二维码" width={200} height={200} />
              <div class="pairing-qr-note">
                <Show
                  when={!expired()}
                  fallback={<span class="pairing-expired">二维码已过期，请点击上方重新生成。</span>}
                >
                  <span>
                    用移动端扫码绑定，{remainingSec()}s 后过期；直连地址 <b>{qrBaseUrl() ?? lan()!.lan_endpoint}</b>。
                  </span>
                </Show>
              </div>
            </div>
          </Show>
        </SettingGroup>

        <SettingGroup
          title="已配对设备"
          aside={
            <Button size="sm" variant="ghost" disabled={devicesLoading()} onClick={() => void loadDevices()}>
              <IconRefreshCw class={{ "icon-spin": devicesLoading() }} />
              刷新
            </Button>
          }
        >
          <Show
            when={devices() != null && devices()!.length > 0}
            fallback={
              <SettingRow label={devicesLoading() ? "正在加载设备列表…" : "暂无已配对设备"} desc="完成扫码绑定后，设备会显示在这里">
                <span />
              </SettingRow>
            }
          >
            <For each={devices()}>
              {(device) => (
                <SettingRow
                  label={device.name}
                  desc={`${device.platform} · 最近活跃 ${relativeTime(device.last_seen_ms)}`}
                >
                  <Badge tone={device.scope === "admin" ? "warn" : "accent"}>{device.scope}</Badge>
                  <Show
                    when={confirmRevoke() === device.device_id}
                    fallback={
                      <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(device.device_id)}>
                        吊销
                      </Button>
                    }
                  >
                    <Button size="sm" variant="danger" onClick={() => void revoke(device.device_id)}>
                      确认吊销
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                      取消
                    </Button>
                  </Show>
                </SettingRow>
              )}
            </For>
          </Show>
        </SettingGroup>
      </Show>
    </div>
  );
};
