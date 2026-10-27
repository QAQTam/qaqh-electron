import { describe, expect, it } from "vitest";
import { hostOfEndpoint, isDaemonBusyError, lanAddressIssue } from "../src/lib/pairing";

describe("lanAddressIssue", () => {
  it("接受常规局域网网段", () => {
    for (const endpoint of [
      "https://192.168.1.23:64413",
      "https://10.8.0.11:64413",
      "https://172.16.0.5:64413",
      "https://172.31.255.255:64413",
      // CGNAT / Tailscale:同虚拟网的手机连得上。
      "https://100.64.5.9:64413",
    ]) {
      expect(lanAddressIssue(endpoint), endpoint).toBeNull();
    }
  });

  it("拦下代理/虚拟网卡段与回环(daemon 猜网卡的已知误判)", () => {
    const proxy = lanAddressIssue("https://198.18.0.1:64413");
    expect(proxy).toContain("198.18.0.1");
    expect(proxy).toContain("重新开启");
    expect(lanAddressIssue("https://127.0.0.1:64413")).toContain("回环");
    expect(lanAddressIssue("https://8.8.8.8:64413")).toContain("私有网段");
    expect(lanAddressIssue("https://169.254.9.9:64413")).toContain("链路本地");
    expect(lanAddressIssue("https://[::1]:64413")).toContain("回环");
  });

  it("端点缺失或坏格式也要给出可执行文案", () => {
    expect(lanAddressIssue(null)).toContain("缺失");
    // WHATWG URL 解析会拒绝非法定主机名(含越界 IPv4),壳侧只能报「拿不到端点」。
    expect(lanAddressIssue("not-a-url")).toContain("格式异常");
    expect(lanAddressIssue("https://192.168.1.999:64413")).not.toBeNull();
  });

  it("IPv6 全局地址不警告(同网手机可直连)", () => {
    expect(lanAddressIssue("https://[fd00::12]:64413")).toBeNull();
    expect(lanAddressIssue("https://[2001:db8::1]:64413")).toBeNull();
    expect(lanAddressIssue("https://[fe80::1]:64413")).toContain("链路本地");
  });
});

describe("hostOfEndpoint", () => {
  it("取主机名,IPv6 去括号", () => {
    expect(hostOfEndpoint("https://192.168.1.23:64413")).toBe("192.168.1.23");
    expect(hostOfEndpoint("https://[fd00::12]:64413")).toBe("fd00::12");
    expect(hostOfEndpoint(null)).toBeNull();
    expect(hostOfEndpoint("垃圾")).toBeNull();
  });
});

describe("isDaemonBusyError", () => {
  it("只认壳侧的 daemon_busy 错误码", () => {
    expect(isDaemonBusyError(new Error("daemon_busy"))).toBe(true);
    expect(isDaemonBusyError("daemon_busy")).toBe(true);
    expect(isDaemonBusyError(new Error("旧 daemon（pid 1）在 20s 内没有退出"))).toBe(false);
  });
});
