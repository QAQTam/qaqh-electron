/** Local visual preferences. These values are intentionally separate from daemon config. */
import { createSignal } from "solid-js";
import { themePreset } from "./theme";

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

export function isLowSpecActive(): boolean {
  if (themePreset() === "lite") return true;
  const mode = performanceMode();
  if (mode === "low") return true;
  if (mode === "quality") return false;
  return detectLowSpecHardware();
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
}

export { sessionMaterial, performanceMode };
