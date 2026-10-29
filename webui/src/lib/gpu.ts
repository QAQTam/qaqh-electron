/**
 * GPU 后端探针读面 —— 壳命令 `host_gpu_info` 的消费端(主进程实现见
 * `qaqh-electron/src/main/gpu-info.ts`)。
 *
 * 为什么 renderer 也要知道:软渲染(SwiftShader)下每帧都由 CPU 光栅,CSS 动画的
 * 取舍被软渲染开销淹没——「本机」面板要显示这个事实,auto 性能档要据此自动降档
 * (lib/visual.ts)。非桌面 runtime(纯浏览器)没有壳,恒 null。
 */
import { invoke, isDesktopRuntime } from "./host";

export interface GpuStatus {
  /** `featureStatus.gpu_compositing` 原值(enabled/software/disabled/…)。 */
  compositing: string | null;
  softwareRendering: boolean | null;
  /** 结论:是否软件渲染路径;null = 读不出结论(不是失败也不是通过)。 */
  software: boolean | null;
  vendor: string | null;
  renderer: string | null;
  source: string;
  error: string | null;
}

/** 壳未提供该命令(旧壳/纯浏览器)时返回 null,由面板显式缺。 */
export const loadGpuStatus = (): Promise<GpuStatus | null> =>
  isDesktopRuntime() ? invoke<GpuStatus | null>("host_gpu_info") : Promise.resolve(null);
