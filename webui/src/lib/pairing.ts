/**
 * 设备配对(daemon ringing v2)的壳命令封装:HTTP 与 admin token 都留在
 * Rust 侧,前端只拿 QR payload 字符串与设备列表(设备视图不含任何 token 材料)。
 * 非 Tauri 环境(浏览器 dev harness)不可用,调用方以 isTauriRuntime() 判定。
 *
 * 局域网模式:daemon 绑非回环地址后才会写 `lan_endpoint`(TLS 面)+ `tls_fingerprint`。
 * 手机必须连那个面;壳自己的管理请求走回环 `endpoint`,两条路互不干扰。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./transport/backend";

export type PairingScope = "view" | "interact" | "admin";

export interface PairingTicket {
  /** 规范 §11 的 JSON 字符串(含 base_url/pairing_token/tls_fp),直接喂给二维码编码器。 */
  qr_payload: string;
  expires_in_ms: number;
  /** 手机要访问的局域网端点(= discovery 的 lan_endpoint)。 */
  base_url: string;
}

export interface DeviceEntry {
  device_id: string;
  name: string;
  platform: string;
  scope: string;
  created_at_ms: number;
  last_seen_ms: number;
}

/** daemon 局域网面状态;字段与 `src-tauri/src/lan.rs` 的 lan_view 对齐。 */
export interface DaemonLanStatus {
  /** discovery 存在且 pid 存活。 */
  running: boolean;
  /** 有 lan_endpoint = 局域网模式已开(手机可连)。 */
  active: boolean;
  endpoint: string | null;
  lan_endpoint: string | null;
  tls_fingerprint: string | null;
  pid: number | null;
  daemon_version?: string | null;
  protocol_version?: number | null;
  app_protocol_version?: number | null;
}

export interface LanEnableOptions {
  /** 留空 = 0.0.0.0,由 daemon 自行选出口网卡。 */
  bindIp?: string;
  /** 省略或 0 = 壳侧默认端口(64413)。 */
  port?: number;
  /** 有 Turn 在跑时是否强行重启(仅在用户二次确认后传 true)。 */
  force?: boolean;
}

/** 壳侧停机请求被活动 Turn 挡住时返回的错误码(前端据此走确认面板)。 */
export const DAEMON_BUSY_ERROR = "daemon_busy";

export function isDaemonBusyError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.trim() === DAEMON_BUSY_ERROR;
}

export function pairingCreate(
  scopeGrant: PairingScope,
  deviceName: string,
  platform?: string,
): Promise<PairingTicket> {
  if (!isTauriRuntime()) return Promise.reject(new Error("设备配对仅在桌面壳内可用"));
  return invoke<PairingTicket>("pairing_create", {
    scopeGrant,
    deviceName,
    platform: platform ?? null,
  });
}

export function devicesList(): Promise<{ devices: DeviceEntry[] }> {
  if (!isTauriRuntime()) return Promise.reject(new Error("设备配对仅在桌面壳内可用"));
  return invoke<{ devices: DeviceEntry[] }>("devices_list");
}

export function deviceRevoke(deviceId: string): Promise<void> {
  if (!isTauriRuntime()) return Promise.reject(new Error("设备配对仅在桌面壳内可用"));
  return invoke<void>("device_revoke", { deviceId });
}

export function daemonLanStatus(): Promise<DaemonLanStatus> {
  if (!isTauriRuntime()) return Promise.reject(new Error("局域网模式仅在桌面壳内可用"));
  return invoke<DaemonLanStatus>("daemon_lan_status");
}

/**
 * 以局域网模式重启 daemon(停机 → `server --bind` 拉起 → 等新 discovery)。
 * 会短暂中断会话;Busy 时抛 `daemon_busy`,确认后带 `force` 重试。
 */
export function daemonLanEnable(options: LanEnableOptions = {}): Promise<DaemonLanStatus> {
  if (!isTauriRuntime()) return Promise.reject(new Error("局域网模式仅在桌面壳内可用"));
  return invoke<DaemonLanStatus>("daemon_lan_enable", {
    bindIp: options.bindIp?.trim() ? options.bindIp.trim() : null,
    port: options.port && options.port > 0 ? options.port : null,
    force: options.force === true,
  });
}

/** 关掉局域网面,回到默认的回环明文 daemon(同样要重启)。 */
export function daemonLanDisable(force = false): Promise<DaemonLanStatus> {
  if (!isTauriRuntime()) return Promise.reject(new Error("局域网模式仅在桌面壳内可用"));
  return invoke<DaemonLanStatus>("daemon_lan_disable", { force });
}

/** 从 `https://<host>:<port>` 取主机名(IPv6 去方括号);取不到返回 null。 */
export function hostOfEndpoint(endpoint: string | null): string | null {
  if (endpoint == null) return null;
  try {
    const host = new URL(endpoint).hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * 局域网端点是否真的可能被手机访问。
 *
 * daemon 绑 `0.0.0.0` 时用 UDP connect 猜出口网卡,机器上有虚拟网卡/代理 TUN 时
 * 会猜中(实测 198.18.0.1)——手机扫这种地址必然连不上。返回 null 表示无需警告。
 */
export function lanAddressIssue(endpoint: string | null): string | null {
  const host = hostOfEndpoint(endpoint);
  if (host == null) return "局域网端点缺失或格式异常,无法生成可扫描的地址。";
  if (host.includes(":")) {
    if (host === "::1") return "局域网端点是回环地址(::1),手机连不上,请填写本机局域网 IP。";
    if (host.startsWith("fe80")) return `局域网端点是链路本地地址(${host}),手机通常连不上,建议手填网卡 IP。`;
    return null;
  }
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return `局域网端点主机名无法解析(${host}),请手填绑定 IP 后重新开启。`;
  }
  const octets = parts.map(Number);
  for (const octet of octets) {
    if (octet > 255) return `局域网端点地址异常(${host}),请手填绑定 IP 后重新开启。`;
  }
  const [first = 0, second = 0] = octets;
  if (first === 127) return `局域网端点是回环地址(${host}),手机连不上,请填写本机局域网 IP。`;
  if (first === 10) return null;
  if (first === 192 && second === 168) return null;
  if (first === 172 && second >= 16 && second <= 31) return null;
  // CGNAT / Tailscale:同一虚拟网络里的设备确实能直连,不算问题。
  if (first === 100 && second >= 64 && second <= 127) return null;
  if (first === 169 && second === 254) {
    return `局域网端点是链路本地地址(${host}),通常是没选对网卡,建议手填局域网 IP。`;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return `daemon 猜出的地址 ${host} 属于代理/虚拟网卡段(不是家庭局域网),手机连不上。请填写本机局域网 IP(如 192.168.1.23)后重新开启。`;
  }
  return `${host} 不是局域网私有网段地址,手机大概率连不上。建议手填本机局域网 IP(如 192.168.1.23)后重新开启。`;
}
