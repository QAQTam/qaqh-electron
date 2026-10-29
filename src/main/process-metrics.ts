const kinds: Record<string, string> = {
  Browser: "browser", Tab: "renderer", Utility: "utility", GPU: "gpu",
  // Linux 独有:zygote 与子进程共享 fork 出来的页,单独成 kind 让合计端能剔除
  // (计入会把 renderer 的私有页重复算一遍)。
  Zygote: "zygote",
  "Sandbox helper": "sandbox_helper", "Pepper Plugin": "ppapi_plugin",
  "Pepper Plugin Broker": "ppapi_broker", Unknown: "unknown",
};

/** Electron reports memory in KiB. Exclude the main process, counted separately by host_memory. */
export function processGroup(metrics: Electron.ProcessMetric[], mainPid: number) {
  const bytes = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1024 : null;
  return {
    source: "electron.app.getAppMetrics",
    error: null,
    members: metrics.filter(metric => metric.pid !== mainPid).map(metric => ({
      pid: metric.pid,
      kind: kinds[metric.type] ?? "other",
      resident_bytes: bytes(metric.memory?.workingSetSize),
      private_bytes: bytes(metric.memory?.privateBytes),
      error: bytes(metric.memory?.workingSetSize) == null ? "memory unavailable" : null,
    })),
  };
}
