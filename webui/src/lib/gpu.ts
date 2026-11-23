/**
 * GPU 后端探针读面 —— 壳命令 `host_gpu_info` 的消费端(主进程实现见
 * `qaqh-electron/src/main/gpu-info.ts`)。
 */
import { invoke, isDesktopRuntime } from "./host";

export interface GpuStatus {
  /** `gpu_compositing` 原值(enabled/unavailable_software/disabled_software/…)。 */
  compositing: string | null;
  rasterization: string | null;
  canvas2d: string | null;
  webgl: string | null;
  videoDecode: string | null;
  softwareRendering: boolean | null;
  /** 结论:是否软件渲染路径;null = 读不出结论。 */
  software: boolean | null;
  vendor: string | null;
  renderer: string | null;
  driverVersion: string | null;
  source: string;
  error: string | null;
}

export const loadGpuStatus = (): Promise<GpuStatus | null> =>
  isDesktopRuntime() ? invoke<GpuStatus | null>("host_gpu_info") : Promise.resolve(null);
