const kinds: Record<string, string> = {
  Browser: "browser",
  Tab: "renderer",
  Utility: "utility",
  GPU: "gpu",
  // Linux 独有:zygote 与子进程共享 fork 出来的页,单独成 kind 让合计端能剔除
  // (计入会把 renderer 的私有页重复算一遍)。
  Zygote: "zygote",
  "Sandbox helper": "sandbox_helper",
  "Pepper Plugin": "ppapi_plugin",
  "Pepper Plugin Broker": "ppapi_broker",
  Unknown: "unknown",
};

const kibToBytes = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1024 : null;

const finiteNonNeg = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export interface MainProcessMetricSummary {
  resident_bytes: number | null;
  private_bytes: number | null;
  peak_resident_bytes: number | null;
  cpu_percent: number | null;
  idle_wakeups: number | null;
  creation_time: number | null;
}

/** Extract the Browser (main) process entry from app.getAppMetrics(). */
export function mainProcessMetrics(metrics: Electron.ProcessMetric[], mainPid: number): MainProcessMetricSummary | null {
  const metric = metrics.find((item) => item.pid === mainPid);
  if (!metric) return null;
  return {
    resident_bytes: kibToBytes(metric.memory?.workingSetSize),
    private_bytes: kibToBytes(metric.memory?.privateBytes),
    peak_resident_bytes: kibToBytes(metric.memory?.peakWorkingSetSize),
    cpu_percent: finiteNonNeg(metric.cpu?.percentCPUUsage),
    idle_wakeups: finiteNonNeg(metric.cpu?.idleWakeupsPerSecond),
    creation_time: finiteNonNeg(metric.creationTime),
  };
}

/** Electron reports memory in KiB. Exclude the main process, counted separately by host_memory. */
export function processGroup(metrics: Electron.ProcessMetric[], mainPid: number) {
  return {
    source: "electron.app.getAppMetrics",
    error: null,
    members: metrics.filter((metric) => metric.pid !== mainPid).map((metric) => ({
      pid: metric.pid,
      kind: kinds[metric.type] ?? "other",
      name: metric.serviceName || metric.name || null,
      resident_bytes: kibToBytes(metric.memory?.workingSetSize),
      private_bytes: kibToBytes(metric.memory?.privateBytes),
      peak_resident_bytes: kibToBytes(metric.memory?.peakWorkingSetSize),
      cpu_percent: finiteNonNeg(metric.cpu?.percentCPUUsage),
      idle_wakeups: finiteNonNeg(metric.cpu?.idleWakeupsPerSecond),
      creation_time: finiteNonNeg(metric.creationTime),
      sandboxed: typeof metric.sandboxed === "boolean" ? metric.sandboxed : null,
      error: kibToBytes(metric.memory?.workingSetSize) == null ? "memory unavailable" : null,
    })),
  };
}
