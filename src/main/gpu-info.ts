/**
 * GPU 后端探针 —— 判断「动画都省了 CPU/GPU 还是没降」的关键测量。
 *
 * Chromium 在硬件加速不可用(驱动缺失/llvmpipe/虚拟机/部分 NVIDIA+Wayland 组合)
 * 时会**静默**落到 SwiftShader 软件光栅:每一帧都由 CPU 画,GPU 进程也在做软件合成。
 * 这种情况下主题级优化(关动画/去模糊)收效有限,因为瓶颈根本不在动画本身——
 * 必须先把「是不是软渲染」这个事实摆到桌面上。这里把 Chromium 自报的
 * featureStatus 汇成一个小结论,renderer 的「本机」面板与 auto 性能档都消费它。
 */

export interface GpuStatus {
  /** `featureStatus.gpu_compositing` 原值(enabled/software/disabled/…)。 */
  compositing: string | null;
  /** Chromium auxAttributes 直接自报的软渲染标志;读不到为 null。 */
  softwareRendering: boolean | null;
  /** 结论:是否软件渲染路径。读不出结论为 null(不算失败也不算通过)。 */
  software: boolean | null;
  vendor: string | null;
  renderer: string | null;
  source: string;
  error: string | null;
}

type RawGpuInfo = {
  featureStatus?: Record<string, unknown>;
  auxAttributes?: { softwareRendering?: unknown };
  gpuDevice?: Array<{
    active?: boolean;
    vendorId?: unknown;
    driverVendor?: unknown;
    driverRenderer?: unknown;
  }>;
};

const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function readGpuStatus(raw: unknown): GpuStatus {
  const info = (typeof raw === "object" && raw != null ? raw : {}) as RawGpuInfo;
  const compositing = asString(info.featureStatus?.["gpu_compositing"]);
  const auxSoftware = info.auxAttributes?.softwareRendering;
  const softwareRendering = typeof auxSoftware === "boolean" ? auxSoftware : null;
  const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const active = devices.find((device) => device?.active === true) ?? devices[0];

  // 软渲染的判定按优先级:Chromium 直接自报 > 合成器状态。合成器为 "software"
  // 是 SwiftShader 的明确标志;"disabled" 在本应用(没有任何用户面开关去禁合成)
  // 出现时同样意味着 GPU 通道不可用、落回软光栅。
  let software: boolean | null;
  if (softwareRendering != null) software = softwareRendering;
  else if (compositing === "software" || compositing === "disabled") software = true;
  else if (compositing === "enabled") software = false;
  else software = null;

  return {
    compositing,
    softwareRendering,
    software,
    vendor: asString(active?.driverVendor),
    renderer: asString(active?.driverRenderer),
    source: "electron.app.getGPUInfo(complete).featureStatus",
    error: null,
  };
}
