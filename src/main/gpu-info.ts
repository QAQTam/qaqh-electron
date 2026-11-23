/**
 * GPU 后端探针 —— 合并 `app.getGPUInfo("complete")` 与同步的 `app.getGPUFeatureStatus()`。
 *
 * Chromium 在硬件加速不可用(驱动缺失/llvmpipe/虚拟机/部分驱动黑名单)时会静默落到
 * SwiftShader 软件光栅。`getGPUInfo("complete")` 不含 featureStatus 字段,真正的
 * 合成/光栅/WebGL/硬件解码状态来自 `app.getGPUFeatureStatus()`。
 */

export interface GpuStatus {
  /** `gpu_compositing` 原值(enabled/unavailable_software/disabled_software/…)。 */
  compositing: string | null;
  rasterization: string | null;
  canvas2d: string | null;
  webgl: string | null;
  videoDecode: string | null;
  /** Chromium auxAttributes 直接自报的软渲染标志;读不到为 null。 */
  softwareRendering: boolean | null;
  /** 结论:是否软件渲染路径。读不出结论为 null(不算失败也不算通过)。 */
  software: boolean | null;
  vendor: string | null;
  renderer: string | null;
  driverVersion: string | null;
  source: string;
  error: string | null;
}

type RawGpuInfo = {
  featureStatus?: Record<string, unknown>;
  auxAttributes?: {
    softwareRendering?: unknown;
    glRenderer?: unknown;
    glVendor?: unknown;
  };
  gpuDevice?: Array<{
    active?: boolean;
    vendorId?: unknown;
    driverVendor?: unknown;
    driverRenderer?: unknown;
    driverVersion?: unknown;
  }>;
};

const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function isSoftwareStatus(status: string | null): boolean | null {
  if (!status) return null;
  const lower = status.toLowerCase();
  if (lower.includes("software") || lower.startsWith("disabled")) return true;
  if (lower.startsWith("enabled")) return false;
  return null;
}

export function readGpuStatus(raw: unknown, featureStatus?: Record<string, unknown> | null): GpuStatus {
  const info = (typeof raw === "object" && raw != null ? raw : {}) as RawGpuInfo;
  const features = featureStatus ?? info.featureStatus ?? {};
  const compositing = asString(features["gpu_compositing"]);
  const rasterization = asString(features["rasterization"]);
  const canvas2d = asString(features["2d_canvas"]);
  const webgl = asString(features["webgl"]);
  const videoDecode = asString(features["video_decode"]);

  const auxSoftware = info.auxAttributes?.softwareRendering;
  const softwareRendering = typeof auxSoftware === "boolean" ? auxSoftware : null;
  const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const active = devices.find((device) => device?.active === true) ?? devices[0];

  const software = softwareRendering ?? isSoftwareStatus(compositing);
  const vendor = asString(active?.driverVendor) ?? asString(info.auxAttributes?.glVendor);
  const renderer = asString(active?.driverRenderer) ?? asString(info.auxAttributes?.glRenderer);
  const driverVersion = asString(active?.driverVersion);

  return {
    compositing,
    rasterization,
    canvas2d,
    webgl,
    videoDecode,
    softwareRendering,
    software,
    vendor,
    renderer,
    driverVersion,
    source: "electron.app.getGPUFeatureStatus + getGPUInfo(complete)",
    error: null,
  };
}
