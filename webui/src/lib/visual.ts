/** Local visual preferences. These values are intentionally separate from daemon config. */
import { createSignal } from "solid-js";
import { themePreset } from "./theme";
import { loadGpuStatus, type GpuStatus } from "./gpu";
import { desktopHost, type GpuPrefState } from "./desktop-host";

export type SessionMaterial = "glass" | "solid";
const STORAGE_KEY = "qaqh.visual.sessionMaterial";
const PERF_MODE_KEY = "qaqh.visual.perfMode";

/**
 * 性能模式档位：
 * - "auto": 根据硬件（CPU 核心数 <= 2、弱核显等）自动启用性能模式
 * - "low": 强制开启性能模式（彻底停用毛玻璃滤镜与持续动画，使用纯色实底）
 * - "quality": 保持完整视觉效果
 */
export type PerformanceMode = "auto" | "low" | "quality";

/** 检测当前硬件是否属于受限/低配硬件（如双核 CPU、弱核显） */
export function detectLowSpecHardware(): boolean {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency ?? 4;
  return cores <= 2;
}

function readMaterial(): SessionMaterial {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "solid" ? "solid" : "glass";
  } catch {
    return "glass";
  }
}

function readPerfMode(): PerformanceMode {
  try {
    const value = localStorage.getItem(PERF_MODE_KEY);
    if (value === "low" || value === "quality" || value === "auto") return value;
    return "auto";
  } catch {
    return "auto";
  }
}

const [sessionMaterial, setSessionMaterialSignal] = createSignal<SessionMaterial>(readMaterial());
const [performanceMode, setPerformanceModeSignal] = createSignal<PerformanceMode>(readPerfMode());

/**
 * GPU 后端事实(软渲染 = SwiftShader):壳探针异步回报,初始 null = 未知。
 * 软渲染时每帧都由 CPU 光栅,毛玻璃/动画的视觉开销被放大数倍——auto 档据此
 * 自动降档,不再只依赖 CPU 核数这一个信号。读不出结论(null)时不动档位。
 */
const [gpuSoftwareRendering, setGpuSoftwareRendering] = createSignal<boolean | null>(null);

/** 壳探针回报入口;错误与「读不出结论」都归一为 null,不猜。 */
export function noteGpuStatus(status: GpuStatus | null): void {
  const software = status != null && status.error == null ? status.software : null;
  setGpuSoftwareRendering(software);
  applyPerfMode();
  // auto 档的结论依赖探针:落定后把折算出的 GPU 偏好同步给壳(幂等)。
  syncShellGpuPref();
}

/** 桌面启动时探一次(GPU 后端在会话期内不会变);失败静默,档位保持现状。 */
export async function applyGpuPerfHint(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    noteGpuStatus(await loadGpuStatus());
  } catch {}
}

export function isLowSpecActive(): boolean {
  if (themePreset() === "lite") return true;
  const mode = performanceMode();
  if (mode === "low") return true;
  if (mode === "quality") return false;
  // auto:核数受限,或 GPU 已落到软件光栅(此时 CSS 动画由 CPU 承担)。
  return detectLowSpecHardware() || gpuSoftwareRendering() === true;
}

function applyMaterial(value: SessionMaterial): void {
  if (typeof document !== "undefined") document.documentElement.dataset.material = value;
}

export function applyPerfMode(): void {
  if (typeof document === "undefined") return;
  const low = isLowSpecActive();
  document.documentElement.dataset.perfMode = low ? "low" : "normal";
  document.documentElement.classList.toggle("perf-mode-low", low);
}

/** 壳回报的 GPU 偏好状态;null = 未同步过(非桌面/旧壳)。 */
const [gpuPrefState, setGpuPrefState] = createSignal<GpuPrefState | null>(null);

/**
 * 把当前档位折算的 GPU 偏好同步给壳(BUG-2026-10-29 抽屉动画实测后落地):
 * Performance/auto-低配 → 壳启动时追加 disable-3d-apis(省内存旧行为);
 * Quality → 不追加,GPU/合成走硬件。命令行开关启动前定格,推送只影响
 * **下次启动**;「本次启动 ≠ 下次启动」时由设置页提示重启。
 * 档位变化与 GPU 探针落定(auto 档的结论依赖探针)两条路都会调这里。
 */
export function syncShellGpuPref(): void {
  const host = desktopHost();
  if (host?.gpuPref == null) return;
  void host.gpuPref.set(isLowSpecActive())
    .then((state) => setGpuPrefState(state))
    .catch(() => {});
}

/** 读一次壳侧现状(设置页「本机」信息用);失败静默保持 null。 */
export async function refreshShellGpuPref(): Promise<void> {
  const host = desktopHost();
  if (host?.gpuPref == null) return;
  try { setGpuPrefState(await host.gpuPref.state()); } catch {}
}

/** 待重启标记:本次启动与下次启动的 GPU 禁用态不一致。 */
export const gpuRestartPending = () => {
  const state = gpuPrefState();
  return state != null && state.currentLaunchDisabled !== state.nextLaunchDisabled;
};

applyMaterial(sessionMaterial());
applyPerfMode();

if (typeof window !== "undefined") {
  window.addEventListener("qaqh:theme-preset", () => applyPerfMode());
}

export function setSessionMaterial(value: SessionMaterial): void {
  setSessionMaterialSignal(value);
  applyMaterial(value);
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {}
}

export function setPerformanceMode(value: PerformanceMode): void {
  setPerformanceModeSignal(value);
  applyPerfMode();
  try {
    localStorage.setItem(PERF_MODE_KEY, value);
  } catch {}
  // 档位折算的 GPU 偏好推给壳(下次启动生效;设置页提示待重启)。
  syncShellGpuPref();
}

export { sessionMaterial, performanceMode, gpuPrefState };
