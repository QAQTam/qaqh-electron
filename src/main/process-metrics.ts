const kinds: Record<string, string> = {
  Tab: "renderer", Utility: "utility", GPU: "gpu", Zygote: "other",
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
